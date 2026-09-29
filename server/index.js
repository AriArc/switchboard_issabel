'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const config = require('./config');
const { UserStore } = require('./users');
const { AmiPbx } = require('./pbx');
const { MockPbx } = require('./mock-pbx');
const { createApp } = require('./app');
const { userFromRequest } = require('./auth');

const users = new UserStore(config.dataFile);
const admin = users.ensureAdmin(config.admin);
if (admin) console.log(`[users] administrador inicial criado: ${admin.username}`);
if (config.sessionSecret === 'dev-secret-change-me') {
  console.warn('[config] SESSION_SECRET não definido — use um valor próprio em produção');
}

const pbx = config.mock ? new MockPbx(config) : new AmiPbx(config);
const app = createApp({ config, users, pbx });
const server = http.createServer(app);

// Atualizações em tempo real do painel
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
  const user = userFromRequest(req, { secret: config.sessionSecret, users });
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.userId = user.id;
    ws.send(JSON.stringify({ type: 'state', data: pbx.snapshot() }));
  });
});

pbx.on('change', () => {
  const msg = JSON.stringify({ type: 'state', data: pbx.snapshot() });
  for (const ws of wss.clients) {
    // Derruba sessões de usuários desativados/excluídos
    const u = users.get(ws.userId);
    if (!u || !u.active) ws.close(4001, 'Sessão encerrada');
    else if (ws.readyState === ws.OPEN) ws.send(msg);
  }
});

pbx.start();
server.listen(config.port, () => {
  console.log(`Switchboard Intek em http://localhost:${config.port} ${config.mock ? '(PABX simulado)' : ''}`);
});
