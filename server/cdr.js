'use strict';

/**
 * Histórico de ligações (CDR) de um ramal.
 *
 * - MysqlCdr: lê a tabela `cdr` do banco `asteriskcdrdb` do Issabel.
 * - MockCdr: histórico gerado para o modo de demonstração (MOCK_PBX=1).
 *
 * Ambos expõem history(extension, { days, direction, search, limit, offset })
 * e devolvem { records, hasMore }.
 */

const DIRECTIONS = ['all', 'in', 'out', 'missed'];

// "Fulano" <1199999> -> Fulano
function clidName(clid) {
  const m = /^"?([^"<]*?)"?\s*<[^>]*>$/.exec(String(clid || '').trim());
  return m ? m[1].trim() : '';
}

// Um número "discável" (descarta 's', 'h' e outros nomes internos do Asterisk)
function dialable(value, ext) {
  return /^\+?[0-9*#]{2,}$/.test(String(value || '')) && String(value) !== ext;
}

/**
 * Regras para reconhecer as linhas do CDR de um ramal. As mesmas regras são usadas no SQL
 * (filtro, paginação e totais) e em shapeCalls (montagem dos registros exibidos).
 *
 * - Realizada: o canal de origem é o aparelho do ramal (PJSIP/<ramal>-…).
 * - Recebida: o destino é o aparelho, o ramal via siga-me/fila (Local/FMPR-<ramal>@…, Local/<ramal>@…)
 *   ou o número discado foi o próprio ramal (dst = <ramal>), o que cobre siga-me para celular.
 * - Atendida: só conta se houve conversa (billsec > 0); o siga-me marca ANSWERED com 0 s.
 */
function rowMatchers(ext) {
  const dev = new RegExp(`^(?:SIP|PJSIP|IAX2)/${ext}-`, 'i');
  const self = new RegExp(`^Local/(?:FMPR-)?${ext}@`, 'i');
  const isOutDev = (r) => dev.test(r.channel || '');
  const isIn = (r) => !isOutDev(r) && (dev.test(r.dstchannel || '') || self.test(r.dstchannel || '') || String(r.dst) === ext);
  const talked = (r) => r.disposition === 'ANSWERED' && Number(r.billsec) > 0;
  const onOwnPhone = (r) => dev.test(r.dstchannel || '') || self.test(r.dstchannel || '');
  return { dev, isOutDev, isIn, talked, onOwnPhone };
}

function outStatus(rows, talked) {
  if (rows.some(talked)) return 'answered';
  const d = rows.map((r) => r.disposition);
  if (d.includes('BUSY')) return 'busy';
  if (d.includes('FAILED') || d.includes('CONGESTION')) return 'failed';
  return 'noanswer';
}

/**
 * Junta as linhas de uma mesma ligação (mesmo linkedid/uniqueid, coluna `k`) em um registro
 * do ponto de vista do ramal. Mantém a ordem de chegada das chaves.
 */
function shapeCalls(rows, ext) {
  const m = rowMatchers(ext);
  const groups = new Map();
  for (const r of rows) {
    const key = r.k || r.linkedid || r.uniqueid;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const records = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => String(a.calldate).localeCompare(String(b.calldate)));
    const outRows = list.filter(m.isOutDev);
    const inRows = list.filter(m.isIn);
    const realOut = outRows.filter((r) => dialable(r.dst, ext));
    const direction = realOut.length ? 'out' : inRows.length ? 'in' : 'out';
    const rel = direction === 'out' ? outRows : inRows;
    if (!rel.length) continue;

    let peer = '';
    let peerName = '';
    let status;
    let forwarded = false;
    if (direction === 'out') {
      peer = String(realOut[0].dst);
      status = outStatus(outRows, m.talked);
    } else {
      const from = inRows.find((r) => dialable(r.src, ext)) || inRows[0];
      peer = String(from.src || '');
      const name = clidName(from.clid);
      peerName = name && name !== peer ? name : '';
      const answered = inRows.filter(m.talked);
      status = answered.length ? 'answered' : 'missed';
      // Atendida, mas não no aparelho do ramal: siga-me para celular ou desvio
      forwarded = answered.length > 0 && !answered.some(m.onOwnPhone);
    }
    records.push({
      id: String(key),
      calldate: String(list[0].calldate),
      direction,
      peer,
      peerName,
      status,
      forwarded,
      duration: Math.max(...rel.map((r) => Number(r.duration) || 0)),
      billsec: Math.max(0, ...rel.filter(m.talked).map((r) => Number(r.billsec) || 0)),
    });
  }
  return records;
}

function summaryOf(inCount, outCount, missed) {
  return { total: inCount + outCount, in: inCount, out: outCount, missed };
}

function normalizeQuery(q = {}) {
  const days = Math.min(Math.max(parseInt(q.days, 10) || 0, 0), 365);
  const direction = DIRECTIONS.includes(q.direction) ? q.direction : 'all';
  const search = String(q.search || '').trim().slice(0, 40);
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
  return { days, direction, search, limit, offset };
}

