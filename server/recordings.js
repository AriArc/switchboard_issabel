'use strict';

const fs = require('fs');
const path = require('path');
const { clidName, dialable, outPeerFallback } = require('./cdr');

/**
 * Gravações de ligações do Issabel.
 *
 * O nome do arquivo fica na coluna `recordingfile` do CDR (ex.: exten-7000-3602-20261007-094146-1791376906.822.wav)
 * e o áudio em <RECORDINGS_DIR>/AAAA/MM/DD/<arquivo>. Só são servidos arquivos citados no CDR,
 * sempre dentro de RECORDINGS_DIR.
 */

const AUDIO_TYPES = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.gsm': 'audio/x-gsm' };
const FILE_RE = /^[\w.\-]+$/;

function normalizeQuery(q = {}) {
  const days = Math.min(Math.max(parseInt(q.days, 10) || 0, 0), 365);
  const extension = /^\d{2,8}$/.test(String(q.extension || '')) ? String(q.extension) : '';
  const search = String(q.search || '').trim().slice(0, 40);
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
  return { days, extension, search, limit, offset };
}

/** Caminho do arquivo de áudio no disco (ou null se não existir / estiver fora do diretório). */
function resolveRecording(dir, recordingfile, calldate) {
  const root = path.resolve(dir);
  const inside = (p) => p === root || p.startsWith(root + path.sep);
  const name = String(recordingfile || '');
  const candidates = [];
  if (path.isAbsolute(name)) {
    candidates.push(path.resolve(name));
  } else if (name.includes('/')) {
    // Caminho relativo com subpastas (ex.: 2026/09/29/arquivo.wav): sempre dentro do diretório
    if (!name.split('/').every((part) => FILE_RE.test(part) && part !== '..' && part !== '.')) return null;
    candidates.push(path.resolve(root, name));
  } else {
    if (!FILE_RE.test(name)) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(calldate || ''));
    if (m) candidates.push(path.join(root, m[1], m[2], m[3], name));
    candidates.push(path.join(root, name));
  }
  for (const c of candidates) {
    // Alguns registros não trazem a extensão do arquivo
    const options = path.extname(c) ? [c] : Object.keys(AUDIO_TYPES).flatMap((e) => [c + e, c + e.toUpperCase()]);
    for (const p of options) {
      if (inside(p) && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    }
  }
  return null;
}

