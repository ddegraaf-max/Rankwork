// lib/planner.js — de motor die 24/7 draait:
//  • elke minuut:  uptime-check op alle sites (bereikbaar? hoe snel?)
//  • doorlopend:   scanrotatie — steeds de site met de oudste scan opnieuw scannen
//  • elke ochtend: dagrapport per e-mail via Resend (scores, verschillen, taken, uptime)
const { pool } = require('../db');
const { scanSite } = require('./scanner');
const { verwerkTaken } = require('./taken');
const { verwerkActieplan } = require('./ai');

const SCAN_INTERVAL_MIN = parseInt(process.env.SCAN_INTERVAL_MIN || '1440', 10); // per site min. 1x per 24 uur
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
      await verwerkActieplan(site, result).catch(e => console.error('AI-actieplanfout:', e.message));
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

// ---------- Dagrapport-mail in de ops-room-stijl van de site ----------
// E-mailveilig: alleen tabellen + inline styles (geen webfonts/classes — die strippen mailclients)
const K = { bg: '#0c0f0d', paneel: '#121613', rand: '#232a25', tekst: '#e8ede9',
            dim: '#8b968e', accent: '#7cf29c', groen: '#4ade80', oranje: '#fbbf24', rood: '#f87171' };
const MONO = "'Courier New',Courier,monospace";
const SANS = 'Arial,Helvetica,sans-serif';
const scoreKleur = s => s == null ? K.dim : s >= 80 ? K.groen : s >= 55 ? K.oranje : K.rood;
const uptimeKleur = u => u == null ? K.dim : u >= 99 ? K.groen : u >= 95 ? K.oranje : K.rood;
const esc = t => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function rapportHtml(regels) {
  const datum = new Date().toLocaleDateString('nl-NL');
  const appUrl = (process.env.APP_URL || '').replace(/\/+$/, '');

  const scores = regels.filter(r => r.score !== null).map(r => Number(r.score));
  const gemScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const openTot = regels.reduce((s, r) => s + Number(r.open), 0);
  const hoogTot = regels.reduce((s, r) => s + Number(r.hoog), 0);
  const upWaardes = regels.filter(r => r.uptimePct !== null).map(r => Number(r.uptimePct));
  const minUp = upWaardes.length ? Math.min(...upWaardes) : null;
  const aandacht = regels.filter(r =>
    (r.uptimePct !== null && r.uptimePct < 95) || (r.score !== null && r.score < 55));

  const kpi = (waarde, label, kleur) => `
    <td width="25%" bgcolor="${K.paneel}" style="background:${K.paneel};border:1px solid ${K.rand};border-radius:9px;padding:12px 6px;text-align:center;">
      <span style="font-family:${MONO};font-size:24px;font-weight:bold;color:${kleur};">${waarde}</span><br>
      <span style="font-family:${MONO};font-size:9px;letter-spacing:2px;color:${K.dim};">${label}</span>
    </td>`;

  const rij = r => {
    const delta = (r.delta === null || r.delta === 0) ? '' :
      `<br><span style="font-family:${MONO};font-size:11px;color:${r.delta > 0 ? K.groen : K.rood};">${r.delta > 0 ? '&#9650; +' + r.delta : '&#9660; ' + r.delta}</span>`;
    return `
    <tr>
      <td style="padding:13px 10px;border-top:1px solid ${K.rand};">
        <span style="color:${scoreKleur(r.score)};font-size:10px;">&#9679;</span>&nbsp;
        <span style="font-family:${SANS};font-weight:bold;font-size:14px;color:${K.tekst};">${esc(r.naam)}</span><br>
        <span style="font-family:${MONO};font-size:11px;color:${K.dim};">&nbsp;&nbsp;${esc(r.url.replace(/^https?:\/\//, ''))}</span>
      </td>
      <td align="center" style="padding:13px 6px;border-top:1px solid ${K.rand};font-family:${MONO};font-size:24px;font-weight:bold;color:${scoreKleur(r.score)};">
        ${r.score ?? '&mdash;'}${delta}
      </td>
      <td align="center" style="padding:13px 6px;border-top:1px solid ${K.rand};font-family:${MONO};font-size:14px;color:${Number(r.hoog) > 0 ? K.oranje : K.tekst};">
        ${r.open}${Number(r.hoog) > 0 ? `&nbsp;<span style="color:${K.rood};font-size:11px;">(${r.hoog} hoog)</span>` : ''}
      </td>
      <td align="center" style="padding:13px 6px;border-top:1px solid ${K.rand};font-family:${MONO};font-size:14px;color:${uptimeKleur(r.uptimePct)};">
        ${r.uptimePct !== null ? r.uptimePct + '%' : '&mdash;'}
        ${r.gemMs ? `<br><span style="font-size:11px;color:${K.dim};">${r.gemMs} ms</span>` : ''}
      </td>
    </tr>`;
  };

  const alarmBlok = !aandacht.length ? '' : `
    <tr><td style="padding:0 0 14px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td bgcolor="#1a1010" style="background:#1a1010;border:1px solid ${K.rood};border-radius:9px;padding:10px 14px;font-family:${MONO};font-size:12px;color:${K.rood};">
          &#9888; AANDACHT &mdash; ${aandacht.map(r => esc(r.naam) + (r.uptimePct !== null && r.uptimePct < 95 ? ` (uptime ${r.uptimePct}%)` : ` (score ${r.score})`)).join(' &middot; ')}
        </td></tr>
      </table>
    </td></tr>`;

  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">
</head>
<body style="margin:0;padding:0;background:${K.bg};" bgcolor="${K.bg}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${K.bg}" style="background:${K.bg};">
<tr><td align="center" style="padding:0 12px 28px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;">

  <tr><td height="3" bgcolor="${K.accent}" style="background:${K.accent};font-size:0;line-height:0;">&nbsp;</td></tr>

  <tr><td style="padding:20px 4px 18px;">
    <span style="font-family:${SANS};font-weight:900;font-size:23px;letter-spacing:2px;color:${K.tekst};">RANK<span style="color:${K.accent};">WERK</span></span><br>
    <span style="font-family:${MONO};font-size:11px;letter-spacing:2px;color:${K.dim};">&#11042; OPS ROOM &middot; DAGRAPPORT ${datum}</span>
  </td></tr>

  <tr><td style="padding:0 0 14px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="6">
      <tr>
        ${kpi(gemScore ?? '&mdash;', 'GEM. SCORE', scoreKleur(gemScore))}
        ${kpi(openTot, 'OPEN TAKEN', openTot > 0 ? K.oranje : K.groen)}
        ${kpi(hoogTot, 'PRIO HOOG', hoogTot > 0 ? K.rood : K.groen)}
        ${kpi(minUp !== null ? minUp + '%' : '&mdash;', 'LAAGSTE UPTIME', uptimeKleur(minUp))}
      </tr>
    </table>
  </td></tr>

  ${alarmBlok}

  <tr><td bgcolor="${K.paneel}" style="background:${K.paneel};border:1px solid ${K.rand};border-radius:10px;padding:6px 8px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="padding:9px 10px;font-family:${MONO};font-size:10px;letter-spacing:2px;color:${K.dim};">SITE</td>
        <td align="center" style="padding:9px 6px;font-family:${MONO};font-size:10px;letter-spacing:2px;color:${K.dim};">SCORE</td>
        <td align="center" style="padding:9px 6px;font-family:${MONO};font-size:10px;letter-spacing:2px;color:${K.dim};">TAKEN</td>
        <td align="center" style="padding:9px 6px;font-family:${MONO};font-size:10px;letter-spacing:2px;color:${K.dim};">UPTIME 24U</td>
      </tr>
      ${regels.map(rij).join('')}
    </table>
  </td></tr>

  ${appUrl ? `
  <tr><td align="center" style="padding:20px 0 4px;">
    <a href="${appUrl}/opsroom" style="display:inline-block;font-family:${SANS};font-weight:bold;font-size:12px;letter-spacing:2px;color:#08120b;background:${K.accent};padding:11px 22px;border-radius:7px;text-decoration:none;">OPEN OPS ROOM &rarr;</a>
  </td></tr>` : ''}

  <tr><td style="padding:16px 4px 0;font-family:${MONO};font-size:10px;letter-spacing:1px;color:${K.dim};">
    AUTOMATISCH VERZONDEN DOOR RANKWERK &middot; SCORES VERANDEREN PAS ALS JE TAKEN AFWERKT IN HET DASHBOARD
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
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

module.exports = { start, verstuurRapport, rapportHtml };