class MysqlCdr {
  constructor(dbConfig) {
    // Carregado sob demanda para não exigir o driver em modo simulado
    const mysql = require('mysql2/promise');
    this.pool = mysql.createPool({
      host: dbConfig.host,
      port: dbConfig.port,
      socketPath: dbConfig.socketPath,
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
      connectionLimit: 4,
      dateStrings: true,
    });
    if (!/^\w+$/.test(dbConfig.table)) throw new Error('CDR_DB_TABLE inválido');
    this.table = dbConfig.table;
    this.dbConfig = { ...dbConfig, password: undefined };
  }

  // Agrupa por linkedid quando a tabela tem essa coluna (Issabel 5 / FreePBX); senão, por uniqueid
  async _keyExpr() {
    if (!this.keyExpr) {
      const [cols] = await this.pool.query(`SHOW COLUMNS FROM \`${this.table}\` LIKE 'linkedid'`);
      this.keyExpr = cols.length ? "COALESCE(NULLIF(linkedid, ''), uniqueid)" : 'uniqueid';
    }
    return this.keyExpr;
  }

  /**
   * Subconsulta com uma linha por ligação do ramal no período e as marcações usadas para filtrar:
   * o = realizada para um número válido, i = recebida, ia = recebida e atendida, s = casa com a busca.
   */
  _groupedSql(key, ext, days, search) {
    const dev = [`SIP/${ext}-%`, `PJSIP/${ext}-%`];
    const self = [`Local/FMPR-${ext}@%`, `Local/${ext}@%`];
    const od = '(channel LIKE ? OR channel LIKE ?)';
    const im = `(NOT ${od} AND (dstchannel LIKE ? OR dstchannel LIKE ? OR dstchannel LIKE ? OR dstchannel LIKE ? OR dst = ?))`;
    const like = search ? `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const sql = `SELECT k, MIN(calldate) AS t, MAX(o) AS o, MAX(i) AS i, MAX(i AND tk) AS ia, MAX(sm) AS s FROM (
        SELECT ${key} AS k, calldate,
          (${od} AND dst REGEXP '^[+]?[0-9*#]{2,}$' AND dst <> ?) AS o,
          ${im} AS i,
          (disposition = 'ANSWERED' AND billsec > 0) AS tk,
          ${like ? '(src LIKE ? OR dst LIKE ? OR clid LIKE ?)' : '1'} AS sm
        FROM \`${this.table}\`
        WHERE calldate >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
          AND (channel LIKE ? OR channel LIKE ? OR dstchannel LIKE ? OR dstchannel LIKE ?
               OR dstchannel LIKE ? OR dstchannel LIKE ? OR dst = ?)
      ) r GROUP BY k`;
    const params = [
      ...dev, ext,
      ...dev, ...dev, ...self, ext,
      ...(like ? [like, like, like] : []),
      days,
      ...dev, ...dev, ...self, ext,
    ];
    return { sql, params };
  }

  async history(extension, query) {
    const { days, direction, search, limit, offset } = normalizeQuery(query);
    const key = await this._keyExpr();
    const g = this._groupedSql(key, extension, days, search);

    const filters = {
      all: '1',
      out: '(o = 1 OR i = 0)',
      in: '(o = 0 AND i = 1)',
      missed: '(o = 0 AND i = 1 AND ia = 0)',
    };
    const [keys] = await this.pool.query(
      `SELECT k, t FROM (${g.sql}) g WHERE s = 1 AND ${filters[direction]} ORDER BY t DESC LIMIT ? OFFSET ?`,
      [...g.params, limit + 1, offset]
    );
    const hasMore = keys.length > limit;
    const page = keys.slice(0, limit);

    let records = [];
    if (page.length) {
      // Busca todas as linhas das ligações da página (com margem de datas para usar o índice de calldate)
      const ts = page.map((r) => String(r.t)).sort();
      const [rows] = await this.pool.query(
        `SELECT ${key} AS k, calldate, clid, src, dst, channel, dstchannel, disposition, duration, billsec, uniqueid
         FROM \`${this.table}\`
         WHERE calldate BETWEEN ? - INTERVAL 1 DAY AND ? + INTERVAL 1 DAY AND ${key} IN (?)`,
        [ts[0], ts[ts.length - 1], page.map((r) => r.k)]
      );
      const byKey = new Map(shapeCalls(rows, extension).map((r) => [r.id, r]));
      records = page.map((r) => byKey.get(String(r.k))).filter(Boolean);
    }

    const result = { records, hasMore };
    if (offset === 0) {
      const t = this._groupedSql(key, extension, days, '');
      const [[row]] = await this.pool.query(
        `SELECT COALESCE(SUM(o = 1 OR i = 0), 0) AS outCount,
                COALESCE(SUM(o = 0 AND i = 1), 0) AS inCount,
                COALESCE(SUM(o = 0 AND i = 1 AND ia = 0), 0) AS missedCount
         FROM (${t.sql}) g`,
        t.params
      );
      result.summary = summaryOf(Number(row.inCount), Number(row.outCount), Number(row.missedCount));
    }
    return result;
  }
}

/** Histórico fictício e determinístico por ramal, para demonstração. */
class MockCdr {
  constructor(pbx) {
    this.pbx = pbx;
    this.cache = new Map();
  }

