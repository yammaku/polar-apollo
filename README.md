# Polar Apollo

**Chat bridge for AI agent orchestration** — lets external AI agents (like [OpenClaw](https://github.com/nicekid1/openclaw)) send tasks to [Antigravity IDE](https://antigravity.dev) programmatically.

```
OpenClaw (AI Agent)  →  polar-apollo CLI  →  Antigravity Chat  →  AI executes task
```

## The Problem

Antigravity is a powerful AI IDE (VS Code fork) with built-in browser, file editing, terminal, and multi-step agentic capabilities. But it has **no public API for sending prompts to its chat**. There's no `antigravity send-message "do X"` command, no REST endpoint, no IPC socket.

This means another AI agent running on the same machine (like OpenClaw) can't delegate tasks to Antigravity — even though Antigravity has tools the other agent doesn't.

Polar Apollo solves this by creating a bridge: a file-based trigger mechanism that injects prompts into Antigravity's chat input and submits them.

## How It Works

```
┌───────────────────┐     JSON file      ┌───────────────────────────────────────┐
│                   │  ───────────────►   │  Antigravity Extension (file watcher) │
│  CLI / OpenClaw   │                    │                                       │
│  writes to inbox  │                    │  1. openAgent (show chat panel)       │
│                   │                    │  2. toggleChatFocus (focus input)     │
└───────────────────┘                    │  3. clipboard paste (inject text)     │
                                         │  4. AppleScript Enter (submit)        │
         ~/.antigravity/                 └───────────────────────────────────────┘
         polar-apollo-inbox/
         request.json
```

### Step by Step

1. **CLI** (`polar-apollo`) writes a JSON file to `~/.antigravity/polar-apollo-inbox/request.json`:
   ```json
   {"prompt": "Your task here", "newSession": false}
   ```

2. **Extension** (running inside Antigravity) watches this directory with both `fs.watch` and VS Code's `FileSystemWatcher` for redundancy.

3. **On detection**, the extension:
   - Reads and immediately deletes the request file (prevent re-processing)
   - Saves the current clipboard contents
   - Calls `antigravity.openAgent` to ensure the chat panel is visible
   - Calls `antigravity.toggleChatFocus` to focus the chat input field
   - Writes the prompt to clipboard and executes `editor.action.clipboardPasteAction`
   - Runs AppleScript to activate the Antigravity window and simulate pressing Enter (`key code 36`)
   - Restores the original clipboard contents

4. **Antigravity** receives the prompt as if the user typed it, and begins processing.

## Architecture

```
polar-apollo/
├── extension/          # Antigravity extension (VS Code extension)
│   ├── extension.js    # File watcher + injection logic
│   └── package.json    # Extension manifest
├── cli/
│   └── polar-apollo    # Shell script CLI tool
├── skill/
│   └── SKILL.md        # OpenClaw skill definition
├── install.sh          # One-command installer
└── README.md
```

### Component 1: Extension (`extension/`)

A VS Code extension that runs inside Antigravity. Activated on startup (`onStartupFinished`). Key behaviors:

- **Dual file watching**: Uses both Node.js `fs.watch` (instant) and VS Code `FileSystemWatcher` (reliable) to catch all file creation events across different macOS scenarios.
- **Debounced processing**: Multiple filesystem events can fire for a single file write; a 300ms debounce prevents duplicate processing.
- **Startup delay**: Waits 3 seconds after activation before checking for pending requests, because Antigravity's chat UI needs time to fully initialize after a reload.
- **Processing lock**: Prevents concurrent injections with an `isProcessing` flag.
- **Clipboard preservation**: Saves and restores clipboard contents around each injection.

### Component 2: CLI (`cli/`)

A Bash script that:
- Accepts prompt text as argument or from a file (`--file`)
- Optionally requests a new session (`--new`)
- Uses Python 3 for reliable JSON encoding (handles special characters, Unicode, newlines)
- Writes to the inbox directory that the extension watches

### Component 3: OpenClaw Skill (`skill/`)

A SKILL.md file that teaches OpenClaw:
- When to delegate tasks to Antigravity (code editing, web browsing, file generation)
- How to call the CLI with proper arguments
- The output pattern: tell Antigravity to write results to a specific file path, then read that file
- Limitations and requirements

## Design Decisions & Rationale

### Why file-based IPC instead of HTTP/WebSocket/URI?

We evaluated several IPC mechanisms:

| Mechanism | Verdict | Why |
|---|---|---|
| **HTTP server** | ❌ Overkill | Requires port management, firewall config, adds complexity |
| **URI handler** (`antigravity://`) | ❌ Didn't work | VS Code URI handlers need publisher IDs; extension without publisher couldn't receive URIs |
| **Unix socket** | ❌ Complex | More code, harder to debug, same-machine only anyway |
| **File watcher** | ✅ Chosen | Zero config, works immediately, easy to debug (just write a file), OpenClaw can do it natively |

### Why AppleScript for submit instead of VS Code commands?

Antigravity's chat input is a **webview** (embedded Chromium). VS Code's `type` command inserts text into editors, not webviews. We tried every available command:

| Command | Result |
|---|---|
| `workbench.action.chat.submit` | ❌ Not found (Antigravity doesn't expose it) |
| `type { text: '\n' }` | ❌ Inserts newline, doesn't submit |
| `type { text: '\r' }` | ❌ Same |
| `default:enter` | ❌ Not found |
| `acceptSelectedSuggestion` | ❌ No effect in chat |
| AppleScript `key code 36` | ✅ Works — OS-level Enter key |

AppleScript simulates the Enter key at the macOS level, which reaches the webview's keyboard event handler just like a real keypress. It requires:
- Antigravity to be the active window (we `activate` it first)
- macOS Accessibility permissions for System Events
- The display session to be active (no lock screen)

### Why clipboard paste instead of direct text injection?

Antigravity's internal commands use protobuf-encoded structures. We reverse-engineered the relevant schemas:

- `sendTextToChat(content, label, resetId)` — expects a `TextBlock` protobuf, not a plain string
- `executeCascadeAction(items, source)` — expects `TextOrScopeItem` protobuf array
- `sendChatActionMessage(json)` — works for panel actions (`openChatPanel`, `toggleFocus`) but not text input

Constructing these protobuf objects externally is fragile and would break on any Antigravity update. Clipboard paste is:
- Version-independent (works regardless of internal API changes)
- Simple (just `clipboard.writeText` + `clipboardPasteAction`)
- Reliable (standard VS Code command that works across all input types)

## Requirements

- **macOS** (AppleScript is macOS-only)
- **Antigravity IDE** running and visible (not minimized, not behind lock screen)
- **Python 3** (used in CLI for JSON encoding)
- **Accessibility permissions**: System Settings → Privacy & Security → Accessibility → Enable Antigravity

### Headless Mac Setup

If running on a headless Mac (e.g., Mac Mini server):

1. **Disable screen lock**: System Settings → Lock Screen → "Require password after screen saver begins" → **Never**
2. **Disable screen saver**: Set to **Never** (or very long timeout)
3. **Prevent sleep**: Already set via "Turn display off when inactive" → **Never**
4. Optional: Enable macOS Screen Sharing (maintains virtual display session)

## Install

```bash
git clone https://github.com/yammaku/polar-apollo.git
cd polar-apollo
bash install.sh
```

Then reload Antigravity: `Cmd+Shift+P` → `Reload Window`

## Usage

```bash
# Send a task to current session
polar-apollo "Help me refactor the auth module"

# Open a new session first
polar-apollo --new "Research WebSocket best practices"

# Long prompt from file
polar-apollo --file ./my-detailed-task.md

# Combined
polar-apollo --new --file ./task.md
```

### AI-to-AI Pattern

The key pattern for AI orchestration: tell Antigravity **where to write output**, then read that file.

```bash
# OpenClaw sends task with explicit output path
polar-apollo "Analyze the codebase and write a summary to $(pwd)/outputs/analysis.md"

# OpenClaw waits for and reads the result
while [ ! -f ./outputs/analysis.md ]; do sleep 2; done
cat ./outputs/analysis.md
```

## Future Development Ideas

- **Response capture**: Monitor Antigravity's output channel or conversation logs to programmatically read AI responses
- **Queue system**: Support multiple pending requests with priority ordering
- **Status feedback**: Write a status file (processing/done/error) that the CLI can poll
- **Linux support**: Replace AppleScript with `xdotool` for Linux headless servers
- **Cross-machine**: Add SSH tunneling or shared filesystem support for multi-machine orchestration

## License

MIT
