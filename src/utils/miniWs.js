'use strict';
// Минимальный WebSocket-клиент на встроенных модулях Node (tls/crypto/events) — БЕЗ внешних зависимостей.
// Фолбэк для wsSession.js, если в окружении не установлен пакет `ws` (напр. контейнер без npm install).
// Поддерживает подмножество API `ws`, которое использует wsSession: события open/message/error/close,
// send(text), close(), terminate(), readyState + статические константы CONNECTING/OPEN/CLOSING/CLOSED.
// Клиент маскирует исходящие фреймы (обязательно по RFC 6455), обрабатывает ping→pong, close,
// фрагментацию и склейку/разрыв TCP-чтений.
const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { URL } = require('url');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;

class MiniWebSocket extends EventEmitter {
  constructor(url, opts = {}) {
    super();
    this.readyState = CONNECTING;
    this._url = url;
    this._headers = opts.headers || {};
    this._handshakeTimeout = opts.handshakeTimeout || 15000;
    this._sock = null;
    this._buf = Buffer.alloc(0);
    this._handshakeDone = false;
    this._handshakeBuf = '';
    this._fragOpcode = 0;
    this._fragChunks = [];
    this._key = crypto.randomBytes(16).toString('base64');
    this._closeEmitted = false;
    this._connect();
  }

  _connect() {
    let u;
    try { u = new URL(this._url); } catch (e) { return this._fail(e); }
    const port = u.port ? Number(u.port) : (u.protocol === 'wss:' ? 443 : 80);
    const sock = tls.connect({ host: u.hostname, port, servername: u.hostname, ALPNProtocols: ['http/1.1'] }, () => {
      const lines = [
        `GET ${u.pathname}${u.search} HTTP/1.1`,
        `Host: ${u.hostname}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${this._key}`,
        'Sec-WebSocket-Version: 13',
      ];
      for (const [k, v] of Object.entries(this._headers)) lines.push(`${k}: ${v}`);
      lines.push('', '');
      sock.write(lines.join('\r\n'));
    });
    this._sock = sock;
    const to = setTimeout(() => { if (!this._handshakeDone) { this._fail(new Error('handshake timeout')); } }, this._handshakeTimeout);
    sock.on('data', (d) => this._onData(d, to));
    sock.on('error', (e) => this._fail(e));
    sock.on('close', () => this._onClose());
  }

  _onData(chunk, handshakeTimer) {
    if (!this._handshakeDone) {
      this._handshakeBuf += chunk.toString('latin1');
      const idx = this._handshakeBuf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = this._handshakeBuf.slice(0, idx);
      const rest = Buffer.from(this._handshakeBuf.slice(idx + 4), 'latin1');
      const ok = /^HTTP\/1\.1 101/i.test(head);
      const accept = (head.match(/sec-websocket-accept:\s*(.+)\r?\n/i) || [])[1];
      const expect = crypto.createHash('sha1').update(this._key + GUID).digest('base64');
      if (!ok || !accept || accept.trim() !== expect) { clearTimeout(handshakeTimer); return this._fail(new Error('bad handshake')); }
      clearTimeout(handshakeTimer);
      this._handshakeDone = true;
      this.readyState = OPEN;
      this.emit('open');
      this._buf = rest;
      this._drainFrames();
      return;
    }
    this._buf = Buffer.concat([this._buf, chunk]);
    this._drainFrames();
  }

  _drainFrames() {
    while (true) {
      if (this._buf.length < 2) return;
      const b0 = this._buf[0], b1 = this._buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this._buf.length < off + 2) return; len = this._buf.readUInt16BE(off); off += 2; }
      else if (len === 127) { if (this._buf.length < off + 8) return; const hi = this._buf.readUInt32BE(off); const lo = this._buf.readUInt32BE(off + 4); len = hi * 2 ** 32 + lo; off += 8; }
      let maskKey = null;
      if (masked) { if (this._buf.length < off + 4) return; maskKey = this._buf.slice(off, off + 4); off += 4; }
      if (this._buf.length < off + len) return;
      let payload = this._buf.slice(off, off + len);
      if (masked) { const p = Buffer.from(payload); for (let i = 0; i < p.length; i++) p[i] ^= maskKey[i & 3]; payload = p; }
      this._buf = this._buf.slice(off + len);
      this._handleFrame(fin, opcode, payload);
    }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      this.readyState = CLOSING;
      try { this._sendFrame(0x8, payload); } catch (_) {}
      try { this._sock.end(); } catch (_) {}
      return;
    }
    if (opcode === 0x9) { try { this._sendFrame(0xA, payload); } catch (_) {} return; }
    if (opcode === 0xA) { this.emit('message', payload); return; }
    if (opcode === 0x0) {
      this._fragChunks.push(payload);
      if (fin) { const full = Buffer.concat(this._fragChunks); this._fragChunks = []; this._fragOpcode = 0; this.emit('message', full); }
      return;
    }
    if (!fin) { this._fragOpcode = opcode; this._fragChunks = [payload]; return; }
    this.emit('message', payload);
  }

  _sendFrame(opcode, data) {
    const sock = this._sock;
    if (!sock || sock.destroyed || sock.writableEnded || this.readyState === CLOSED) return;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
    else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeUInt32BE(Math.floor(len / 2 ** 32), 2); header.writeUInt32BE(len >>> 0, 6); }
    header[0] = 0x80 | opcode;
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    try { sock.write(Buffer.concat([header, mask, masked])); } catch (_) { /* сокет закрывается */ }
  }

  send(data) {
    if (this.readyState !== OPEN) throw new Error('WebSocket is not open');
    this._sendFrame(0x1, data);
  }

  close(code, reason) {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    this.readyState = CLOSING;
    try {
      const c = Buffer.alloc(2); c.writeUInt16BE(code || 1000, 0);
      this._sendFrame(0x8, reason ? Buffer.concat([c, Buffer.from(String(reason))]) : c);
    } catch (_) {}
    try { this._sock && this._sock.end(); } catch (_) {}
  }

  terminate() {
    this.readyState = CLOSED;
    try { this._sock && this._sock.destroy(); } catch (_) {}
  }

  _fail(err) {
    this.emit('error', err);
    try { this._sock && this._sock.destroy(); } catch (_) {}
    this._onClose(1006);
  }

  _onClose(code) {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.readyState = CLOSED;
    this.emit('close', code || 1006, Buffer.alloc(0));
  }
}

MiniWebSocket.CONNECTING = CONNECTING;
MiniWebSocket.OPEN = OPEN;
MiniWebSocket.CLOSING = CLOSING;
MiniWebSocket.CLOSED = CLOSED;

module.exports = MiniWebSocket;
