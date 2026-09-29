'use strict';

// Diagnóstico da conexão com o banco de CDR do Issabel (aba Histórico).
// Uso: npm run check-cdr [-- <ramal>]
const config = require('./config');
const { MysqlCdr, describeCdrError } = require('./cdr');

(async () => {
  const db = config.cdrDb;
  if (!db) {
    console.error('✗ CDR_DB_HOST não está definido no .env — a aba Histórico fica desativada.');
    process.exit(1);
  }
  console.log(`Conectando em ${db.socketPath ? `socket ${db.socketPath}` : `${db.host}:${db.port}`} ` +
    `como '${db.user}' (senha ${db.password ? 'definida' : 'VAZIA'}), banco ${db.database}.${db.table}…`);

  let cdr;
  try {
    cdr = new MysqlCdr(db);
    const [[info]] = await cdr.pool.query(
      `SELECT COUNT(*) AS total, MAX(calldate) AS ultima FROM \`${db.table}\``);
    console.log(`✓ Conexão OK — ${info.total} registros no CDR, último em ${info.ultima || '—'}`);
    const [grants] = await cdr.pool.query('SHOW GRANTS');
    for (const g of grants) console.log(`  ${String(Object.values(g)[0]).replace(/ IDENTIFIED BY PASSWORD '[^']*'/, '')}`);

    const ext = process.argv[2];
    if (ext) {
      const res = await cdr.history(ext, { days: 30, limit: 5 });
      console.log(`✓ Ramal ${ext}: ${res.summary.total} ligações nos últimos 30 dias ` +
        `(${res.summary.in} recebidas, ${res.summary.out} realizadas, ${res.summary.missed} perdidas)`);
      for (const r of res.records) console.log(`  ${r.calldate}  ${r.direction === 'in' ? '←' : '→'} ${r.peer}  ${r.status}`);
      if (!res.summary.total) {
        console.log(`  Nenhuma ligação encontrada. Confira se os canais do ramal no CDR são "PJSIP/${ext}-…":`);
        const [rows] = await cdr.pool.query(
          `SELECT calldate, src, dst, channel, dstchannel FROM \`${db.table}\` ORDER BY calldate DESC LIMIT 5`);
        for (const r of rows) console.log(`  ${r.calldate}  ${r.src} → ${r.dst}  [${r.channel} → ${r.dstchannel}]`);
      }
    }
    process.exitCode = 0;
  } catch (err) {
    console.error(`✗ Falhou: ${describeCdrError(err, db)}`);
    process.exitCode = 1;
  } finally {
    if (cdr) await cdr.pool.end().catch(() => {});
  }
})();