  _generate(ext) {
    let seed = Number(ext) || 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const others = [...this.pbx.extensions.keys()].filter((e) => e !== ext);
    const records = [];
    let t = Date.now() - 20 * 60000;
    for (let i = 0; i < 90; i++) {
      t -= (10 + rand() * 480) * 60000;
      const direction = rand() < 0.55 ? 'in' : 'out';
      const internal = rand() < 0.35 && others.length;
      const peer = internal
        ? others[Math.floor(rand() * others.length)]
        : `11${Math.floor(30000000 + rand() * 69999999)}`;
      const r = rand();
      const status = r < 0.72 ? 'answered' : direction === 'in' ? 'missed' : r < 0.85 ? 'noanswer' : 'busy';
      const billsec = status === 'answered' ? Math.floor(15 + rand() * 600) : 0;
      const d = new Date(t);
      const pad = (n) => String(n).padStart(2, '0');
      records.push({
        id: `mock-${ext}-${i}`,
        calldate: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
        ts: t,
        direction,
        peer,
        peerName: direction === 'in' && !internal && rand() < 0.3 ? 'Cliente' : '',
        status,
        duration: billsec + Math.floor(3 + rand() * 20),
        billsec,
      });
    }
    return records;
  }

  async history(extension, query) {
    const { days, direction, search, limit, offset } = normalizeQuery(query);
    if (!this.cache.has(extension)) this.cache.set(extension, this._generate(extension));
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - days);
    const list = this.cache.get(extension).filter((r) =>
      r.ts >= start.getTime() &&
      (direction === 'all' || (direction === 'missed' ? r.status === 'missed' : r.direction === direction)) &&
      (!search || r.peer.includes(search) || r.peerName.toLowerCase().includes(search.toLowerCase()))
    );
    const page = list.slice(offset, offset + limit).map(({ ts, ...r }) => r);
    const result = { records: page, hasMore: list.length > offset + limit };
    if (offset === 0) {
      const period = this.cache.get(extension).filter((r) => r.ts >= start.getTime());
      result.summary = summaryOf(
        period.filter((r) => r.direction === 'in').length,
        period.filter((r) => r.direction === 'out').length,
        period.filter((r) => r.status === 'missed').length
      );
    }
    return result;
  }
}

/** Traduz erros de conexão/consulta ao MariaDB em uma causa legível (sem expor senhas). */
function describeCdrError(err, db = {}) {
  const where = db.socketPath ? `socket ${db.socketPath}` : `${db.host}:${db.port}`;
  const user = `'${db.user}'`;
  switch (err && err.code) {
    case 'ER_ACCESS_DENIED_ERROR':
      return `acesso negado para o usuário ${user} — confira CDR_DB_USER/CDR_DB_PASSWORD e o host do usuário no MariaDB ('127.0.0.1' via TCP ou 'localhost' via socket)`;
    case 'ER_HOST_NOT_PRIVILEGED':
      return `o MariaDB não aceita o usuário ${user} a partir deste host — crie o usuário para '127.0.0.1'`;
    case 'ER_DBACCESS_DENIED_ERROR':
    case 'ER_TABLEACCESS_DENIED_ERROR':
    case 'ER_COLUMNACCESS_DENIED_ERROR':
      return `o usuário ${user} não tem permissão de leitura — falta: GRANT SELECT ON ${db.database}.${db.table} TO ...`;
    case 'ER_BAD_DB_ERROR':
      return `o banco '${db.database}' não existe — confira CDR_DB_NAME`;
    case 'ER_NO_SUCH_TABLE':
      return `a tabela '${db.database}.${db.table}' não existe — confira CDR_DB_TABLE`;
    case 'ER_BAD_FIELD_ERROR':
      return `a tabela de CDR não tem uma coluna esperada (${err.sqlMessage || err.message})`;
    case 'ECONNREFUSED':
      return `o MariaDB recusou a conexão em ${where} — ele pode estar sem TCP (skip-networking); use CDR_DB_SOCKET=/var/lib/mysql/mysql.sock`;
    case 'ENOENT':
      return `socket do MariaDB não encontrado em ${db.socketPath} — confira CDR_DB_SOCKET`;
    case 'ETIMEDOUT':
    case 'ENOTFOUND':
    case 'EHOSTUNREACH':
      return `não foi possível alcançar o MariaDB em ${where} (${err.code})`;
    default:
      return `${(err && err.code) || 'erro'}: ${(err && (err.sqlMessage || err.message)) || 'desconhecido'}`;
  }
}

module.exports = { MysqlCdr, describeCdrError, MockCdr, shapeCalls, normalizeQuery, clidName };
