# Polar Apollo

**Chat bridge for AI agent orchestration** — lets external AI agents (like OpenClaw) send tasks to Antigravity's chat programmatically.

## What It Does

```
OpenClaw / Terminal  →  polar-apollo CLI  →  Antigravity Chat  →  AI executes task
```

Polar Apollo bridges the gap between command-line AI agents and Antigravity's IDE-integrated AI. It's a one-way input bridge — like an automated keyboard for the chat.

## Install

```bash
bash install.sh
```

This installs:
1. **Antigravity Extension** — watches for incoming tasks and injects them into chat
2. **CLI Tool** (`polar-apollo`) — command-line interface for sending tasks
3. **OpenClaw Skill** — teaches OpenClaw how to delegate tasks to Antigravity

After installing:
1. Reload Antigravity (`Cmd+Shift+P` → `Reload Window`)
2. Grant Accessibility permission when prompted (System Settings → Privacy & Security → Accessibility → Antigravity)

## Usage

```bash
polar-apollo "Help me write a Python web scraper"
polar-apollo --new "Start a completely new task"
polar-apollo --file /path/to/long-prompt.md
```

## How It Works

1. CLI writes `{"prompt": "...", "newSession": false}` to `~/.antigravity/polar-apollo-inbox/request.json`
2. Extension detects file change → opens chat → pastes prompt → simulates Enter key
3. AppleScript handles keyboard simulation (requires Accessibility permission)

## Requirements

- macOS
- Antigravity IDE (running and visible)
- Python 3 (for JSON encoding in CLI)
