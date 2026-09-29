'use strict';

const fs = require('fs');
const path = require('path');

// Carrega um arquivo .env simples (CHAVE=valor), sem sobrescrever variáveis já definidas.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'));

const env = process.env;

module.exports = {
  port: Number(env.PORT || 8080),
  // 127.0.0.1 = só aceita conexões locais (use quando houver proxy HTTPS na frente)
  host: env.HOST || '0.0.0.0',
  sessionSecret: env.SESSION_SECRET || 'dev-secret-change-me',
  sessionTtlHours: Number(env.SESSION_TTL_HOURS || 12),
  dataFile: env.DATA_FILE || path.join(__dirname, '..', 'data', 'users.json'),

  mock: env.MOCK_PBX === '1' || env.MOCK_PBX === 'true',

  ami: {
    host: env.AMI_HOST || '127.0.0.1',
    port: Number(env.AMI_PORT || 5038),
    username: env.AMI_USER || 'admin',
    secret: env.AMI_SECRET || '',
  },

  // Banco de CDR do Issabel (histórico de ligações). Desativado se CDR_DB_HOST não for definido.
  cdrDb: env.CDR_DB_HOST
    ? {
        host: env.CDR_DB_HOST,
        port: Number(env.CDR_DB_PORT || 3306),
        user: env.CDR_DB_USER || 'switchboard',
        password: env.CDR_DB_PASSWORD || '',
        database: env.CDR_DB_NAME || 'asteriskcdrdb',
        table: env.CDR_DB_TABLE || 'cdr',
        socketPath: env.CDR_DB_SOCKET || undefined,
      }
    : null,

  channelTech: (env.CHANNEL_TECH || 'SIP').toUpperCase(),
  dialContext: env.DIAL_CONTEXT || 'from-internal',
  hintContext: env.HINT_CONTEXT || 'ext-local',
  originateTimeoutMs: Number(env.ORIGINATE_TIMEOUT_MS || 30000),

  admin: {
    username: env.ADMIN_USER || 'admin',
    password: env.ADMIN_PASSWORD || 'admin123',
  },
};
