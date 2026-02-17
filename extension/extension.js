const vscode = require('vscode');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SimpleWebSocket } = require('./ws-client');

/**
 * Polar Apollo v2 — WebSocket Bridge for OpenClaw ↔ Antigravity
 * 
 * Registers as an OpenClaw "node" via Gateway WebSocket, exposing
 * `antigravity.send` as an invokable command.
 * 
 * Dual-mode:
 *   1. WebSocket: OpenClaw Gateway → node.invoke → inject chat → respond
 *   2. File IPC:  CLI writes request.json → inject chat (legacy fallback)
 */

const INBOX_DIR = path.join(process.env.HOME || '', '.antigravity', 'polar-apollo-inbox');
const REQUEST_FILE = path.join(INBOX_DIR, 'request.json');
const STATUS_FILE = path.join(INBOX_DIR, 'status.json');
const CONFIG_FILE = path.join(process.env.HOME || '', '.openclaw', 'openclaw.json');

// Gateway defaults
const DEFAULT_GW_HOST = '127.0.0.1';
const DEFAULT_GW_PORT = 18789;

let log;
let isProcessing = false;
let processTimer = null;
let gatewaySocket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let deviceId = null;
let pendingInvokes = new Map(); // invocation id → {resolve, reject, outputPath}

function activate(context) {
    log = vscode.window.createOutputChannel('Polar Apollo');
    log.appendLine('[Polar Apollo v2] Activated — WebSocket Bridge');

    // Stable device ID (persisted)
    deviceId = getOrCreateDeviceId();

    // Ensure inbox directory exists
    if (!fs.existsSync(INBOX_DIR)) {
        fs.mkdirSync(INBOX_DIR, { recursive: true });
    }

    // === MODE 1: WebSocket Bridge ===
    connectToGateway();

    // === MODE 2: File IPC (fallback) ===
    const watcher = fs.watch(INBOX_DIR, (eventType, filename) => {
        if (filename === 'request.json') {
            log.appendLine(`[File IPC] Event: ${eventType}`);
            scheduleProcess();
        }
    });

    const vsWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(INBOX_DIR, 'request.json')
    );
    vsWatcher.onDidCreate(() => scheduleProcess());
    vsWatcher.onDidChange(() => scheduleProcess());

    // === Commands ===
    const sendPrompt = vscode.commands.registerCommand('polarApollo.sendPrompt', async () => {
        const prompt = await vscode.window.showInputBox({
            prompt: 'Enter the prompt to send to chat',
            placeHolder: 'e.g. Help me write a Python script'
        });
        if (!prompt) return;
        await injectPrompt(prompt, false);
    });

    const statusCmd = vscode.commands.registerCommand('polarApollo.status', () => {
        log.show();
        log.appendLine(`=== Polar Apollo Status ===`);
        log.appendLine(`Inbox: ${INBOX_DIR}`);
        log.appendLine(`Gateway: ${gatewaySocket?.connected ? '🟢 Connected' : '🔴 Disconnected'}`);
        log.appendLine(`Processing: ${isProcessing}`);
        log.appendLine(`Pending invokes: ${pendingInvokes.size}`);
    });

    const reconnectCmd = vscode.commands.registerCommand('polarApollo.reconnect', () => {
        log.appendLine('[Gateway] Manual reconnect requested');
        connectToGateway();
    });

    context.subscriptions.push(sendPrompt, statusCmd, reconnectCmd, vsWatcher);
    context.subscriptions.push({ dispose: () => watcher.close() });
    context.subscriptions.push({ dispose: () => disconnectGateway() });

    log.appendLine(`[Polar Apollo v2] File IPC: ${INBOX_DIR}`);
    log.appendLine(`[Polar Apollo v2] Gateway: ws://${DEFAULT_GW_HOST}:${DEFAULT_GW_PORT}`);

    // Delayed startup check for pending file requests
    setTimeout(() => {
        if (fs.existsSync(REQUEST_FILE)) {
            log.appendLine('[File IPC] Found pending request on startup');
            scheduleProcess();
        }
    }, 3000);
}


// ============================================================
//  GATEWAY WEBSOCKET CONNECTION
// ============================================================