function audioType(file) {
  return AUDIO_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/** Monta um item da lista a partir das linhas do CDR de uma gravação. */
function shapeRecording(file, rows, dir) {
  rows.sort((a, b) => String(a.calldate).localeCompare(String(b.calldate)));
  const first = rows[0];
  const best = rows.reduce((a, b) => ((Number(b.billsec) || 0) > (Number(a.billsec) || 0) ? b : a), first);
  const from = String(first.src || '');
  const name = clidName(first.clid);
  let to = dialable(best.dst, from) ? String(best.dst) : outPeerFallback(rows, from);
  if (!to) to = String(best.dst || '');
  // Quem atendeu (ramal do canal de destino), quando diferente do número discado
  const ans = /^(?:SIP|PJSIP|IAX2)\/(\d{2,})-/i.exec(best.dstchannel || '');
  const audio = resolveRecording(dir, file, first.calldate);
  return {
    file,
    calldate: String(first.calldate),
    from,
    fromName: name && name !== from && !/^Chamando\s/i.test(name) ? name : '',
    to,
    answeredBy: ans && ans[1] !== to ? ans[1] : '',
    billsec: Number(best.billsec) || 0,
    available: Boolean(audio),
    type: audio ? audioType(audio) : '',
  };
}

class MysqlRecordings {
  constructor(cdr, dir) {
    this.cdr = cdr; // MysqlCdr (reaproveita o pool de conexões)
    this.dir = dir;
  }

  _where(q) {
    const where = ["calldate >= DATE_SUB(CURDATE(), INTERVAL ? DAY)", "recordingfile <> ''"];
    const params = [q.days];
    if (q.extension) {
      const e = q.extension;
      where.push(`(src = ? OR dst = ? OR channel LIKE ? OR channel LIKE ? OR dstchannel LIKE ? OR dstchannel LIKE ?
                   OR dstchannel LIKE ? OR dstchannel LIKE ?)`);
      params.push(e, e, `SIP/${e}-%`, `PJSIP/${e}-%`, `SIP/${e}-%`, `PJSIP/${e}-%`, `Local/FMPR-${e}@%`, `Local/${e}@%`);
    }
    if (q.search) {
      const like = `%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push('(src LIKE ? OR dst LIKE ? OR clid LIKE ? OR recordingfile LIKE ?)');
      params.push(like, like, like, like);
    }
    return { where: where.join(' AND '), params };
  }

  async list(query) {
    const q = normalizeQuery(query);
    const { pool, table } = this.cdr;
    const w = this._where(q);
    // Só ligações com conversa (billsec > 0): sem conversa não há áudio gravado
    const grouped = `SELECT recordingfile AS f, MIN(calldate) AS t FROM \`${table}\` WHERE ${w.where}
      GROUP BY recordingfile HAVING MAX(billsec) > 0`;
    const [keys] = await pool.query(`${grouped} ORDER BY t DESC LIMIT ? OFFSET ?`, [...w.params, q.limit + 1, q.offset]);
    const hasMore = keys.length > q.limit;
    const page = keys.slice(0, q.limit);

    let records = [];
    if (page.length) {
      const ts = page.map((r) => String(r.t)).sort();
      const [rows] = await pool.query(
        `SELECT calldate, clid, src, dst, channel, dstchannel, lastdata, disposition, billsec, recordingfile
         FROM \`${table}\`
         WHERE calldate BETWEEN ? - INTERVAL 1 DAY AND ? + INTERVAL 1 DAY AND recordingfile IN (?)`,
        [ts[0], ts[ts.length - 1], page.map((r) => r.f)]
      );
      const byFile = new Map();
      for (const r of rows) {
        if (!byFile.has(r.recordingfile)) byFile.set(r.recordingfile, []);
        byFile.get(r.recordingfile).push(r);
      }
      records = page.filter((r) => byFile.has(r.f)).map((r) => shapeRecording(r.f, byFile.get(r.f), this.dir));
    }
    const result = { records, hasMore };
    if (q.offset === 0) {
      const [[c]] = await pool.query(`SELECT COUNT(*) AS n FROM (${grouped}) g`, w.params);
      result.total = Number(c.n);
    }
    return result;
  }

  /** Caminho do áudio de uma gravação citada no CDR (null se não existir). */
  async audioPath(file) {
    if (!file || String(file).length > 255) return null;
    const { pool, table } = this.cdr;
    const [rows] = await pool.query(
      `SELECT calldate FROM \`${table}\` WHERE recordingfile = ? ORDER BY calldate LIMIT 1`, [file]);
    return rows.length ? resolveRecording(this.dir, file, rows[0].calldate) : null;
  }
}

/** Gravações fictícias para o modo de demonstração (MOCK_PBX=1), com um áudio de tom gerado. */
class MockRecordings {
  constructor(pbx) {
    this.pbx = pbx;
    this.items = null;
  }

  _generate() {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const exts = [...this.pbx.extensions.keys()];
    const pad = (n) => String(n).padStart(2, '0');
    const items = [];
    let t = Date.now() - 15 * 60000;
    for (let i = 0; i < 60; i++) {
      t -= (20 + rand() * 300) * 60000;
      const d = new Date(t);
      const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      const ext = exts[Math.floor(rand() * exts.length)] || '1000';
      const incoming = rand() < 0.6;
      const external = `11${Math.floor(30000000 + rand() * 69999999)}`;
      const internal = rand() < 0.3 ? exts[Math.floor(rand() * exts.length)] : '';
      const from = incoming ? internal || external : ext;
      const to = incoming ? ext : internal || external;
      items.push({
        file: `${incoming ? 'exten' : 'out'}-${to}-${from}-${date}-${Math.floor(t / 1000)}.${i}.wav`,
        calldate: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
        ts: t,
        from,
        fromName: '',
        to,
        answeredBy: '',
        billsec: Math.floor(10 + rand() * 400),
        available: rand() < 0.9,
        type: 'audio/wav',
      });
    }
    return items;
  }

  async list(query) {
    const q = normalizeQuery(query);
    if (!this.items) this.items = this._generate();
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - q.days);
    const list = this.items.filter((r) =>
      r.ts >= start.getTime() &&
      (!q.extension || r.from === q.extension || r.to === q.extension) &&
      (!q.search || r.from.includes(q.search) || r.to.includes(q.search)));
    const result = { records: list.slice(q.offset, q.offset + q.limit).map(({ ts, ...r }) => r), hasMore: list.length > q.offset + q.limit };
    if (q.offset === 0) result.total = list.length;
    return result;
  }

  async audioPath() {
    return null;
  }

  /** Áudio de demonstração: 3 s de tom (WAV 8 kHz, 16 bits, mono). */
  demoAudio(file) {
    if (!this.items || !this.items.some((r) => r.file === file && r.available)) return null;
    const rate = 8000;
    const n = rate * 3;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 400, (n - i) / 400);
      buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 6000 * env), 44 + i * 2);
    }
    return buf;
  }
}

module.exports = { MysqlRecordings, MockRecordings, resolveRecording, shapeRecording, normalizeQuery };
