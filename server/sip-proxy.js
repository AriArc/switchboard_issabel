'use strict';

const { WebSocketServer, WebSocket } = require('ws');

/**
 * Repasse do SIP sobre WebSocket entre o navegador (JsSIP) e o Asterisk.
 *
 * O navegador conecta em wss://<switchboard>/sip (mesma porta e certificado do switchboard) e o
 * switchboard abre a conexão com o WebSocket do Asterisk na própria máquina (ws://127.0.0.1:8088/ws).
 * Só usuários logados, com WebRTC habilitado, entram, e só registram/ligam como o próprio ramal.
 */

// Usuário SIP de um cabeçalho (To/From) da mensagem: "To: <sip:7000@host>" -> "7000"
function headerUser(msg, names) {
  const re = new RegExp(`^(?:${names.join('|')})\\s*:.*?sips?:([^@;>\\s]+)@`, 'im');
  const m = re.exec(msg);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Mensagem SIP vinda do navegador está de acordo com o ramal do usuário? */
function allowedFromBrowser(msg, extension) {
  const method = /^([A-Z]+) sips?:/.exec(msg);
  if (!method) return true; // respostas (SIP/2.0 200 OK…) seguem o diálogo já existente
  if (method[1] === 'REGISTER') return headerUser(msg, ['To', 't']) === extension;
  if (method[1] === 'INVITE' || method[1] === 'MESSAGE' || method[1] === 'SUBSCRIBE') {
    return headerUser(msg, ['From', 'f']) === extension;
  }
  return true;
}

function createSipProxy({ config, users, sessionFromRequest }) {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has('sip') ? 'sip' : false) });

  function handleUpgrade(req, socket, head) {
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\n\r\n`);
      socket.destroy();
    };
    if (!config.webrtc.enabled) return reject(404, 'Not Found');
    const session = sessionFromRequest(req, { secret: config.sessionSecret, users });
    if (!session) return reject(401, 'Unauthorized');
    const { user } = session;
    if (!user.webrtc || !user.extension) return reject(403, 'Forbidden');

    wss.handleUpgrade(req, socket, head, (browser) => {
      const asterisk = new WebSocket(config.webrtc.asteriskWsUrl, 'sip');
      const pending = [];
      const closeBoth = () => {
        if (browser.readyState <= WebSocket.OPEN) browser.close();
        if (asterisk.readyState <= WebSocket.OPEN) asterisk.terminate();
      };

      browser.on('message', (data, isBinary) => {
        const msg = data.toString();
        if (!allowedFromBrowser(msg, user.extension)) {
          console.warn(`[sip] mensagem recusada de ${user.username}: não corresponde ao ramal ${user.extension}`);
          return browser.close(4003, 'Ramal não autorizado');
        }
        if (asterisk.readyState === WebSocket.OPEN) asterisk.send(msg, { binary: isBinary });
        else pending.push(msg);
      });
      asterisk.on('open', () => {
        for (const m of pending.splice(0)) asterisk.send(m);
      });
      asterisk.on('message', (data, isBinary) => {
        if (browser.readyState === WebSocket.OPEN) browser.send(data.toString(), { binary: isBinary });
      });
      asterisk.on('error', (err) => {
        console.error(`[sip] erro no WebSocket do Asterisk (${config.webrtc.asteriskWsUrl}): ${err.message}`);
        closeBoth();
      });
      asterisk.on('close', closeBoth);
      browser.on('close', closeBoth);
      browser.on('error', closeBoth);
    });
  }

  return { handleUpgrade };
}

module.exports = { createSipProxy, allowedFromBrowser, headerUser };
