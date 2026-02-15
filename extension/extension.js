const vscode = require('vscode');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Polar Apollo — Chat Bridge for AI Agent Orchestration
 * 
 * Enables external AI agents (like OpenClaw) to send tasks to Antigravity
 * by watching a file-based inbox for incoming requests.
 * 
 * Flow: CLI writes JSON → file watcher detects → paste into chat → submit
 */

const INBOX_DIR = path.join(process.env.HOME || '', '.antigravity', 'polar-apollo-inbox');
const REQUEST_FILE = path.join(INBOX_DIR, 'request.json');
let log;
let isProcessing = false;
let processTimer = null;

function activate(context) {
    log = vscode.window.createOutputChannel('Polar Apollo');
    log.appendLine('[Polar Apollo] Activated');

    // Ensure inbox directory exists
    if (!fs.existsSync(INBOX_DIR)) {
        fs.mkdirSync(INBOX_DIR, { recursive: true });
    }

    // --- File Watcher: watch for request.json ---
    const watcher = fs.watch(INBOX_DIR, (eventType, filename) => {
        if (filename === 'request.json') {
            log.appendLine(`[Watch] Event: ${eventType}`);
            scheduleProcess();
        }
    });

    // VS Code file watcher as backup
    const vsWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(INBOX_DIR, 'request.json')
    );
    vsWatcher.onDidCreate(() => scheduleProcess());
    vsWatcher.onDidChange(() => scheduleProcess());

    // --- Commands ---
    const sendPrompt = vscode.commands.registerCommand('polarApollo.sendPrompt', async () => {
        const prompt = await vscode.window.showInputBox({
            prompt: 'Enter the prompt to send to chat',
            placeHolder: 'e.g. Help me write a Python script'
        });
        if (!prompt) return;
        await injectPrompt(prompt, false);
    });

    const status = vscode.commands.registerCommand('polarApollo.status', () => {
        log.show();
        log.appendLine(`=== Polar Apollo Status ===`);
        log.appendLine(`Inbox: ${INBOX_DIR}`);
        log.appendLine(`Watching: ${REQUEST_FILE}`);
        log.appendLine(`Processing: ${isProcessing}`);
        log.appendLine(`Ready to receive tasks from CLI.`);
        log.appendLine(`Run: polar-apollo "Your prompt here"`);
    });

    context.subscriptions.push(sendPrompt, status, vsWatcher);
    context.subscriptions.push({ dispose: () => watcher.close() });

    log.appendLine(`[Polar Apollo] Watching: ${INBOX_DIR}`);

    // Delayed startup check
    setTimeout(() => {
        if (fs.existsSync(REQUEST_FILE)) {
            log.appendLine('[Polar Apollo] Found pending request on startup');
            scheduleProcess();
        }
    }, 3000);
}

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

        log.appendLine(`[Received] "${prompt.substring(0, 80)}${prompt.length > 80 ? '...' : ''}" (new: ${newSession})`);
        await injectPrompt(prompt, newSession);
    } catch (e) {
        log.appendLine(`[Error] ${e.message}`);
        isProcessing = false;
    }
}

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

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function deactivate() { }

module.exports = { activate, deactivate };
