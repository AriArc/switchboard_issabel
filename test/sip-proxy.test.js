'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { WebSocketServer, WebSocket } = require('ws');
const { UserStore } = require('../server/users');
const { createApp } = require('../server/app');
const { createSipProxy, allowedFromBrowser } = require('../server/sip-proxy');
const { sessionFromRequest } = require('../server/auth');

const register = (user) => `REGISTER sip:pbx SIP/2.0\r\nVia: SIP/2.0/WSS x.invalid\r\nFrom: <sip:${user}@pbx>;tag=1\r\nTo: <sip:${user}@pbx>\r\nCall-ID: a\r\nCSeq: 1 REGISTER\r\n\r\n`;
const invite = (from, to) => `INVITE sip:${to}@pbx SIP/2.0\r\nFrom: "Fulano" <sip:${from}@pbx>;tag=1\r\nTo: <sip:${to}@pbx>\r\nCSeq: 1 INVITE\r\n\r\n`;

test('mensagens SIP do navegador só valem para o próprio ramal', () => {
  assert.equal(allowedFromBrowser(register('7000'), '7000'), true);
  assert.equal(allowedFromBrowser(register('3601'), '7000'), false);
  assert.equal(allowedFromBrowser(invite('7000', '1133334444'), '7000'), true);
  assert.equal(allowedFromBrowser(invite('3601', '1133334444'), '7000'), false);
  assert.equal(allowedFromBrowser('SIP/2.0 200 OK\r\nFrom: <sip:3601@pbx>\r\n\r\n', '7000'), true); // respostas seguem o diálogo
  assert.equal(allowedFromBrowser('BYE sip:x@pbx SIP/2.0\r\nFrom: <sip:3601@pbx>\r\n\r\n', '7000'), true);
});

test('repasse SIP: autenticação, perfil WebRTC e ramal', async (t) => {
  // Asterisk falso: ecoa as mensagens recebidas com prefixo
  const fake = new WebSocketServer({ port: 0, handleProtocols: () => 'sip' });
  await once(fake, 'listening');
  const received = [];
  fake.on('connection', (ws) => ws.on('message', (m) => { received.push(String(m)); ws.send(`ECO ${String(m).split('\r\n')[0]}`); }));

  const users = new UserStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')), 'users.json'), { secret: 's' });
  users.ensureAdmin({ username: 'admin', password: 'admin123' });
  users.create({ name: 'Rec', username: 'recepcao', password: 'secret1', extension: '7000', role: 'user', webrtc: true, sipPassword: 'senha7000' });
  users.create({ name: 'Jr', username: 'junior', password: 'secret1', extension: '3601', role: 'user' });
  const config = {
    sessionSecret: 's', sessionTtlHours: 1,
    webrtc: { enabled: true, asteriskWsUrl: `ws://127.0.0.1:${fake.address().port}/ws`, stun: [] },
  };
  const app = createApp({ config, users, pbx: { connected: true, snapshot: () => ({}), calls: () => [] } });
  const server = http.createServer(app);
  const proxy = createSipProxy({ config, users, sessionFromRequest });
  server.on('upgrade', (req, socket, head) => proxy.handleUpgrade(req, socket, head));
  server.listen(0);
  await once(server, 'listening');
  t.after(() => { server.close(); fake.close(); });
  const base = `127.0.0.1:${server.address().port}`;
  const login = async (u) => (await fetch(`http://${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: u === 'admin' ? 'admin123' : 'secret1' }),
  })).headers.get('set-cookie').split(';')[0];
  const connect = (cookie) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://${base}/sip`, 'sip', { headers: cookie ? { Cookie: cookie } : {} });
    ws.on('open', () => resolve({ ws }));
    ws.on('unexpected-response', (req, res) => resolve({ status: res.statusCode }));
  });

  assert.equal((await connect(null)).status, 401);
  assert.equal((await connect(await login('junior'))).status, 403); // sem WebRTC no cadastro

  const rec = await login('recepcao');
  const cfg = await (await fetch(`http://${base}/api/webrtc`, { headers: { Cookie: rec } })).json();
  assert.deepEqual([cfg.enabled, cfg.extension, cfg.password], [true, '7000', 'senha7000']);
  const jr = await (await fetch(`http://${base}/api/webrtc`, { headers: { Cookie: await login('admin') } })).json();
  assert.equal(jr.enabled, false);
  assert.equal(JSON.stringify(users.list()).includes('senha7000'), false); // senha não aparece na lista
  assert.equal(fs.readFileSync(users.file, 'utf8').includes('senha7000'), false); // nem em texto puro no arquivo

  const { ws } = await connect(rec);
  ws.send(register('7000'));
  const [reply] = await once(ws, 'message');
  assert.equal(String(reply), 'ECO REGISTER sip:pbx SIP/2.0');

  ws.send(register('3601')); // tentativa de registrar outro ramal
  const [code] = await once(ws, 'close');
  assert.equal(code, 4003);
  assert.equal(received.length, 1);
});

test('repasse SIP desligado quando WEBRTC_ENABLED não está ativo', async (t) => {
  const users = new UserStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')), 'users.json'));
  const config = { sessionSecret: 's', webrtc: { enabled: false } };
  const server = http.createServer();
  const proxy = createSipProxy({ config, users, sessionFromRequest });
  server.on('upgrade', (req, socket, head) => proxy.handleUpgrade(req, socket, head));
  server.listen(0);
  await once(server, 'listening');
  t.after(() => server.close());
  const status = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/sip`, 'sip');
    ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
    ws.on('open', () => resolve('aberto'));
  });
  assert.equal(status, 404);
});
