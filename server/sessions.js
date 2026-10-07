'use strict';

const crypto = require('crypto');

/**
 * Sessão única por usuário.
 *
 * Cada login gera um id de sessão (sid) gravado no cadastro do usuário; só o sid atual é aceito.
 * A sessão está "em uso" enquanto houver uma página aberta (WebSocket conectado) ou até
 * `graceMs` depois da última atividade — assim um navegador fechado sem "Sair" não trava o usuário.
 */
class Sessions {
  constructor(users, { graceMs = 45000 } = {}) {
    this.users = users;
    this.graceMs = graceMs;
    this.presence = new Map(); // sid -> { sockets: Set<ws>, lastSeen }
  }

  _entry(sid) {
    if (!this.presence.has(sid)) this.presence.set(sid, { sockets: new Set(), lastSeen: 0 });
    return this.presence.get(sid);
  }

  touch(sid) {
    if (sid) this._entry(sid).lastSeen = Date.now();
  }

  /** O usuário tem uma sessão aberta em algum navegador? */
  isActive(user) {
    const p = user && user.sessionId && this.presence.get(user.sessionId);
    return Boolean(p && (p.sockets.size > 0 || Date.now() - p.lastSeen < this.graceMs));
  }

  /** Inicia (ou mantém, no mesmo navegador) a sessão do usuário e devolve o sid. */
  start(user, sameBrowserSid) {
    const sid = sameBrowserSid && sameBrowserSid === user.sessionId ? sameBrowserSid : crypto.randomUUID();
    if (user.sessionId && user.sessionId !== sid) this._closeSockets(user.sessionId, 4001, 'Sessão encerrada');
    this.users.setSession(user.id, sid);
    this.touch(sid);
    return sid;
  }

  /** Encerra a sessão atual do usuário (logout ou ação do administrador). */
  end(user, { code = 4001, reason = 'Sessão encerrada' } = {}) {
    if (!user || !user.sessionId) return;
    this._closeSockets(user.sessionId, code, reason);
    this.presence.delete(user.sessionId);
    this.users.setSession(user.id, null);
  }

  /** Registra a página aberta (WebSocket) de uma sessão. */
  attach(sid, ws) {
    const p = this._entry(sid);
    p.sockets.add(ws);
    p.lastSeen = Date.now();
    ws.on('close', () => {
      p.sockets.delete(ws);
      p.lastSeen = Date.now();
    });
  }

  _closeSockets(sid, code, reason) {
    const p = this.presence.get(sid);
    if (!p) return;
    for (const ws of p.sockets) ws.close(code, reason);
    p.sockets.clear();
  }
}

module.exports = { Sessions };
