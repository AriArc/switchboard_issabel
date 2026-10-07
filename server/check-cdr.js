'use strict';

// Diagnóstico da conexão com o banco de CDR do Issabel (aba Histórico).
// Uso: npm run check-cdr [-- <ramal>]
const config = require('./config');
const { MysqlCdr, describeCdrError } = require('./cdr');

const fs = require('fs');
const { resolveRecording } = require('./recordings');

// Confere se o switchboard consegue ler as gravações do Issabel (aba Gravações)
async function checkRecordings(cdr) {
  const dir = config.recordingsDir;
  console.log(`Gravações em ${dir}…`);
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.X_OK);
  } catch (err) {
    console.log(err.code === 'ENOENT'
      ? '✗ Diretório não existe. Confira RECORDINGS_DIR no .env'
      : `✗ Sem acesso ao diretório (${err.code}). Rode: usermod -aG asterisk switchboard && systemctl restart switchboard`);
    return;
  }
  const [rows] = await cdr.pool.query(
    `SELECT recordingfile, MIN(calldate) AS d FROM \`${cdr.table}\` WHERE recordingfile <> '' AND billsec > 0
     AND calldate >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) GROUP BY recordingfile ORDER BY d DESC LIMIT 20`);
  if (!rows.length) return console.log('  Nenhuma ligação gravada nos últimos 7 dias.');
  let found = 0;
  let readable = 0;
  for (const r of rows) {
    const p = resolveRecording(dir, r.recordingfile, r.d);
    if (!p) continue;
    found++;
    try { fs.accessSync(p, fs.constants.R_OK); readable++; } catch { /* sem permissão */ }
  }
  console.log(`  ${rows.length} gravações recentes no CDR; ${found} arquivos encontrados; ${readable} com permissão de leitura.`);
  if (found && readable < found) console.log('✗ Sem permissão para ler os arquivos. Rode: usermod -aG asterisk switchboard && systemctl restart switchboard');
  else if (!found) console.log(`✗ Arquivos não encontrados. Confira RECORDINGS_DIR (ex.: ${rows[0].recordingfile} em ${dir}/AAAA/MM/DD/)`);
  else console.log('✓ Gravações acessíveis');
}

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
        console.log(`  Nenhuma ligação encontrada pelos canais "PJSIP/${ext}-…" / "SIP/${ext}-…".`);
        if (!/^\d+$/.test(ext)) throw new Error('Informe o ramal só com números');
        // Mostra como o ramal aparece de fato no CDR (fila, siga-me, nome de dispositivo diferente…)
        const like = `%${ext}%`;
        const [rows] = await cdr.pool.query(
          `SELECT calldate, clid, src, dst, channel, dstchannel, disposition, lastapp FROM \`${db.table}\`
           WHERE calldate >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
             AND (src LIKE ? OR dst LIKE ? OR channel LIKE ? OR dstchannel LIKE ? OR clid LIKE ?)
           ORDER BY calldate DESC LIMIT 10`, [like, like, like, like, like]);
        if (rows.length) {
          console.log(`  Registros dos últimos 30 dias que mencionam "${ext}" (envie esta saída para ajuste):`);
          for (const r of rows) {
            console.log(`  ${r.calldate}  src=${r.src} dst=${r.dst} clid=${r.clid}`);
            console.log(`      channel=${r.channel}  dstchannel=${r.dstchannel}  ${r.disposition}  app=${r.lastapp}`);
          }
        } else {
          console.log(`  Nenhum registro dos últimos 30 dias menciona "${ext}". O ramal fez/recebeu ligações já encerradas?`);
          console.log('  (o Issabel grava o CDR só quando a ligação termina). Últimos registros do CDR:');
          const [last] = await cdr.pool.query(
            `SELECT calldate, src, dst, channel, dstchannel FROM \`${db.table}\` ORDER BY calldate DESC LIMIT 5`);
          for (const r of last) console.log(`  ${r.calldate}  ${r.src} → ${r.dst}  [${r.channel} → ${r.dstchannel}]`);
        }
      }
    }
    await checkRecordings(cdr);
    process.exitCode = 0;
  } catch (err) {
    console.error(`✗ Falhou: ${describeCdrError(err, db)}`);
    process.exitCode = 1;
  } finally {
    if (cdr) await cdr.pool.end().catch(() => {});
  }
})();