function connectToGateway() {
    // Don't reconnect if already connected
    if (gatewaySocket?.connected) return;

    // Read gateway token from config if available
    const token = getGatewayToken();
    const host = DEFAULT_GW_HOST;
    const port = DEFAULT_GW_PORT;

    log.appendLine(`[Gateway] Connecting to ws://${host}:${port}...`);

    try {
        gatewaySocket = new SimpleWebSocket(`ws://${host}:${port}`);
    } catch (e) {
        log.appendLine(`[Gateway] Failed to create socket: ${e.message}`);
        scheduleReconnect();
        return;
    }

    gatewaySocket.on('open', () => {
        log.appendLine('[Gateway] WebSocket connected, sending handshake...');
        reconnectAttempts = 0;
        // We wait for the connect.challenge event before sending connect
    });

    gatewaySocket.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            handleGatewayMessage(msg);
        } catch (e) {
            log.appendLine(`[Gateway] Parse error: ${e.message}`);
        }
    });

    gatewaySocket.on('error', (err) => {
        log.appendLine(`[Gateway] Error: ${err.message}`);
    });

    gatewaySocket.on('close', () => {
        log.appendLine('[Gateway] Connection closed');
        gatewaySocket = null;
        scheduleReconnect();
    });

    gatewaySocket.connect();
}

function handleGatewayMessage(msg) {
    if (msg.type === 'event') {
        handleGatewayEvent(msg);
    } else if (msg.type === 'res') {
        handleGatewayResponse(msg);
    } else if (msg.type === 'req') {
        // Gateway is invoking a command on us (the node)
        handleGatewayRequest(msg);
    }
}

function handleGatewayEvent(msg) {
    const event = msg.event;

    if (event === 'connect.challenge') {
        // Gateway sends challenge on connection — respond with connect
        log.appendLine('[Gateway] Received challenge, sending connect...');
        sendConnect(msg.payload);
    } else if (event === 'heartbeat' || event === 'tick') {
        // Keepalive — ignore silently
    } else {
        log.appendLine(`[Gateway] Event: ${event}`);
    }
}

function handleGatewayResponse(msg) {
    if (msg.payload?.type === 'hello-ok') {
        log.appendLine(`[Gateway] ✅ Connected as node! Protocol v${msg.payload.protocol}`);
        if (msg.payload.auth?.deviceToken) {
            log.appendLine('[Gateway] Received device token (auto-paired)');
        }
        vscode.window.showInformationMessage('Polar Apollo: Connected to OpenClaw Gateway');
    } else if (!msg.ok) {
        log.appendLine(`[Gateway] ❌ Response error: ${JSON.stringify(msg.error || msg.payload)}`);
    }
}

async function handleGatewayRequest(msg) {
    // This is where OpenClaw invokes commands on us
    const { id, method, params } = msg;

    if (method === 'node.invoke') {
        const command = params?.command;
        const args = params?.args || params?.params || {};

        log.appendLine(`[Gateway] 📥 node.invoke: ${command}`);

        if (command === 'antigravity.send') {
            await handleAntigravitySend(id, args);
        } else {
            sendResponse(id, false, { error: `Unknown command: ${command}` });
        }
    } else {
        log.appendLine(`[Gateway] Unknown request method: ${method}`);
        sendResponse(id, false, { error: `Unknown method: ${method}` });
    }
}

async function handleAntigravitySend(invokeId, args) {
    const prompt = args.prompt || args.message || '';
    const newSession = args.newSession === true;
    const outputPath = args.outputPath || null;
    const timeoutMs = (args.timeoutSeconds || 300) * 1000;

    if (!prompt) {
        sendResponse(invokeId, false, { error: 'No prompt provided' });
        return;
    }

    log.appendLine(`[Gateway] Task: "${prompt.substring(0, 80)}${prompt.length > 80 ? '...' : ''}"`);
    if (outputPath) log.appendLine(`[Gateway] Output expected at: ${outputPath}`);

    try {
        // Inject the prompt
        await injectPrompt(prompt, newSession);

        // If outputPath provided, wait for the file to appear
        if (outputPath) {
            log.appendLine(`[Gateway] ⏳ Waiting for output file: ${outputPath}`);
            const startTime = Date.now();

            await waitForFile(outputPath, timeoutMs);

            const elapsed = Date.now() - startTime;
            log.appendLine(`[Gateway] ✅ Output ready (${(elapsed / 1000).toFixed(1)}s)`);

            // Read the output and return it
            let outputContent = '';
            try {
                outputContent = fs.readFileSync(outputPath, 'utf-8');
            } catch (e) {
                log.appendLine(`[Gateway] ⚠️ Could not read output: ${e.message}`);
            }

            sendResponse(invokeId, true, {
                status: 'done',
                outputPath,
                durationMs: elapsed,
                output: outputContent.substring(0, 10000) // Cap at 10KB
            });
        } else {
            // No output path — wait for idle (simple timer-based)
            log.appendLine('[Gateway] ⏳ No outputPath, waiting for idle...');
            await waitForIdle(timeoutMs);

            sendResponse(invokeId, true, {
                status: 'done',
                message: 'Prompt injected and Antigravity appears idle'
            });
        }
    } catch (e) {
        log.appendLine(`[Gateway] ❌ Task failed: ${e.message}`);
        sendResponse(invokeId, false, {
            status: 'error',
            error: e.message
        });
    }
}

