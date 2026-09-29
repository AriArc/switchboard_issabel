'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { UserStore } = require('../server/users');
const { createApp } = require('../server/app');
const { shapeRecords, normalizeQuery } = require('../server/cdr');

async function setup(t, cdr) {
  const users = new UserStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')), 'users.json'));
  users.ensureAdmin({ username: 'admin', password: 'admin123' });
  users.create({ name: 'Ana', username: 'ana', password: 'secret1', extension: '1001', role: 'user' });
  const pbx = { connected: true, snapshot: () => ({}), calls: () => [] };
  const config = { sessionSecret: 'test', sessionTtlHours: 1 };
  const server = createApp({ config, users, pbx, cdr }).listen(0);
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username, password) => {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    return res.headers.get('set-cookie').split(';')[0];
  };
  return { base, login };
}

test('histórico usa sempre o ramal cadastrado do usuário', async (t) => {
  const calls = [];
  const cdr = { history: async (ext, q) => { calls.push({ ext, q }); return { records: [], hasMore: false }; } };
  const { base, login } = await setup(t, cdr);
  const cookie = await login('ana', 'secret1');

  const res = await fetch(`${base}/api/history?days=30&direction=missed&extension=1002`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).extension, '1001');
  assert.equal(calls[0].ext, '1001');
  assert.equal(calls[0].q.direction, 'missed');

  // Administrador sem ramal não tem histórico
  const admin = await login('admin', 'admin123');
  assert.equal((await fetch(`${base}/api/history`, { headers: { Cookie: admin } })).status, 400);
  assert.equal((await fetch(`${base}/api/history`)).status, 401);
});

test('histórico indisponível sem banco de CDR', async (t) => {
  const { base, login } = await setup(t, null);
  const cookie = await login('ana', 'secret1');
  assert.equal((await fetch(`${base}/api/history`, { headers: { Cookie: cookie } })).status, 503);
});

test('linhas do CDR viram registros do ponto de vista do ramal', () => {
  const rows = [
    // recebida em grupo de toque: uma linha não atendida e outra atendida pelo ramal
    { calldate: '2026-09-29 10:00:00', clid: '"Cliente X" <11988887777>', src: '11988887777', dst: '600', channel: 'SIP/tronco-0001', dstchannel: 'SIP/1001-0002', disposition: 'NO ANSWER', duration: 20, billsec: 0, uniqueid: 'u1' },
    { calldate: '2026-09-29 10:00:00', clid: '"Cliente X" <11988887777>', src: '11988887777', dst: '600', channel: 'SIP/tronco-0001', dstchannel: 'SIP/1001-0003', disposition: 'ANSWERED', duration: 80, billsec: 60, uniqueid: 'u1' },
    // realizada (click-to-call) não atendida
    { calldate: '2026-09-29 11:00:00', clid: '"Chamando 1133334444" <1001>', src: '1001', dst: '1133334444', channel: 'PJSIP/1001-0004', dstchannel: 'SIP/tronco-0005', disposition: 'NO ANSWER', duration: 30, billsec: 0, uniqueid: 'u2' },
    // recebida perdida
    { calldate: '2026-09-29 12:00:00', clid: '"" <1002>', src: '1002', dst: '1001', channel: 'SIP/1002-0006', dstchannel: 'SIP/1001-0007', disposition: 'NO ANSWER', duration: 15, billsec: 0, uniqueid: 'u3' },
  ];
  const recs = shapeRecords(rows, '1001');
  assert.equal(recs.length, 3);
  assert.deepEqual(
    recs.map((r) => [r.direction, r.peer, r.status]),
    [['in', '11988887777', 'answered'], ['out', '1133334444', 'noanswer'], ['in', '1002', 'missed']]
  );
  assert.equal(recs[0].peerName, 'Cliente X');
  assert.equal(recs[0].billsec, 60);
});

test('parâmetros do histórico são limitados', () => {
  const q = normalizeQuery({ days: '9999', direction: 'x', limit: '5000', offset: '-3' });
  assert.deepEqual(q, { days: 365, direction: 'all', search: '', limit: 200, offset: 0 });
});
