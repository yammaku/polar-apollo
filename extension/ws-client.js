/**
 * Lightweight WebSocket client using Node.js built-in modules.
 * Zero external dependencies — only needs `net`, `crypto`, `http`.
 * 
 * Supports: text frames only (sufficient for JSON protocol).
 * Does NOT support: binary frames, extensions, fragmentation.
 */

const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class SimpleWebSocket extends EventEmitter {
    constructor(url) {
        super();
        this.url = new URL(url);
        this.socket = null;
        this.connected = false;
        this._buffer = Buffer.alloc(0);
    }

    connect() {
        const key = crypto.randomBytes(16).toString('base64');
        const options = {
            hostname: this.url.hostname,
            port: this.url.port || 80,
            path: this.url.pathname + this.url.search,
            headers: {
                'Upgrade': 'websocket',
                'Connection': 'Upgrade',
                'Sec-WebSocket-Key': key,
                'Sec-WebSocket-Version': '13',
            }
        };

        const req = http.request(options);
        req.end();

        req.on('upgrade', (res, socket) => {
            this.socket = socket;
            this.connected = true;
            this.emit('open');

            socket.on('data', (data) => this._onData(data));
            socket.on('close', () => this._onClose());
            socket.on('error', (err) => this.emit('error', err));
        });

        req.on('error', (err) => {
            this.emit('error', err);
        });

        // Timeout for the upgrade
        req.setTimeout(10000, () => {
            req.destroy(new Error('WebSocket upgrade timeout'));
        });
    }

    send(data) {
        if (!this.connected || !this.socket) {
            throw new Error('WebSocket not connected');
        }
        const payload = Buffer.from(data, 'utf-8');
        const frame = this._encodeFrame(payload);
        this.socket.write(frame);
    }

    close() {
        if (this.socket) {
            // Send close frame
            const closeFrame = Buffer.alloc(6);
            closeFrame[0] = 0x88; // FIN + close opcode
            closeFrame[1] = 0x80; // Mask + 0 length
            const mask = crypto.randomBytes(4);
            mask.copy(closeFrame, 2);
            this.socket.write(closeFrame);
            this.socket.end();
        }
        this.connected = false;
    }

    _encodeFrame(payload) {
        const length = payload.length;
        let header;

        if (length < 126) {
            header = Buffer.alloc(6);
            header[0] = 0x81; // FIN + text opcode
            header[1] = 0x80 | length; // Mask bit + length
            const mask = crypto.randomBytes(4);
            mask.copy(header, 2);
            const masked = Buffer.alloc(length);
            for (let i = 0; i < length; i++) {
                masked[i] = payload[i] ^ mask[i % 4];
            }
            return Buffer.concat([header, masked]);
        } else if (length < 65536) {
            header = Buffer.alloc(8);
            header[0] = 0x81;
            header[1] = 0x80 | 126;
            header.writeUInt16BE(length, 2);
            const mask = crypto.randomBytes(4);
            mask.copy(header, 4);
            const masked = Buffer.alloc(length);
            for (let i = 0; i < length; i++) {
                masked[i] = payload[i] ^ mask[i % 4];
            }
            return Buffer.concat([header, masked]);
        } else {
            header = Buffer.alloc(14);
            header[0] = 0x81;
            header[1] = 0x80 | 127;
            // Write 64-bit length (only lower 32 bits needed for realistic payloads)
            header.writeUInt32BE(0, 2);
            header.writeUInt32BE(length, 6);
            const mask = crypto.randomBytes(4);
            mask.copy(header, 10);
            const masked = Buffer.alloc(length);
            for (let i = 0; i < length; i++) {
                masked[i] = payload[i] ^ mask[i % 4];
            }
            return Buffer.concat([header, masked]);
        }
    }

    _onData(chunk) {
        this._buffer = Buffer.concat([this._buffer, chunk]);
        this._processFrames();
    }

    _processFrames() {
        while (this._buffer.length >= 2) {
            const byte0 = this._buffer[0];
            const byte1 = this._buffer[1];
            const opcode = byte0 & 0x0F;
            const masked = (byte1 & 0x80) !== 0;
            let payloadLength = byte1 & 0x7F;
            let offset = 2;

            if (payloadLength === 126) {
                if (this._buffer.length < 4) return; // Need more data
                payloadLength = this._buffer.readUInt16BE(2);
                offset = 4;
            } else if (payloadLength === 127) {
                if (this._buffer.length < 10) return;
                payloadLength = this._buffer.readUInt32BE(6); // Lower 32 bits
                offset = 10;
            }

            if (masked) offset += 4;
            if (this._buffer.length < offset + payloadLength) return; // Need more data

            let payload = this._buffer.slice(offset, offset + payloadLength);

            if (masked) {
                const maskKey = this._buffer.slice(offset - 4, offset);
                for (let i = 0; i < payload.length; i++) {
                    payload[i] = payload[i] ^ maskKey[i % 4];
                }
            }

            this._buffer = this._buffer.slice(offset + payloadLength);

            if (opcode === 0x01) {
                // Text frame
                this.emit('message', payload.toString('utf-8'));
            } else if (opcode === 0x08) {
                // Close frame
                this._onClose();
                return;
            } else if (opcode === 0x09) {
                // Ping — send pong
                this._sendPong(payload);
            }
            // Ignore other opcodes (pong, binary, continuation)
        }
    }

    _sendPong(payload) {
        if (!this.socket) return;
        const mask = crypto.randomBytes(4);
        const header = Buffer.alloc(6 + payload.length);
        header[0] = 0x8A; // FIN + pong
        header[1] = 0x80 | payload.length;
        mask.copy(header, 2);
        for (let i = 0; i < payload.length; i++) {
            header[6 + i] = payload[i] ^ mask[i % 4];
        }
        this.socket.write(header);
    }

    _onClose() {
        this.connected = false;
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.emit('close');
    }
}

module.exports = { SimpleWebSocket };