function sendConnect(challenge) {
    const token = getGatewayToken();
    const connectFrame = {
        type: 'req',
        id: `pa-connect-${Date.now()}`,
        method: 'connect',
        params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
                id: 'antigravity-node',
                version: '0.2.0',
                platform: 'macos',
                mode: 'node'
            },
            role: 'node',
            scopes: [],
            caps: ['antigravity'],
            commands: ['antigravity.send'],
            permissions: {
                'antigravity.send': true
            },
            auth: token ? { token } : {},
            locale: 'en-US',
            userAgent: 'polar-apollo/0.2.0',
            device: {
                id: deviceId,
                ...(challenge?.nonce ? {
                    nonce: challenge.nonce,
                    signedAt: Date.now()
                } : {})
            }
        }
    };

    gatewaySend(connectFrame);
}

function sendResponse(id, ok, payload) {
    gatewaySend({
        type: 'res',
        id,
        ok,
        payload
    });
}

function gatewaySend(obj) {
    if (!gatewaySocket?.connected) {
        log.appendLine('[Gateway] Cannot send — not connected');
        return;
    }
    try {
        gatewaySocket.send(JSON.stringify(obj));
    } catch (e) {
        log.appendLine(`[Gateway] Send error: ${e.message}`);
    }
}

function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectAttempts++;
    // Exponential backoff: 2s, 4s, 8s, 16s, 30s max
    const delay = Math.min(2000 * Math.pow(2, reconnectAttempts - 1), 30000);
    log.appendLine(`[Gateway] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})...`);
    reconnectTimer = setTimeout(() => connectToGateway(), delay);
}

function disconnectGateway() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (gatewaySocket) {
        gatewaySocket.close();
        gatewaySocket = null;
    }
}


// ============================================================
//  COMPLETION DETECTION
// ============================================================

/**
 * Wait for a file to appear and stabilize (no writes for 3s).
 */
function waitForFile(filePath, timeoutMs) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const dir = path.dirname(filePath);
        const basename = path.basename(filePath);

        // First, wait for the file to exist
        const checkExistence = setInterval(() => {
            if (Date.now() - startTime > timeoutMs) {
                clearInterval(checkExistence);
                reject(new Error(`Timeout: ${filePath} not created within ${timeoutMs / 1000}s`));
                return;
            }
            if (fs.existsSync(filePath)) {
                clearInterval(checkExistence);
                waitForStable(filePath, timeoutMs - (Date.now() - startTime))
                    .then(resolve)
                    .catch(reject);
            }
        }, 1000);
    });
}

/**
 * Wait for a file to stabilize (no size change for 3s).
 */
function waitForStable(filePath, timeoutMs) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        let lastSize = -1;
        let stableCount = 0;
        const STABLE_CHECKS = 3; // 3 checks × 1s = 3s stable

        const interval = setInterval(() => {
            if (Date.now() - startTime > timeoutMs) {
                clearInterval(interval);
                reject(new Error('Timeout waiting for file stabilization'));
                return;
            }

            try {
                const stat = fs.statSync(filePath);
                if (stat.size === lastSize && stat.size > 0) {
                    stableCount++;
                    if (stableCount >= STABLE_CHECKS) {
                        clearInterval(interval);
                        resolve();
                    }
                } else {
                    lastSize = stat.size;
                    stableCount = 0;
                }
            } catch (e) {
                // File might have been deleted and recreated
                stableCount = 0;
            }
        }, 1000);
    });
}

/**
 * Wait for workspace idle (no file changes for 8s).
 */
