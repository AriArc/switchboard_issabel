'use strict';

const net = require('net');
const { EventEmitter } = require('events');

/**
 * Cliente mínimo do Asterisk Manager Interface (AMI).
 *
 * - Reconecta automaticamente.
 * - action() devolve uma Promise com a resposta; para ações que geram uma
 *   lista de eventos (EventList: start) a Promise resolve com { response, events }.
 * - Todos os eventos assíncronos são emitidos como 'event'.
 */
class AmiClient extends EventEmitter {
  constructor({ host, port, username, secret }) {
    super();
    this.opts = { host, port, username, secret };
    this.socket = null;
    this.buffer = '';
    this.pending = new Map();
    this.seq = 0;
    this.connected = false;
    this.stopped = false;
    this.reconnectDelay = 1000;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this.socket) this.socket.destroy();
  }

  _connect() {
    const { host, port } = this.opts;
    this.buffer = '';
    const socket = net.createConnection({ host, port });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 30000);

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this.emit('error', err));
    socket.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this._rejectAll(new Error('Conexão AMI encerrada'));
      if (wasConnected) this.emit('disconnected');
      if (!this.stopped) {
        setTimeout(() => this._connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      }
    });
  }

  _onData(chunk) {
    this.buffer += chunk;

    // A primeira linha é o banner "Asterisk Call Manager/x.y"
    if (!this.connected && this.buffer.startsWith('Asterisk Call Manager')) {
      const nl = this.buffer.indexOf('\r\n');
      if (nl === -1) return;
      this.buffer = this.buffer.slice(nl + 2);
      this._login();
    }

    let idx;
    while ((idx = this.buffer.indexOf('\r\n\r\n')) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 4);
      if (raw.trim()) this._onMessage(parseMessage(raw));
    }
  }

  async _login() {
    try {
      const res = await this.action({
        Action: 'Login',
        Username: this.opts.username,
        Secret: this.opts.secret,
        Events: 'on',
      }, { beforeConnected: true });
      if (res.response !== 'Success') throw new Error(res.message || 'Falha no login AMI');
      this.connected = true;
      this.reconnectDelay = 1000;
      this.emit('connected');
    } catch (err) {
      this.emit('error', err);
      this.socket.destroy();
    }
  }

  _onMessage(msg) {
    const id = msg.actionid;
    const pending = id && this.pending.get(id);

    if (pending) {
      if (msg.response !== undefined && !pending.response) {
        pending.response = msg;
        if (msg.eventlist && msg.eventlist.toLowerCase() === 'start') return;
        // Algumas versões respondem "Follows" à ação Command sem EventList
        return this._finish(id);
      }
      if (msg.event !== undefined && pending.response) {
        if (msg.eventlist && msg.eventlist.toLowerCase() === 'complete') return this._finish(id);
        pending.events.push(msg);
        return;
      }
    }

    if (msg.event !== undefined) this.emit('event', msg);
  }

  _finish(id) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    const res = p.response;
    res.events = p.events;
    p.resolve(res);
  }

  _rejectAll(err) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  action(fields, { timeout = 10000, beforeConnected = false } = {}) {
    if (!this.socket || this.socket.destroyed || (!this.connected && !beforeConnected)) {
      return Promise.reject(new Error('AMI não conectado'));
    }
    const actionId = `sb-${Date.now()}-${++this.seq}`;
    const lines = Object.entries({ ...fields, ActionID: actionId }).flatMap(([k, v]) =>
      Array.isArray(v) ? v.map((item) => `${k}: ${item}`) : [`${k}: ${v}`]
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(actionId);
        reject(new Error(`Tempo esgotado aguardando resposta de ${fields.Action}`));
      }, timeout);
      this.pending.set(actionId, { resolve, reject, timer, response: null, events: [] });
      this.socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
  }
}

// Converte "Chave: valor" em objeto com chaves minúsculas.
// Linhas "Output:" (resposta de Command) são acumuladas em msg.output (array).
function parseMessage(raw) {
  const msg = {};
  const follows = /^Response:\s*Follows/i.test(raw);
  for (const line of raw.split('\r\n')) {
    if (line === '--END COMMAND--') continue;
    const sep = line.indexOf(':');
    const header = sep !== -1 && line.slice(0, sep).trim().toLowerCase();
    if (sep === -1 || (follows && !['response', 'privilege', 'actionid'].includes(header))) {
      // Asterisk antigo: saída de Command vem "crua", sem prefixo
      (msg.output = msg.output || []).push(line);
      continue;
    }
    const key = header;
    const value = line.slice(sep + 1).trim();
    if (key === 'output') (msg.output = msg.output || []).push(value);
    else msg[key] = value;
  }
  return msg;
}

module.exports = { AmiClient, parseMessage };
