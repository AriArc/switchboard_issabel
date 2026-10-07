'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { UserStore } = require('../server/users');
const { createApp } = require('../server/app');
const { resolveRecording, shapeRecording } = require('../server/recordings');

async function setup(t, { cdr, recordings }) {
  const users = new UserStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')), 'users.json'));
  users.ensureAdmin({ username: 'admin', password: 'admin123' });
  users.create({ name: 'Ana', username: 'ana', password: 'secret1', extension: '7000', role: 'user' });
  users.create({ name: 'Op', username: 'oper', password: 'secret1', extension: '3601', role: 'operator' });
  users.create({ name: 'Sup', username: 'super', password: 'secret1', extension: '3602', role: 'supervisor' });
  const pbx = { connected: true, snapshot: () => ({}), calls: () => [] };
  const server = createApp({ config: { sessionSecret: 'test', sessionTtlHours: 1 }, users, pbx, cdr, recordings }).listen(0);
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username, password) => (await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
  })).headers.get('set-cookie').split(';')[0];
  const get = (url, cookie) => fetch(base + url, { headers: cookie ? { Cookie: cookie } : {} });
  return { login, get };
}

test('administrador consulta o histórico de qualquer ramal; os demais só o próprio', async (t) => {
  const seen = [];
  const cdr = { history: async (ext) => { seen.push(ext); return { records: [], hasMore: false }; } };
  const { login, get } = await setup(t, { cdr });
  const admin = await login('admin', 'admin123');
  assert.equal((await (await get('/api/history?extension=3601', admin)).json()).extension, '3601');
  assert.equal((await get('/api/history', admin)).status, 400); // admin sem ramal precisa escolher
  assert.equal((await get('/api/history?extension=12a', admin)).status, 400);

  const ana = await login('ana', 'secret1');
  assert.equal((await (await get('/api/history?extension=3601', ana)).json()).extension, '7000');
  const op = await login('oper', 'secret1');
  assert.equal((await (await get('/api/history?extension=7000', op)).json()).extension, '3601');
  assert.deepEqual(seen, ['3601', '7000', '3601']);
});

