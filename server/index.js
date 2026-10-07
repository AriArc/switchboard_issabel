'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const config = require('./config');
const { UserStore } = require('./users');
const { AmiPbx } = require('./pbx');
const { MockPbx } = require('./mock-pbx');
const { createApp } = require('./app');
const { MysqlCdr, MockCdr } = require('./cdr');
const { sessionFromRequest } = require('./auth');
const { Sessions } = require('./sessions');

const users = new UserStore(config.dataFile);
const admin = users.ensureAdmin(config.admin);
if (admin) console.log(`[users] administrador inicial criado: ${admin.username}`);
if (config.sessionSecret === 'dev-secret-change-me') {
  console.warn('[config] SESSION_SECRET não definido — use um valor próprio em produção');
}

const pbx = config.mock ? new MockPbx(config) : new AmiPbx(config);
let cdr = null;
if (config.mock) cdr = new MockCdr(pbx);
else if (config.cdrDb) cdr = new MysqlCdr(config.cdrDb);
else console.warn('[cdr] CDR_DB_HOST não definido — aba Histórico ficará indisponível');
const sessions = new Sessions(users);
const app = createApp({ config, users, pbx, cdr, sessions });
const server = http.createServer(app);

// Atualizações em tempo real do painel
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
  const session = sessionFromRequest(req, { secret: config.sessionSecret, users });
  if (!session) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.userId = session.user.id;
    ws.sid = session.sid;
    sessions.attach(session.sid, ws);
    ws.send(JSON.stringify({ type: 'state', data: pbx.snapshot() }));
  });
});

pbx.on('change', () => {
  const msg = JSON.stringify({ type: 'state', data: pbx.snapshot() });
  for (const ws of wss.clients) {
    // Derruba sessões de usuários desativados/excluídos
    const u = users.get(ws.userId);
    if (!u || !u.active || u.sessionId !== ws.sid) ws.close(4001, 'Sessão encerrada');
    else if (ws.readyState === ws.OPEN) ws.send(msg);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[http] a porta ${config.port} já está em uso por outro programa (veja: ss -ltnp | grep ${config.port})`);
  } else {
    console.error('[http]', err.message);
  }
  process.exit(1);
});

pbx.start();
server.listen(config.port, config.host, () => {
  console.log(`Switchboard Intek em http://${config.host}:${config.port} ${config.mock ? '(PABX simulado)' : ''}`);
});
