---
name: polar-apollo
description: Send tasks to Antigravity IDE via OpenClaw node.invoke or CLI. Use when you need Antigravity's capabilities (code editing, browser, multi-step agentic tasks).
---

# Polar Apollo — Antigravity Bridge

Delegate tasks to Antigravity IDE. Supports two modes:

1. **WebSocket Bridge** (preferred) — Antigravity registers as an OpenClaw node
2. **CLI / File IPC** (fallback) — for direct command-line usage

## Mode 1: OpenClaw Node (WebSocket)

When the Antigravity extension is connected to the Gateway, use `node.invoke`:

```bash
# From OpenClaw CLI
openclaw nodes invoke --node antigravity-node --command antigravity.send \
  --params '{"prompt": "Analyze the codebase and write results to /tmp/analysis.md", "outputPath": "/tmp/analysis.md"}'
```

The extension will:
1. Inject the prompt into Antigravity's chat
2. Wait for the output file to appear and stabilize
3. Return the result over WebSocket

### Parameters for `antigravity.send`

| Param | Type | Description |
|---|---|---|
| `prompt` | string (required) | The task to send |
| `outputPath` | string | Path where Antigravity should write output |
| `newSession` | boolean | Start a new chat session first |
| `timeoutSeconds` | number | Max wait time (default: 300) |

## Mode 2: CLI (fallback)

```bash
polar-apollo "Create a Python script at /tmp/hello.py"
polar-apollo --new "Start fresh and refactor the auth module"
polar-apollo --file /path/to/detailed-task.md
```

## Output Pattern

**Always tell Antigravity WHERE to write output.** Use absolute paths.

```bash
# Good — result can be read back
openclaw nodes invoke --node antigravity-node --command antigravity.send \
  --params '{"prompt": "Do X, write to /tmp/result.md", "outputPath": "/tmp/result.md"}'

# The response will include the output file content
```

## Requirements

- Antigravity IDE must be open and visible
- macOS (uses AppleScript for submit)
- OpenClaw Gateway running at `ws://127.0.0.1:18789`
- Polar Apollo extension installed in Antigravity