test('gravações só para administrador, com áudio servido do diretório de gravações', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-'));
  const file = 'exten-7000-3602-20261007-094146-1791376906.822.wav';
  fs.mkdirSync(path.join(dir, '2026', '10', '07'), { recursive: true });
  fs.writeFileSync(path.join(dir, '2026', '10', '07', file), Buffer.alloc(2000, 1));
  const recordings = {
    list: async () => ({ records: [{ file }], hasMore: false, total: 1 }),
    audioPath: async (f) => (f === file ? resolveRecording(dir, f, '2026-10-07 09:41:46') : null),
  };
  const { login, get } = await setup(t, { recordings });

  const ana = await login('ana', 'secret1');
  assert.equal((await get('/api/recordings', ana)).status, 403);
  assert.equal((await get(`/api/recordings/audio?file=${file}`, ana)).status, 403);
  const op = await login('oper', 'secret1');
  assert.equal((await get('/api/recordings', op)).status, 403);
  assert.equal((await get('/api/recordings')).status, 401);

  const admin = await login('admin', 'admin123');
  assert.equal((await (await get('/api/recordings', admin)).json()).total, 1);
  const audio = await get(`/api/recordings/audio?file=${file}`, admin);
  assert.equal(audio.status, 200);
  assert.match(audio.headers.get('content-type'), /audio\/wav/);
  assert.equal((await audio.arrayBuffer()).byteLength, 2000);

  // Range (necessário para avançar/voltar no player)
  const part = await fetch(audio.url, { headers: { Cookie: admin, Range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 100);

  const dl = await get(`/api/recordings/audio?file=${file}&download=1`, admin);
  assert.match(dl.headers.get('content-disposition'), /attachment; filename="exten-7000/);
  assert.equal((await get('/api/recordings/audio?file=../../etc/passwd', admin)).status, 404);
});

test('localização do arquivo não sai do diretório de gravações', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-'));
  fs.mkdirSync(path.join(dir, '2026', '09', '29'), { recursive: true });
  fs.writeFileSync(path.join(dir, '2026', '09', '29', 'a.wav'), 'x');
  fs.writeFileSync(path.join(dir, '2026', '09', '29', 'sem-extensao.WAV'), 'x');
  const outside = path.join(os.tmpdir(), `fora-${process.pid}.wav`);
  fs.writeFileSync(outside, 'x');

  assert.equal(resolveRecording(dir, 'a.wav', '2026-09-29 14:30:01'), path.join(dir, '2026', '09', '29', 'a.wav'));
  assert.equal(resolveRecording(dir, 'sem-extensao', '2026-09-29 10:00:00'), path.join(dir, '2026', '09', '29', 'sem-extensao.WAV'));
  assert.equal(resolveRecording(dir, path.join(dir, '2026', '09', '29', 'a.wav'), ''), path.join(dir, '2026', '09', '29', 'a.wav'));
  assert.equal(resolveRecording(dir, outside, '2026-09-29 10:00:00'), null);
  assert.equal(resolveRecording(dir, '../a.wav', '2026-09-29 10:00:00'), null);
  assert.equal(resolveRecording(dir, 'nao-existe.wav', '2026-09-29 10:00:00'), null);
  assert.equal(resolveRecording(dir, '2026/09/29/a.wav', ''), path.join(dir, '2026', '09', '29', 'a.wav'));
  assert.equal(resolveRecording(dir, '2026/../../a.wav', ''), null);
});

test('item da gravação mostra quem ligou, destino e duração da conversa', () => {
  const file = 'exten-7000-83998694799-20260929-143001-1790703001.662.wav';
  const rows = [
    { calldate: '2026-09-29 14:30:01', clid: '"83998694799" <83998694799>', src: '83998694799', dst: '7000', dstchannel: 'Local/FMPR-7000@from-internal-0000001d;1', billsec: 0 },
    { calldate: '2026-09-29 14:30:19', clid: '"83998694799" <83998694799>', src: '83998694799', dst: '7000', dstchannel: 'Local/0988500072@from-internal-0000001f;1', billsec: 2 },
  ];
  const r = shapeRecording(file, rows, os.tmpdir());
  assert.deepEqual([r.calldate, r.from, r.fromName, r.to, r.billsec, r.available], ['2026-09-29 14:30:01', '83998694799', '', '7000', 2, false]);

  const c2c = shapeRecording('out-x.wav', [
    { calldate: '2026-10-07 11:00:00', clid: '"Chamando 1133334444" <7000>', src: '7000', dst: 's', dstchannel: 'PJSIP/IntekVox-1', billsec: 30 },
  ], os.tmpdir());
  assert.deepEqual([c2c.from, c2c.fromName, c2c.to], ['7000', '', '1133334444']);

  const internal = shapeRecording('int.wav', [
    { calldate: '2026-10-07 12:00:00', clid: '"Junior" <3602>', src: '3602', dst: '600', dstchannel: 'PJSIP/7000-00000011', billsec: 15 },
  ], os.tmpdir());
  assert.deepEqual([internal.fromName, internal.to, internal.answeredBy], ['Junior', '600', '7000']);
});

test('supervisor tem histórico e gravações de todos os ramais, mas não a gestão de usuários', async (t) => {
  const seen = [];
  const cdr = { history: async (ext) => { seen.push(ext); return { records: [], hasMore: false }; } };
  const recordings = { list: async () => ({ records: [], hasMore: false, total: 0 }), audioPath: async () => null };
  const { login, get } = await setup(t, { cdr, recordings });
  const sup = await login('super', 'secret1');

  assert.equal((await (await get('/api/history?extension=7000', sup)).json()).extension, '7000');
  assert.equal((await (await get('/api/history', sup)).json()).extension, '3602'); // sem escolher: o próprio ramal
  assert.equal((await get('/api/recordings', sup)).status, 200);
  assert.equal((await get('/api/recordings/audio?file=x.wav', sup)).status, 404);

  assert.equal((await get('/api/users', sup)).status, 403);
  const base = (await get('/api/me', sup)).url.replace('/api/me', '');
  const create = await fetch(`${base}/api/users`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sup },
    body: JSON.stringify({ name: 'X', username: 'xxx', password: 'secret1', extension: '3700', role: 'admin' }),
  });
  assert.equal(create.status, 403);
  assert.deepEqual(seen, ['7000', '3602']);
});
