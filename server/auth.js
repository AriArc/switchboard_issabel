'use strict';

const crypto = require('crypto');

const COOKIE = 'sb_session';

function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Resolve a sessão da requisição (HTTP ou upgrade do WebSocket) a partir do cookie.
 * Só vale a sessão atual do usuário (sessão única): logins anteriores ficam inválidos.
 */
function sessionFromRequest(req, { secret, users }) {
  const payload = verify(parseCookies(req.headers.cookie)[COOKIE], secret);
  if (!payload || !payload.sid) return null;
  const user = users.get(payload.uid);
  if (!user || !user.active || user.sessionId !== payload.sid) return null;
  return { user, sid: payload.sid };
}

function userFromRequest(req, opts) {
  const s = sessionFromRequest(req, opts);
  return s ? s.user : null;
}

function sessionCookie(token, { maxAgeSec, secure }) {
  return [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

module.exports = { COOKIE, sign, verify, parseCookies, sessionFromRequest, userFromRequest, sessionCookie };