function waitForIdle(timeoutMs) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        let lastActivityTime = Date.now();
        const IDLE_THRESHOLD = 8000;
        const MIN_WAIT = 5000;

        const disposables = [];

        disposables.push(vscode.workspace.onDidSaveTextDocument(() => {
            lastActivityTime = Date.now();
        }));
        disposables.push(vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.contentChanges.length > 0) lastActivityTime = Date.now();
        }));

        const interval = setInterval(() => {
            const elapsed = Date.now() - startTime;
            const idleTime = Date.now() - lastActivityTime;

            if (elapsed > timeoutMs) {
                cleanup();
                resolve();
                return;
            }
            if (elapsed > MIN_WAIT && idleTime >= IDLE_THRESHOLD) {
                cleanup();
                resolve();
            }
        }, 1000);

        function cleanup() {
            clearInterval(interval);
            disposables.forEach(d => d.dispose());
        }
    });
}


// ============================================================
//  FILE IPC (legacy fallback)
// ============================================================

function scheduleProcess() {
    if (processTimer) clearTimeout(processTimer);
    processTimer = setTimeout(() => processRequestFile(), 300);
}

async function processRequestFile() {
    if (isProcessing) {
        setTimeout(() => processRequestFile(), 2000);
        return;
    }

    try {
        if (!fs.existsSync(REQUEST_FILE)) return;

        const content = fs.readFileSync(REQUEST_FILE, 'utf-8').trim();
        if (!content) return;

        try { fs.unlinkSync(REQUEST_FILE); } catch (e) { /* ignore */ }

        const request = JSON.parse(content);
        const prompt = request.prompt || '';
        const newSession = request.newSession === true;

        if (!prompt) return;

        log.appendLine(`[File IPC] "${prompt.substring(0, 80)}${prompt.length > 80 ? '...' : ''}" (new: ${newSession})`);
        await injectPrompt(prompt, newSession);
    } catch (e) {
        log.appendLine(`[File IPC] Error: ${e.message}`);
        isProcessing = false;
    }
}


// ============================================================
//  PROMPT INJECTION (shared by both modes)
// ============================================================

async function injectPrompt(prompt, newSession) {
    isProcessing = true;

    try {
        const oldClipboard = await vscode.env.clipboard.readText();

        if (newSession) {
            log.appendLine('  → New session...');
            await vscode.commands.executeCommand('antigravity.startNewConversation');
            await sleep(1000);
        }

        log.appendLine('  → Focusing chat...');
        await vscode.commands.executeCommand('antigravity.openAgent');
        await sleep(500);
        await vscode.commands.executeCommand('antigravity.toggleChatFocus');
        await sleep(500);

        log.appendLine('  → Pasting...');
        await vscode.env.clipboard.writeText(prompt);
        await sleep(200);
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
        await sleep(500);

        log.appendLine('  → Submitting...');
        await simulateEnterKey();

        await sleep(300);
        await vscode.env.clipboard.writeText(oldClipboard);

        log.appendLine('  ✅ Sent!');
    } catch (e) {
        log.appendLine(`  ❌ ${e.message}`);
        throw e; // Re-throw for Gateway handler
    } finally {
        isProcessing = false;
    }
}

function simulateEnterKey() {
    return new Promise((resolve, reject) => {
        exec(
            'osascript -e \'tell application "Antigravity" to activate\' -e \'delay 0.5\' -e \'tell application "System Events" to key code 36\'',
            { timeout: 10000 },
            (error) => {
                if (error) reject(new Error(`AppleScript: ${error.message}`));
                else resolve();
            }
        );
    });
}


// ============================================================
//  UTILITY
// ============================================================

function getGatewayToken() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
            return config?.gateway?.auth?.token || process.env.OPENCLAW_GATEWAY_TOKEN || null;
        }
    } catch (e) { /* ignore */ }
    return process.env.OPENCLAW_GATEWAY_TOKEN || null;
}

function getOrCreateDeviceId() {
    const idFile = path.join(INBOX_DIR, '.device-id');
    try {
        if (fs.existsSync(idFile)) {
            return fs.readFileSync(idFile, 'utf-8').trim();
        }
    } catch (e) { /* ignore */ }

    const id = `pa-${crypto.randomBytes(8).toString('hex')}`;
    try {
        if (!fs.existsSync(INBOX_DIR)) fs.mkdirSync(INBOX_DIR, { recursive: true });
        fs.writeFileSync(idFile, id);
    } catch (e) { /* ignore */ }
    return id;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function deactivate() {
    disconnectGateway();
}

module.exports = { activate, deactivate };
