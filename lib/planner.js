// lib/planner.js — de motor die 24/7 draait:
//  • elke minuut:  uptime-check op alle sites (bereikbaar? hoe snel?)
//  • doorlopend:   scanrotatie — steeds de site met de oudste scan opnieuw scannen
//  • elke ochtend: dagrapport per e-mail via Resend (scores, verschillen, taken, uptime)
const { pool } = require('../db');
const { scanSite } = require('./scanner');
const { verwerkTaken } = require('./taken');

const SCAN_INTERVAL_MIN = parseInt(process.env.SCAN_INTERVAL_MIN || '60', 10); // per site min. 1x per uur
const RAPPORT_UUR = parseInt(process.env.RAPPORT_UUR || '7', 10);
const RESEND_KEY = process.env.RESEND_API_KEY;
const RAPPORT_NAAR = process.env.RAPPORT_EMAIL;
const RAPPORT_VAN = process.env.RAPPORT_VAN || 'RankWerk <onboarding@resend.dev>';

let scanBezig = false;

// ---------- Uptime: elke 60 seconden ----------
async function uptimeRonde() {
  const { rows: sites } = await pool.query('SELECT id, url FROM sites');
  for (const s of sites) {
    const start = Date.now();
    let ok = false, code = 0;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(s.url, { method: 'GET', redirect: 'follow', signal: controller.signal,
        headers: { 'User-Agent': 'RankWerkBot/1.0 (uptime)' } });
      clearTimeout(t);
      ok = res.ok; code = res.status;
    } catch { /* onbereikbaar */ }
    const ms = Date.now() - start;
    await pool.query(
      'INSERT INTO uptime (site_id, ok, status_code, response_ms) VALUES ($1, $2, $3, $4)',
      [s.id, ok, code, ms]);
  }
  // Oude metingen opruimen (bewaar 7 dagen)
  await pool.query(`DELETE FROM uptime WHERE gemeten_op < now() - interval '7 days'`);
}

