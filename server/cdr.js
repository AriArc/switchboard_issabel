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

function channelOf(channel, ext) {
  return new RegExp(`^(?:SIP|PJSIP|IAX2)/${ext}-`, 'i').test(channel || '');
}

function statusOf(direction, disposition) {
  if (disposition === 'ANSWERED') return 'answered';
  if (direction === 'in') return 'missed';
  if (disposition === 'BUSY') return 'busy';
  if (disposition === 'FAILED' || disposition === 'CONGESTION') return 'failed';
  return 'noanswer';
}

/** Converte linhas do CDR em registros do ponto de vista do ramal. */
function shapeRecords(rows, ext) {
  const byCall = new Map();
  for (const r of rows) {
    const direction = channelOf(r.channel, ext) ? 'out' : 'in';
    const record = {
      id: `${r.uniqueid}:${direction}`,
      calldate: String(r.calldate),
      direction,
      peer: direction === 'out' ? String(r.dst || '') : String(r.src || ''),
      peerName: direction === 'in' ? clidName(r.clid) : '',
      status: statusOf(direction, r.disposition),
      duration: Number(r.duration) || 0,
      billsec: Number(r.billsec) || 0,
    };
    // Grupos de toque/filas podem gerar várias linhas por chamada: fica a atendida
    const prev = byCall.get(record.id);
    if (!prev || (prev.status !== 'answered' && record.status === 'answered')) byCall.set(record.id, record);
  }
  return [...byCall.values()];
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
  }

  async history(extension, query) {
    const { days, direction, search, limit, offset } = normalizeQuery(query);
    const pats = [`SIP/${extension}-%`, `PJSIP/${extension}-%`];
    const isOut = '(channel LIKE ? OR channel LIKE ?)';
    const isIn = '(dstchannel LIKE ? OR dstchannel LIKE ?)';

    const where = ['calldate >= DATE_SUB(CURDATE(), INTERVAL ? DAY)'];
    const params = [days];
    if (direction === 'out') {
      where.push(isOut);
      params.push(...pats);
    } else if (direction === 'in' || direction === 'missed') {
      where.push(isIn, `NOT ${isOut}`);
      params.push(...pats, ...pats);
      if (direction === 'missed') {
        // Descarta chamadas que o ramal atendeu em outra linha (grupos de toque/filas geram várias)
        where.push(`disposition <> 'ANSWERED' AND NOT EXISTS (
          SELECT 1 FROM \`${this.table}\` a
          WHERE a.uniqueid = c.uniqueid AND a.disposition = 'ANSWERED'
            AND a.calldate BETWEEN c.calldate - INTERVAL 1 HOUR AND c.calldate + INTERVAL 1 HOUR
            AND (a.dstchannel LIKE ? OR a.dstchannel LIKE ?))`);
        params.push(...pats);
      }
    } else {
      where.push(`(${isOut} OR ${isIn})`);
      params.push(...pats, ...pats);
    }
    if (search) {
      const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push('(src LIKE ? OR dst LIKE ? OR clid LIKE ?)');
      params.push(like, like, like);
    }

    const sql = `SELECT calldate, clid, src, dst, channel, dstchannel, disposition, duration, billsec, uniqueid
      FROM \`${this.table}\` c WHERE ${where.join(' AND ')}
      ORDER BY calldate DESC LIMIT ? OFFSET ?`;
    const [rows] = await this.pool.query(sql, [...params, limit + 1, offset]);
    const hasMore = rows.length > limit;
    const result = { records: shapeRecords(rows.slice(0, limit), extension), hasMore };
    if (offset === 0) result.summary = await this._summary(pats, days);
    return result;
  }

  // Totais do período (independentes do filtro de tipo e da paginação)
  async _summary(pats, days) {
    const sql = `SELECT
        COALESCE(SUM(dir = 'out'), 0) AS outCount,
        COALESCE(SUM(dir = 'in'), 0) AS inCount,
        COALESCE(SUM(dir = 'in' AND ans = 0), 0) AS missedCount
      FROM (
        SELECT uniqueid, IF(channel LIKE ? OR channel LIKE ?, 'out', 'in') AS dir,
               MAX(disposition = 'ANSWERED') AS ans
        FROM \`${this.table}\`
        WHERE calldate >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
          AND (channel LIKE ? OR channel LIKE ? OR dstchannel LIKE ? OR dstchannel LIKE ?)
        GROUP BY uniqueid, dir
      ) t`;
    const [[row]] = await this.pool.query(sql, [...pats, days, ...pats, ...pats]);
    return summaryOf(Number(row.inCount), Number(row.outCount), Number(row.missedCount));
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

module.exports = { MysqlCdr, MockCdr, shapeRecords, normalizeQuery, clidName };
