// The WebSocket to the bundled eufy bridge: reconnects on its own (backing off up to 30 s) and
// matches answers to requests by id.
//
// Events:  'open'   'close'   'message' (anything that isn't an answer to a request)

import { EventEmitter } from 'node:events';

export class BridgeSocket extends EventEmitter {
  constructor({ url, log, WebSocketImpl = globalThis.WebSocket }) {
    super();
    Object.assign(this, { url, log, WebSocketImpl });
    this.pending = new Map();   // request id -> resolve
    this.nextId = 100;
    this.backoff = 1000;
  }

  get isOpen() {
    return this.ws?.readyState === 1;   // WebSocket.OPEN
  }

  connect() {
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.log('bridge connected');
      this.emit('open');
    };
    ws.onmessage = (e) => {
      let message;
      try { message = JSON.parse(e.data); } catch { return; }
      if (message.id != null && this.pending.has(message.id)) this.answer(message);
      else this.emit('message', message);
    };
    ws.onclose = () => {
      for (const id of this.pending.keys()) this.answer({ id, ok: false, error: 'bridge disconnected' });
      this.emit('close');
      this.log(`bridge disconnected, retry in ${this.backoff / 1000} s`);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    };
    ws.onerror = () => {};
  }

  // Sends a command and resolves with the bridge's answer.
  request(message, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this.isOpen) return reject(new Error('bridge not connected'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('bridge did not answer'));
      }, timeoutMs);
      this.pending.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      this.ws.send(JSON.stringify({ ...message, id }));
    });
  }

  answer(message) {
    this.pending.get(message.id)(message);
    this.pending.delete(message.id);
  }
}
