'use strict';

const path = require('path');
const express = require('express');
const { sign, userFromRequest, sessionCookie, COOKIE } = require('./auth');
const { publicUser } = require('./users');
const { describeCdrError } = require('./cdr');

const NUMBER_RE = /^\+?[0-9*#]{2,32}$/;

/** Remove formatação comum de telefone: "(11) 99999-0000" -> "11999990000" */
function normalizeNumber(input) {
  return String(input || '').replace(/[\s().\-]/g, '');
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function createApp({ config, users, pbx, cdr = null }) {
  const app = express();
  app.disable('x-powered-by');
  // Atrás de um proxy local (Apache/nginx): usa o IP real do cliente e o protocolo HTTPS informado pelo proxy
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '32kb' }));

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  const auth = (req, res, next) => {
    req.user = userFromRequest(req, { secret: config.sessionSecret, users });
    if (!req.user) return next(httpError(401, 'Sessão expirada. Entre novamente.'));
    next();
  };
  const requireRole = (...roles) => (req, res, next) =>
    roles.includes(req.user.role) ? next() : next(httpError(403, 'Acesso negado'));

  // Proteção simples contra força bruta no login
  const attempts = new Map();
  const tooMany = (ip) => {
    const now = Date.now();
    const list = (attempts.get(ip) || []).filter((t) => now - t < 5 * 60000);
    attempts.set(ip, list);
    return list.length >= 10;
  };

  app.post('/api/login', (req, res, next) => {
    if (tooMany(req.ip)) return next(httpError(429, 'Muitas tentativas. Aguarde alguns minutos.'));
    const user = users.authenticate(req.body.username, req.body.password);
    if (!user) {
      attempts.get(req.ip).push(Date.now());
      return next(httpError(401, 'Usuário ou senha inválidos'));
    }
    const maxAgeSec = config.sessionTtlHours * 3600;
    const token = sign({ uid: user.id, exp: Date.now() + maxAgeSec * 1000 }, config.sessionSecret);
    res.set('Set-Cookie', sessionCookie(token, { maxAgeSec, secure: req.secure }));
    res.json({ user: publicUser(user) });
  });

  app.post('/api/logout', (req, res) => {
    res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

  app.get('/api/state', auth, (req, res) => res.json(pbx.snapshot()));

  // Click-to-call: o ramal discador é SEMPRE o associado ao usuário no cadastro.
  app.post('/api/call', auth, async (req, res, next) => {
    try {
      const extension = req.user.extension;
      if (!extension) throw httpError(400, 'Seu usuário não possui ramal discador associado. Contate o administrador.');
      const number = normalizeNumber(req.body.number);
      if (!NUMBER_RE.test(number)) throw httpError(400, 'Número inválido');
      if (number === extension) throw httpError(400, 'Não é possível ligar para o próprio ramal');
      if (!pbx.connected) throw httpError(503, 'PABX desconectado');
      await pbx.originate(extension, number);
      console.log(`[click2call] ${req.user.username} (${extension}) -> ${number}`);
      res.json({ ok: true, extension, number });
    } catch (err) {
      next(err);
    }
  });

  // Histórico de ligações: sempre do ramal cadastrado do usuário logado
  app.get('/api/history', auth, async (req, res, next) => {
    try {
      const extension = req.user.extension;
      if (!extension) throw httpError(400, 'Seu usuário não possui ramal cadastrado.');
      if (!cdr) throw httpError(503, 'Histórico indisponível: banco de CDR não configurado (CDR_DB_HOST).');
      const result = await cdr.history(extension, req.query);
      res.json({ extension, ...result });
    } catch (err) {
      if (!err.status) {
        const reason = describeCdrError(err, cdr && cdr.dbConfig);
        console.error('[cdr]', reason);
        return next(httpError(502, `Não foi possível consultar o histórico: ${reason}.`));
      }
      next(err);
    }
  });

  const findCall = (id) => pbx.calls().find((c) => c.id === id);
  const canManage = (user, call) =>
    user.role === 'admin' || user.role === 'operator' || (user.extension && call.extensions.includes(user.extension));

  app.post('/api/calls/:id/hangup', auth, async (req, res, next) => {
    try {
      const call = findCall(req.params.id);
      if (!call) throw httpError(404, 'Chamada não encontrada');
      if (!canManage(req.user, call)) throw httpError(403, 'Você só pode desligar suas próprias chamadas');
      for (const ch of call.channels) await pbx.hangup(ch.channel).catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/calls/:id/transfer', auth, async (req, res, next) => {
    try {
      const call = findCall(req.params.id);
      if (!call) throw httpError(404, 'Chamada não encontrada');
      if (!canManage(req.user, call)) throw httpError(403, 'Você só pode transferir suas próprias chamadas');
      const target = normalizeNumber(req.body.target);
      if (!NUMBER_RE.test(target)) throw httpError(400, 'Destino inválido');

      // Quem participa da chamada transfere o "outro lado"; a mesa operadora transfere o lado externo.
      const mine = req.user.extension && call.extensions.includes(req.user.extension);
      const channel = mine
        ? call.channels.find((c) => c.extension !== req.user.extension)
        : call.channels.find((c) => !c.extension) || call.channels[0];
      if (!channel) throw httpError(400, 'Não há outro participante para transferir');
      await pbx.redirect(channel.channel, target);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Administração de usuários
  app.get('/api/users', auth, requireRole('admin'), (req, res) => res.json({ users: users.list() }));
  app.post('/api/users', auth, requireRole('admin'), (req, res, next) => {
    try {
      res.status(201).json({ user: users.create(req.body) });
    } catch (err) {
      next(err);
    }
  });
  app.put('/api/users/:id', auth, requireRole('admin'), (req, res, next) => {
    try {
      res.json({ user: users.update(req.params.id, req.body) });
    } catch (err) {
      next(err);
    }
  });
  app.delete('/api/users/:id', auth, requireRole('admin'), (req, res, next) => {
    try {
      if (req.params.id === req.user.id) throw httpError(400, 'Você não pode excluir o próprio usuário');
      users.remove(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.use('/api', (req, res, next) => next(httpError(404, 'Rota não encontrada')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'Erro interno' });
  });

  return app;
}

module.exports = { createApp, normalizeNumber };
