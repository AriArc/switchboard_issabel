'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { AmiPbx } = require('../server/pbx');
const { UserStore } = require('../server/users');
const { createApp } = require('../server/app');

// Servidor AMI falso: responde ao essencial e registra as ações recebidas
function fakeAmi() {
  const actions = [];
  const server = net.createServer((sock) => {
    sock.write('Asterisk Call Manager/5.0.1\r\n');
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n\r\n')) !== -1) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 4);
        const msg = {};
        for (const line of raw.split('\r\n')) {
          const [k, ...v] = line.split(':');
          const key = k.trim();
          const val = v.join(':').trim();
          if (msg[key] !== undefined) msg[key] = [].concat(msg[key], val);
          else msg[key] = val;
        }
        actions.push(msg);
        const id = msg.ActionID;
        const send = (lines) => sock.write(lines.join('\r\n') + '\r\n\r\n');
        switch (msg.Action) {
          case 'ExtensionStateList':
            send(['Response: Success', `ActionID: ${id}`, 'EventList: start']);
            send(['Event: ExtensionStatus', `ActionID: ${id}`, 'Exten: 1001', 'Context: ext-local', 'Status: 0']);
            send(['Event: ExtensionStatus', `ActionID: ${id}`, 'Exten: 1002', 'Context: ext-local', 'Status: 0']);
            send(['Event: ExtensionStateListComplete', `ActionID: ${id}`, 'EventList: Complete']);
            break;
          case 'CoreShowChannels':
            send(['Response: Success', `ActionID: ${id}`, 'EventList: start']);
            send(['Event: CoreShowChannelsComplete', `ActionID: ${id}`, 'EventList: Complete']);
            break;
          case 'Command':
            send(['Response: Success', `ActionID: ${id}`, 'Message: Command output follows',
              'Output: /AMPUSER/1001/cidname                             : Ana Souza',
              'Output: /AMPUSER/1002/cidname                             : Bruno Lima']);
            break;
          default:
            send(['Response: Success', `ActionID: ${id}`, 'Message: OK']);
        }
      }
    });
  });
  return { server, actions };
}

test('click-to-call usa o ramal cadastrado do usuário', async (t) => {
  const { server, actions } = fakeAmi();
  server.listen(0);
  await once(server, 'listening');

  const config = {
    sessionSecret: 'test', sessionTtlHours: 1,
    ami: { host: '127.0.0.1', port: server.address().port, username: 'u', secret: 's' },
    channelTech: 'PJSIP', dialContext: 'from-internal', hintContext: 'ext-local', originateTimeoutMs: 30000,
  };
  const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')), 'users.json');
  const users = new UserStore(dataFile);
  users.ensureAdmin({ username: 'admin', password: 'admin123' });
  users.create({ name: 'Bruno', username: 'bruno', password: 'secret1', extension: '1002', role: 'user' });

  const pbx = new AmiPbx(config);
  pbx.start();
  await once(pbx, 'change');
  assert.equal(pbx.snapshot().extensions.find((e) => e.exten === '1002').name, 'Bruno Lima');

  const http = createApp({ config, users, pbx }).listen(0);
  await once(http, 'listening');
  const base = `http://127.0.0.1:${http.address().port}`;
  t.after(() => { http.close(); pbx.ami.stop(); clearInterval(pbx._refreshTimer); server.close(); });

  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'bruno', password: 'secret1' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  // Mesmo tentando forçar outro ramal no corpo, o servidor usa o ramal do cadastro
  const res = await fetch(`${base}/api/call`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ number: '(11) 99999-0000', extension: '1001' }),
  });
  assert.equal(res.status, 200);
  const originate = actions.find((a) => a.Action === 'Originate');
  assert.equal(originate.Channel, 'PJSIP/1002');
  assert.equal(originate.Exten, '11999990000');
  assert.equal(originate.Context, 'from-internal');
  assert.match(originate.CallerID, /<1002>$/);

  const bad = await fetch(`${base}/api/call`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ number: '123;Hangup' }),
  });
  assert.equal(bad.status, 400);

  const anon = await fetch(`${base}/api/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(anon.status, 401);

  const forbidden = await fetch(`${base}/api/users`, { headers: { Cookie: cookie } });
  assert.equal(forbidden.status, 403);
});

test('cadastro exige ramal único para usuários', () => {
  const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')), 'users.json');
  const users = new UserStore(dataFile);
  users.ensureAdmin({ username: 'admin', password: 'admin123' });
  assert.throws(() => users.create({ name: 'X', username: 'xx1', password: 'secret1', role: 'user' }), /Ramal discador é obrigatório/);
  users.create({ name: 'A', username: 'aaa', password: 'secret1', extension: '2001', role: 'user' });
  assert.throws(() => users.create({ name: 'B', username: 'bbb', password: 'secret1', extension: '2001', role: 'user' }), /já está associado/);
});
