'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const config = require('./config');
const { UserStore } = require('./users');
const { AmiPbx } = require('./pbx');
const { MockPbx } = require('./mock-pbx');
const { createApp } = require('./app');
const { MysqlCdr, MockCdr } = require('./cdr');
const { MysqlRecordings, MockRecordings } = require('./recordings');
const { sessionFromRequest } = require('./auth');
const { Sessions } = require('./sessions');
const { createSipProxy } = require('./sip-proxy');

const users = new UserStore(config.dataFile, { secret: config.sessionSecret });
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
let recordings = null;
if (config.mock) recordings = new MockRecordings(pbx);
else if (cdr) recordings = new MysqlRecordings(cdr, config.recordingsDir);
const sessions = new Sessions(users);
const app = createApp({ config, users, pbx, cdr, recordings, sessions });
// Lê o certificado com mensagem clara em caso de erro (caminho errado ou sem permissão)
function readTls(file, label) {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    console.error(`[https] não foi possível ler ${label} "${file}": ${err.code === 'EACCES'
      ? 'sem permissão (rode: chown -R switchboard:switchboard /opt/switchboard_issabel/certs)'
      : err.code === 'ENOENT' ? 'arquivo não encontrado' : err.message}`);
    process.exit(1);
  }
}
if (config.httpsPartial) console.warn('[https] defina HTTPS_CERT_FILE e HTTPS_KEY_FILE juntos no .env — HTTPS desativado');
const server = config.https
  ? https.createServer({ cert: readTls(config.https.certFile, 'o certificado (HTTPS_CERT_FILE)'), key: readTls(config.https.keyFile, 'a chave (HTTPS_KEY_FILE)') }, app)
  : http.createServer(app);
const sipProxy = createSipProxy({ config, users, sessionFromRequest });
if (config.webrtc.enabled) {
  console.log(`[webrtc] telefone no navegador habilitado (Asterisk em ${config.webrtc.asteriskWsUrl})`);
  if (!config.https) console.warn('[webrtc] HTTPS desativado (HTTPS_CERT_FILE/HTTPS_KEY_FILE ausentes no .env): o switchboard está em http:// e o navegador não libera o microfone');
}

// Atualizações em tempo real do painel
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  if (pathname === '/sip') return sipProxy.handleUpgrade(req, socket, head);
  if (pathname !== '/ws') return socket.destroy();
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
  const proto = config.https ? 'https' : 'http';
  console.log(`Switchboard Intek em ${proto}://${config.host}:${config.port} ${config.mock ? '(PABX simulado)' : ''}`);
});
