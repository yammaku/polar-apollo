---
name: polar-apollo
description: Send tasks to Antigravity IDE chat programmatically. Use this skill when you need to delegate tasks to Antigravity — such as codebase editing, file generation, web browsing, or any task that benefits from Antigravity's IDE-integrated AI capabilities.
---

# Polar Apollo

Send tasks to the Antigravity IDE chat from the command line. Antigravity is a VS Code-based AI IDE running on the same machine. This skill allows you to programmatically delegate tasks to Antigravity's chat, effectively sending work to another AI agent.

## When to Use

Use this skill when you need Antigravity to:
- **Edit code** in a specific project/workspace
- **Browse the web** or research topics using its built-in browser
- **Generate files** (images, documents, code) using its tools
- **Run multi-step agentic workflows** that benefit from IDE context
- **Any task** where Antigravity's IDE-integrated tools provide an advantage

## CLI Usage

```bash
# Send a task to current Antigravity session
polar-apollo "Your prompt here"

# Open a new session first
polar-apollo --new "Start a new task"

# Long prompt from file
polar-apollo --file /path/to/prompt.md

# Combined: new session + file
polar-apollo --new --file /path/to/prompt.md
```

## Important Patterns

### 1. Specify Output Location
Always tell Antigravity WHERE to write its output using an **absolute path** in the current project's `outputs/` folder. This avoids ambiguity — never use relative paths or `/tmp/`.

```bash
# Use the project's outputs folder with an absolute path
polar-apollo "Research the top 5 AI frameworks and write a comparison to $(pwd)/outputs/ai-frameworks-comparison.md"
```

Then read the output:
```bash
cat ./outputs/ai-frameworks-comparison.md
```

> **IMPORTANT**: Always use absolute paths like `$(pwd)/outputs/filename.md` when telling Antigravity where to write. Relative paths like `./outputs/` or vague paths like `/tmp/` may cause Antigravity to write to unexpected locations.

### 2. Use New Sessions for Unrelated Tasks
```bash
polar-apollo --new "This is a completely different topic"
```

### 3. Long Prompts via File
For prompts longer than a few paragraphs, write to a file first:

```bash
cat > ./outputs/task.txt << 'EOF'
Your very long and detailed prompt goes here.
It can span multiple lines and paragraphs.
EOF

polar-apollo --file ./outputs/task.txt
```

### 4. Wait for Completion
Antigravity processes asynchronously. If you need the output, poll for the result file:

```bash
OUTPUT="$(pwd)/outputs/result.md"
polar-apollo "Generate a summary and save to $OUTPUT"

# Wait for output
while [ ! -f "$OUTPUT" ]; do sleep 2; done
cat "$OUTPUT"
```

## Limitations

- Antigravity must be running and visible on screen
- Only one task can be submitted at a time
- No direct way to read Antigravity's chat response — use file output instead
- macOS only (uses AppleScript for keyboard simulation)
- First run after Antigravity reload needs ~3 seconds warm-up

## Prerequisites

- Antigravity IDE must be running
- The Polar Apollo extension must be installed in Antigravity
- `polar-apollo` CLI must be in PATH (`~/.local/bin/`)
- macOS Accessibility permissions must be granted for System Events
