'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { UserStore } = require('../server/users');
const { createApp } = require('../server/app');
const { Sessions } = require('../server/sessions');

async function setup(t, graceMs = 45000) {
  const users = new UserStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')), 'users.json'));
  users.ensureAdmin({ username: 'admin', password: 'admin123' });
  users.create({ name: 'Ana', username: 'ana', password: 'secret1', extension: '7000', role: 'user' });
  const sessions = new Sessions(users, { graceMs });
  const pbx = { connected: true, snapshot: () => ({}), calls: () => [] };
  const server = createApp({ config: { sessionSecret: 'test', sessionTtlHours: 1 }, users, pbx, sessions }).listen(0);
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (username, password, cookie) => fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ username, password }),
  });
  const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];
  const me = (cookie) => fetch(`${base}/api/me`, { headers: { Cookie: cookie } });
  return { base, users, login, cookieOf, me };
}

test('segundo login com o mesmo usuário é recusado enquanto o primeiro está em uso', async (t) => {
  const { login, cookieOf, me } = await setup(t);
  const a = await login('ana', 'secret1');
  assert.equal(a.status, 200);
  const cookieA = cookieOf(a);

  const b = await login('ana', 'secret1');
  assert.equal(b.status, 409);
  assert.match((await b.json()).error, /Usuário em uso/);
  assert.equal((await me(cookieA)).status, 200); // o primeiro continua funcionando

  // Senha errada continua sendo "inválida", não revela que o usuário está em uso
  assert.equal((await login('ana', 'errada')).status, 401);

  // No mesmo navegador (mesmo cookie), entrar de novo é permitido
  const again = await login('ana', 'secret1', cookieA);
  assert.equal(again.status, 200);
  assert.equal((await me(cookieOf(again))).status, 200);
});

test('após sair, outro navegador consegue entrar e a sessão antiga fica inválida', async (t) => {
  const { base, login, cookieOf, me } = await setup(t);
  const cookieA = cookieOf(await login('ana', 'secret1'));
  await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie: cookieA } });
  assert.equal((await me(cookieA)).status, 401);

  const b = await login('ana', 'secret1');
  assert.equal(b.status, 200);
  assert.equal((await me(cookieA)).status, 401);
  assert.equal((await me(cookieOf(b))).status, 200);
});

test('navegador fechado sem sair libera o usuário após o tempo de tolerância', async (t) => {
  const { login, cookieOf, me } = await setup(t, 80);
  const cookieA = cookieOf(await login('ana', 'secret1'));
  assert.equal((await login('ana', 'secret1')).status, 409);
  await new Promise((r) => setTimeout(r, 120));
  const b = await login('ana', 'secret1');
  assert.equal(b.status, 200);
  assert.equal((await me(cookieA)).status, 401); // a sessão antiga não volta a valer
});

test('administrador vê quem está online e encerra a sessão', async (t) => {
  const { base, users, login, cookieOf, me } = await setup(t);
  const cookieAna = cookieOf(await login('ana', 'secret1'));
  const cookieAdmin = cookieOf(await login('admin', 'admin123'));

  const list = (await (await fetch(`${base}/api/users`, { headers: { Cookie: cookieAdmin } })).json()).users;
  const ana = list.find((u) => u.username === 'ana');
  assert.equal(ana.online, true);
  assert.equal(ana.sessionId, undefined); // o id da sessão não é exposto

  const kick = await fetch(`${base}/api/users/${ana.id}/logout`, { method: 'POST', headers: { Cookie: cookieAdmin } });
  assert.equal(kick.status, 200);
  assert.equal((await me(cookieAna)).status, 401);
  assert.equal(users.get(ana.id).sessionId, null);
  assert.equal((await login('ana', 'secret1')).status, 200);
});
