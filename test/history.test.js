'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { UserStore } = require('../server/users');
const { createApp } = require('../server/app');
const { shapeCalls, normalizeQuery } = require('../server/cdr');

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

// Linhas no formato real do Issabel 5 (siga-me do ramal 7000 tocando ramal + celular 0988500072)
const FM = 'Local/FMPR-7000@from-internal&Local/FMGL-0988500072#@from-internal,56,trIM(auto';
const followMeRows = [
  // tronco -> 7000, atendida no celular do siga-me (2 s)
  { linkedid: 'L1', calldate: '2026-09-29 12:56:43', clid: '"83991389559" <83991389559>', src: '83991389559', dst: '7000', channel: 'PJSIP/IntekVox-00000025', dstchannel: 'Local/FMPR-7000@from-internal-00000014;1', disposition: 'NO ANSWER', duration: 16, billsec: 0, lastdata: FM },
  { linkedid: 'L1', calldate: '2026-09-29 12:56:43', clid: '"83991389559" <83991389559>', src: '83991389559', dst: '7000', channel: 'PJSIP/IntekVox-00000025', dstchannel: 'Local/FMGL-0988500072#@from-internal-00000015;1', disposition: 'ANSWERED', duration: 17, billsec: 0 },
  { linkedid: 'L1', calldate: '2026-09-29 12:57:00', clid: '"83991389559" <83991389559>', src: '83991389559', dst: '7000', channel: 'PJSIP/IntekVox-00000025', dstchannel: 'Local/0988500072@from-internal-00000016;1', disposition: 'ANSWERED', duration: 2, billsec: 2 },
  // ramal 3602 -> 7000, ninguém conversou (ANSWERED com 0 s é só a perna do siga-me)
  { linkedid: 'L2', calldate: '2026-10-07 09:41:46', clid: '"Junior" <3602>', src: '3602', dst: '7000', channel: 'PJSIP/3602-0000003f', dstchannel: 'Local/FMGL-0988500072#@from-internal-00000022;1', disposition: 'ANSWERED', duration: 23, billsec: 0 },
  { linkedid: 'L2', calldate: '2026-10-07 09:41:46', clid: '"Junior" <3602>', src: '3602', dst: '7000', channel: 'PJSIP/3602-0000003f', dstchannel: 'Local/FMPR-7000@from-internal-00000021;1', disposition: 'NO ANSWER', duration: 16, billsec: 0 },
  // mesma ligação gravada em duas partes, uma com destino 's'
  { linkedid: 'L3', calldate: '2026-09-08 14:31:09', clid: '"" <3601>', src: '3601', dst: '7000', channel: 'PJSIP/3601-00000010', dstchannel: 'PJSIP/7000-00000011', disposition: 'ANSWERED', duration: 30, billsec: 25 },
  { linkedid: 'L3', calldate: '2026-09-08 14:31:09', clid: '"" <7000>', src: '7000', dst: 's', channel: 'PJSIP/7000-00000011', dstchannel: '', disposition: 'ANSWERED', duration: 30, billsec: 25 },
  // realizada pelo 7000 para fora, não atendida
  { linkedid: 'L4', calldate: '2026-10-07 10:00:00', clid: '"Recepção" <7000>', src: '7000', dst: '1133334444', channel: 'PJSIP/7000-00000050', dstchannel: 'PJSIP/IntekVox-00000051', disposition: 'NO ANSWER', duration: 30, billsec: 0 },
  // ligação de outro ramal, sem relação com o 7000
  { linkedid: 'L5', calldate: '2026-10-07 10:05:00', clid: '"" <3601>', src: '3601', dst: '3602', channel: 'PJSIP/3601-00000060', dstchannel: 'PJSIP/3602-00000061', disposition: 'ANSWERED', duration: 10, billsec: 8 },
];

test('siga-me e ligações em várias partes viram um registro por ligação', () => {
  const recs = shapeCalls(followMeRows, '7000');
  const by = Object.fromEntries(recs.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(by).sort(), ['L1', 'L2', 'L3', 'L4']);

  assert.equal(by.L1.direction, 'in');
  assert.equal(by.L1.peer, '83991389559');
  assert.equal(by.L1.status, 'answered');
  assert.equal(by.L1.forwarded, true); // atendida no celular do siga-me
  assert.equal(by.L1.billsec, 2);
  assert.equal(by.L1.calldate, '2026-09-29 12:56:43');

  assert.equal(by.L2.direction, 'in');
  assert.equal(by.L2.peer, '3602');
  assert.equal(by.L2.peerName, 'Junior');
  assert.equal(by.L2.status, 'missed');

  assert.equal(by.L3.direction, 'in'); // a parte com destino 's' não vira "realizada para s"
  assert.equal(by.L3.peer, '3601');
  assert.equal(by.L3.status, 'answered');
  assert.equal(by.L3.forwarded, false);

  assert.equal(by.L4.direction, 'out');
  assert.equal(by.L4.peer, '1133334444');
  assert.equal(by.L4.status, 'noanswer');
});

test('grupo de toque: atendida em outra linha não conta como perdida', () => {
  const rows = [
    { uniqueid: 'u1', calldate: '2026-09-29 10:00:00', clid: '"Cliente X" <11988887777>', src: '11988887777', dst: '600', channel: 'SIP/tronco-0001', dstchannel: 'PJSIP/1001-0002', disposition: 'NO ANSWER', duration: 20, billsec: 0 },
    { uniqueid: 'u1', calldate: '2026-09-29 10:00:00', clid: '"Cliente X" <11988887777>', src: '11988887777', dst: '600', channel: 'SIP/tronco-0001', dstchannel: 'PJSIP/1001-0003', disposition: 'ANSWERED', duration: 80, billsec: 60 },
  ];
  const [r] = shapeCalls(rows, '1001');
  assert.equal(r.status, 'answered');
  assert.equal(r.peerName, 'Cliente X');
  assert.equal(r.billsec, 60);
});

test('parâmetros do histórico são limitados', () => {
  const q = normalizeQuery({ days: '9999', direction: 'x', limit: '5000', offset: '-3' });
  assert.deepEqual(q, { days: 365, direction: 'all', search: '', limit: 200, offset: 0 });
});