// ---------- Scanrotatie: site met oudste scan eerst ----------
async function scanRonde() {
  if (scanBezig) return;
  scanBezig = true;
  try {
    const { rows: [site] } = await pool.query(`
      SELECT s.*, (SELECT MAX(created_at) FROM scans sc WHERE sc.site_id = s.id AND sc.status = 'klaar') AS laatste
      FROM sites s
      ORDER BY laatste ASC NULLS FIRST
      LIMIT 1`);
    if (!site) return;
    if (site.laatste && (Date.now() - new Date(site.laatste).getTime()) < SCAN_INTERVAL_MIN * 60000) return;

    const { rows: [scan] } = await pool.query(
      "INSERT INTO scans (site_id) VALUES ($1) RETURNING id", [site.id]);
    try {
      const result = await scanSite(site.url);
      await pool.query(
        `UPDATE scans SET status = 'klaar', score = $1, site_checks = $2, finished_at = now() WHERE id = $3`,
        [result.score, JSON.stringify(result.siteChecks), scan.id]);
      for (const p of result.pages) {
        await pool.query(
          `INSERT INTO scan_pages (scan_id, url, status_code, response_ms, score, checks)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [scan.id, p.url, p.status_code, p.response_ms, p.score, JSON.stringify(p.checks)]);
      }
      const t = await verwerkTaken(site.id, result);
      console.log(`🔄 Automatische scan ${site.naam}: score ${result.score} · ${t.nieuwOfBijgewerkt} taken open/bijgewerkt · ${t.afgevinkt} automatisch afgevinkt`);
    } catch (e) {
      await pool.query(`UPDATE scans SET status = 'fout', fout = $1, finished_at = now() WHERE id = $2`,
        [String(e.message || e).slice(0, 300), scan.id]);
    }
  } finally {
    scanBezig = false;
  }
}

// ---------- Dagrapport ----------
async function bouwRapport() {
  const { rows: sites } = await pool.query('SELECT * FROM sites ORDER BY naam');
  const regels = [];
  for (const s of sites) {
    const { rows: laatste2 } = await pool.query(
      `SELECT score, created_at FROM scans WHERE site_id = $1 AND status = 'klaar' ORDER BY id DESC LIMIT 2`, [s.id]);
    const { rows: [taak] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE NOT klaar) AS open,
              COUNT(*) FILTER (WHERE NOT klaar AND prioriteit = 'hoog') AS hoog
       FROM taken WHERE site_id = $1`, [s.id]);
    const { rows: [up] } = await pool.query(
      `SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE ok) AS ok_n, ROUND(AVG(response_ms)) AS gem_ms
       FROM uptime WHERE site_id = $1 AND gemeten_op > now() - interval '24 hours'`, [s.id]);

    const score = laatste2[0] ? laatste2[0].score : null;
    const vorige = laatste2[1] ? laatste2[1].score : null;
    const delta = (score !== null && vorige !== null) ? score - vorige : null;
    const uptimePct = up && up.n > 0 ? Math.round((up.ok_n / up.n) * 1000) / 10 : null;
    regels.push({ naam: s.naam, url: s.url, score, delta, open: taak.open, hoog: taak.hoog,
                  uptimePct, gemMs: up ? up.gem_ms : null });
  }
  return regels;
}

function rapportHtml(regels) {
  const rij = r => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee"><strong>${r.naam}</strong><br>
          <span style="color:#888;font-size:12px">${r.url}</span></td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:center;font-size:20px;font-weight:bold;
          color:${r.score === null ? '#888' : r.score >= 80 ? '#16a34a' : r.score >= 55 ? '#d97706' : '#dc2626'}">
          ${r.score ?? '—'}${r.delta ? ` <span style="font-size:12px">(${r.delta > 0 ? '+' : ''}${r.delta})</span>` : ''}</td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${r.open} <span style="color:#dc2626">(${r.hoog} hoog)</span></td>
      <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${r.uptimePct !== null ? r.uptimePct + '%' : '—'}<br>
          <span style="color:#888;font-size:12px">${r.gemMs ? r.gemMs + ' ms' : ''}</span></td>
    </tr>`;
  return `
  <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto">
    <h2 style="color:#111">RankWerk — dagrapport ${new Date().toLocaleDateString('nl-NL')}</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr style="background:#f5f5f5">
        <th style="padding:8px;text-align:left">Site</th><th style="padding:8px">Score</th>
        <th style="padding:8px">Open taken</th><th style="padding:8px">Uptime 24u</th>
      </tr>
      ${regels.map(rij).join('')}
    </table>
    <p style="color:#888;font-size:12px">Automatisch verzonden door RankWerk. Scores veranderen pas als je de taken in het dashboard afwerkt.</p>
  </div>`;
}

async function verstuurRapport() {
  if (!RESEND_KEY || !RAPPORT_NAAR) {
    console.log('ℹ️ Dagrapport overgeslagen: RESEND_API_KEY of RAPPORT_EMAIL ontbreekt');
    return false;
  }
  const regels = await bouwRapport();
  if (!regels.length) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RAPPORT_VAN,
      to: [RAPPORT_NAAR],
      subject: `RankWerk dagrapport — ${regels.length} site(s)`,
      html: rapportHtml(regels)
    })
  });
  if (!res.ok) {
    console.error('Resend-fout:', (await res.text()).slice(0, 200));
    return false;
  }
  console.log('📧 Dagrapport verzonden naar', RAPPORT_NAAR);
  return true;
}

async function rapportRonde() {
  const nu = new Date();
  if (nu.getHours() !== RAPPORT_UUR) return;
  const vandaag = nu.toISOString().slice(0, 10);
  const { rows } = await pool.query(
    "SELECT waarde FROM instellingen WHERE sleutel = 'laatste_rapport'");
  if (rows[0] && rows[0].waarde === vandaag) return; // al verstuurd vandaag
  const ok = await verstuurRapport();
  if (ok) {
    await pool.query(
      `INSERT INTO instellingen (sleutel, waarde) VALUES ('laatste_rapport', $1)
       ON CONFLICT (sleutel) DO UPDATE SET waarde = EXCLUDED.waarde`, [vandaag]);
  }
}

function start() {
  console.log(`⚙️ Planner actief: uptime elke 60s, scanrotatie (elke site min. 1×/${SCAN_INTERVAL_MIN} min), rapport om ${RAPPORT_UUR}:00`);
  setInterval(() => uptimeRonde().catch(e => console.error('Uptime-fout:', e.message)), 60000);
  setInterval(() => scanRonde().catch(e => console.error('Scanrotatie-fout:', e.message)), 90000);
  setInterval(() => rapportRonde().catch(e => console.error('Rapport-fout:', e.message)), 5 * 60000);
  // Direct een eerste ronde
  uptimeRonde().catch(() => {});
  setTimeout(() => scanRonde().catch(() => {}), 5000);
}

module.exports = { start, verstuurRapport };
