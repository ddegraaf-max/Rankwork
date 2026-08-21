// server.js — RankWerk: SEO-dashboard voor al je sites
const express = require('express');
const path = require('path');
const { version } = require('./package.json');
const session = require('express-session');
const { pool, init } = require('./db');
const { scanSite, normalizeBase } = require('./lib/scanner');
const { verwerkTaken } = require('./lib/taken');
const { verwerkActieplan, aiBeschikbaar } = require('./lib/ai');
const { scanNaarMarkdown, bestandsnaam } = require('./lib/export');
const auth = require('./lib/auth');
const planner = require('./lib/planner');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.locals.appVersie = version;
app.set('trust proxy', 1); // Railway zit achter een proxy
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'zet-een-echte-secret-in-railway',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 12 * 60 * 60 * 1000 }
}));

auth.registreerRoutes(app);
app.use(auth.eisLogin); // alles hieronder is beveiligd

function scoreKleur(s) {
  if (s === null || s === undefined) return 'grijs';
  if (s >= 80) return 'groen';
  if (s >= 55) return 'oranje';
  return 'rood';
}
app.locals.scoreKleur = scoreKleur;
app.locals.aiBeschikbaar = aiBeschikbaar;

// ---------- Dashboard ----------
app.get('/', async (req, res) => {
  const { rows: sites } = await pool.query(`
    SELECT s.*,
      (SELECT score FROM scans WHERE site_id = s.id AND status = 'klaar' ORDER BY id DESC LIMIT 1) AS laatste_score,
      (SELECT created_at FROM scans WHERE site_id = s.id AND status = 'klaar' ORDER BY id DESC LIMIT 1) AS laatste_scan,
      (SELECT COUNT(*) FROM taken t WHERE t.site_id = s.id AND t.klaar = false) AS open_taken,
      (SELECT ok FROM uptime u WHERE u.site_id = s.id ORDER BY u.id DESC LIMIT 1) AS online,
      (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE ok) / NULLIF(COUNT(*), 0), 1)
         FROM uptime u WHERE u.site_id = s.id AND u.gemeten_op > now() - interval '24 hours') AS uptime_24u
    FROM sites s ORDER BY s.naam ASC
  `);
  res.render('index', { sites, fout: req.query.fout || null });
});

// ---------- Site toevoegen / verwijderen ----------
app.post('/sites', async (req, res) => {
  try {
    const url = normalizeBase(req.body.url || '');
    const naam = (req.body.naam || '').trim() || new URL(url).hostname.replace(/^www\./, '');
    await pool.query(
      'INSERT INTO sites (naam, url, zoekwoorden) VALUES ($1, $2, $3) ON CONFLICT (url) DO NOTHING',
      [naam, url, (req.body.zoekwoorden || '').trim()]
    );
    res.redirect('/');
  } catch (e) {
    res.redirect('/?fout=' + encodeURIComponent('Ongeldige URL'));
  }
});

app.post('/sites/:id/verwijderen', async (req, res) => {
  await pool.query('DELETE FROM sites WHERE id = $1', [req.params.id]);
  res.redirect('/');
});

app.post('/sites/:id/zoekwoorden', async (req, res) => {
  await pool.query('UPDATE sites SET zoekwoorden = $1 WHERE id = $2',
    [(req.body.zoekwoorden || '').trim(), req.params.id]);
  res.redirect('/sites/' + req.params.id);
});

// ---------- Sitedetail ----------
app.get('/sites/:id', async (req, res) => {
  const { rows: [site] } = await pool.query('SELECT * FROM sites WHERE id = $1', [req.params.id]);
  if (!site) return res.redirect('/');
  const { rows: scans } = await pool.query(
    'SELECT * FROM scans WHERE site_id = $1 ORDER BY id DESC LIMIT 20', [site.id]);
  const { rows: taken } = await pool.query(
    `SELECT * FROM taken WHERE site_id = $1
     ORDER BY klaar ASC, CASE prioriteit WHEN 'hoog' THEN 0 WHEN 'middel' THEN 1 ELSE 2 END, id DESC`,
    [site.id]);
  res.render('site', { site, scans, taken, advies: site.ai_plan || null });
});

// ---------- Scan starten ----------
app.post('/sites/:id/scan', async (req, res) => {
  const { rows: [site] } = await pool.query('SELECT * FROM sites WHERE id = $1', [req.params.id]);
  if (!site) return res.redirect('/');

  const { rows: [scan] } = await pool.query(
    'INSERT INTO scans (site_id) VALUES ($1) RETURNING id', [site.id]);

  // Scan draait async door; gebruiker wordt direct teruggestuurd
  (async () => {
    try {
      const result = await scanSite(site.url);
      // AI-status alvast op 'bezig' vóór de scan op 'klaar' gaat, zodat de sitepagina
      // na de automatische verversing meteen toont dat het actieplan wordt gemaakt
      if (aiBeschikbaar) {
        await pool.query(`UPDATE sites SET ai_status = 'bezig' WHERE id = $1`, [site.id]);
      }
      await pool.query(
        `UPDATE scans SET status = 'klaar', score = $1, site_checks = $2, finished_at = now() WHERE id = $3`,
        [result.score, JSON.stringify(result.siteChecks), scan.id]);
      for (const p of result.pages) {
        await pool.query(
          `INSERT INTO scan_pages (scan_id, url, status_code, response_ms, score, checks)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [scan.id, p.url, p.status_code, p.response_ms, p.score, JSON.stringify(p.checks)]);
      }
      // Taken bijwerken: upsert per check_id, geslaagde checks automatisch afvinken
      await verwerkTaken(site.id, result);
      await verwerkActieplan(site, result).catch(e => console.error('AI-actieplanfout:', e.message));
    } catch (e) {
      console.error('Scanfout:', e);
      await pool.query(`UPDATE scans SET status = 'fout', fout = $1, finished_at = now() WHERE id = $2`,
        [String(e.message || e).slice(0, 300), scan.id]);
    }
  })();

  res.redirect('/sites/' + site.id + '#scans');
});

// Scanstatus — voor het automatisch verversen van de scanpagina zolang een scan loopt
app.get('/api/scans/:id/status', async (req, res) => {
  const { rows: [scan] } = await pool.query('SELECT status FROM scans WHERE id = $1', [req.params.id]);
  res.json({ status: scan ? scan.status : 'weg' });
});

// Sitestatus — scan- én AI-status in één keer, voor het auto-verversen van de sitepagina
app.get('/api/sites/:id/status', async (req, res) => {
  const { rows: [rij] } = await pool.query(
    `SELECT s.ai_status AS ai,
            (SELECT status FROM scans WHERE site_id = s.id ORDER BY id DESC LIMIT 1) AS scan
     FROM sites s WHERE s.id = $1`, [req.params.id]);
  res.json(rij || { scan: null, ai: null });
});

// ---------- Scanresultaat ----------
app.get('/scans/:id', async (req, res) => {
  const { rows: [scan] } = await pool.query('SELECT * FROM scans WHERE id = $1', [req.params.id]);
  if (!scan) return res.redirect('/');
  const { rows: [site] } = await pool.query('SELECT * FROM sites WHERE id = $1', [scan.site_id]);
  const { rows: pages } = await pool.query(
    'SELECT * FROM scan_pages WHERE scan_id = $1 ORDER BY score ASC', [scan.id]);
  res.render('scan', { scan, site, pages });
});

// ---------- Taken ----------
app.post('/taken/:id/toggle', async (req, res) => {
  await pool.query('UPDATE taken SET klaar = NOT klaar WHERE id = $1', [req.params.id]);
  res.redirect('back' in req.headers ? req.headers.referer || '/' : '/');
});

app.post('/sites/:id/taken', async (req, res) => {
  const titel = (req.body.titel || '').trim();
  if (titel) {
    await pool.query(
      `INSERT INTO taken (site_id, titel, prioriteit, bron) VALUES ($1, $2, $3, 'handmatig')
       ON CONFLICT (site_id, titel) DO NOTHING`,
      [req.params.id, titel, req.body.prioriteit || 'middel']);
  }
  res.redirect('/sites/' + req.params.id + '#taken');
});

// ---------- AI-advies ----------
// Draait net als de scan op de achtergrond; de sitepagina toont de status en ververst vanzelf
app.post('/sites/:id/advies', async (req, res) => {
  const { rows: [site] } = await pool.query('SELECT * FROM sites WHERE id = $1', [req.params.id]);
  if (!site) return res.redirect('/');
  const { rows: [scan] } = await pool.query(
    `SELECT * FROM scans WHERE site_id = $1 AND status = 'klaar' ORDER BY id DESC LIMIT 1`, [site.id]);
  if (!scan) return res.redirect('/sites/' + site.id);

  await pool.query(`UPDATE sites SET ai_status = 'bezig' WHERE id = $1`, [site.id]);
  (async () => {
    try {
      const { rows: pages } = await pool.query('SELECT * FROM scan_pages WHERE scan_id = $1', [scan.id]);
      await verwerkActieplan(site, {
        score: scan.score, siteChecks: scan.site_checks,
        pages: pages.map(p => ({ url: p.url, score: p.score, title: '', checks: p.checks }))
      });
    } catch (e) { console.error('AI-adviesfout:', e.message); }
  })();

  res.redirect('/sites/' + site.id + '#advies');
});

// ---------- Export: scanrapport downloaden of naar Claude/AI kopiëren ----------
async function laadScanExport(scanId) {
  const { rows: [scan] } = await pool.query(
    `SELECT * FROM scans WHERE id = $1 AND status = 'klaar'`, [scanId]);
  if (!scan) return null;
  const { rows: [site] } = await pool.query('SELECT * FROM sites WHERE id = $1', [scan.site_id]);
  const { rows: pages } = await pool.query(
    'SELECT * FROM scan_pages WHERE scan_id = $1 ORDER BY score ASC', [scan.id]);
  const { rows: taken } = await pool.query(
    `SELECT * FROM taken WHERE site_id = $1 AND NOT klaar
     ORDER BY CASE prioriteit WHEN 'hoog' THEN 0 WHEN 'middel' THEN 1 ELSE 2 END, id DESC`,
    [scan.site_id]);
  return { scan, site, pages, taken };
}

app.get('/scans/:id/rapport.md', async (req, res) => {
  const data = await laadScanExport(req.params.id);
  if (!data) return res.redirect('/');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="${bestandsnaam(data.site, data.scan, 'md')}"`);
  res.send(scanNaarMarkdown(data.site, data.scan, data.pages, data.taken));
});

app.get('/scans/:id/rapport.json', async (req, res) => {
  const data = await laadScanExport(req.params.id);
  if (!data) return res.redirect('/');
  res.setHeader('Content-Disposition',
    `attachment; filename="${bestandsnaam(data.site, data.scan, 'json')}"`);
  res.json({
    site: { naam: data.site.naam, url: data.site.url, zoekwoorden: data.site.zoekwoorden },
    scan: { id: data.scan.id, datum: data.scan.created_at, score: data.scan.score,
            siteChecks: data.scan.site_checks },
    paginas: data.pages.map(p => ({ url: p.url, status: p.status_code, ms: p.response_ms,
                                    score: p.score, checks: p.checks })),
    openTaken: data.taken.map(t => ({ prioriteit: t.prioriteit, titel: t.titel, detail: t.detail }))
  });
});

// ---------- Ops room ----------
app.get('/opsroom', async (req, res) => {
  res.render('ops');
});

app.get('/api/ops', async (req, res) => {
  const { rows: sites } = await pool.query(`
    SELECT s.id, s.naam, s.url,
      (SELECT score FROM scans sc WHERE sc.site_id = s.id AND sc.status = 'klaar' ORDER BY sc.id DESC LIMIT 1) AS score,
      (SELECT score FROM scans sc WHERE sc.site_id = s.id AND sc.status = 'klaar' ORDER BY sc.id DESC OFFSET 1 LIMIT 1) AS vorige_score,
      (SELECT created_at FROM scans sc WHERE sc.site_id = s.id AND sc.status = 'klaar' ORDER BY sc.id DESC LIMIT 1) AS laatste_scan,
      (SELECT ok FROM uptime u WHERE u.site_id = s.id ORDER BY u.id DESC LIMIT 1) AS online,
      (SELECT response_ms FROM uptime u WHERE u.site_id = s.id ORDER BY u.id DESC LIMIT 1) AS laatste_ms,
      (SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE ok) / NULLIF(COUNT(*), 0), 1)
         FROM uptime u WHERE u.site_id = s.id AND u.gemeten_op > now() - interval '24 hours') AS uptime_24u,
      (SELECT COUNT(*) FROM taken t WHERE t.site_id = s.id AND NOT t.klaar) AS open_taken,
      (SELECT COUNT(*) FROM taken t WHERE t.site_id = s.id AND NOT t.klaar AND t.prioriteit = 'hoog') AS taken_hoog
    FROM sites s ORDER BY s.naam ASC
  `);

  // Sparkline-data: laatste 60 metingen per site
  for (const s of sites) {
    const { rows: metingen } = await pool.query(
      `SELECT ok, response_ms FROM uptime WHERE site_id = $1 ORDER BY id DESC LIMIT 60`, [s.id]);
    s.spark = metingen.reverse().map(m => ({ ok: m.ok, ms: m.response_ms }));
  }

  const { rows: [tot] } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM scans WHERE created_at > now() - interval '24 hours' AND status = 'klaar') AS scans_24u,
      (SELECT COUNT(*) FROM uptime WHERE gemeten_op > now() - interval '24 hours') AS checks_24u,
      (SELECT COUNT(*) FROM taken WHERE NOT klaar) AS taken_open,
      (SELECT COUNT(*) FROM taken WHERE klaar) AS taken_klaar
  `);

  const scores = sites.filter(s => s.score !== null).map(s => Number(s.score));
  res.json({
    tijd: new Date().toISOString(),
    totaal: {
      sites: sites.length,
      online: sites.filter(s => s.online === true).length,
      offline: sites.filter(s => s.online === false).length,
      gemScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
      scans24u: Number(tot.scans_24u),
      checks24u: Number(tot.checks_24u),
      takenOpen: Number(tot.taken_open),
      takenKlaar: Number(tot.taken_klaar)
    },
    sites
  });
});

// Handmatig het dagrapport testen
app.post('/rapport/test', async (req, res) => {
  const ok = await planner.verstuurRapport().catch(() => false);
  res.redirect('/?fout=' + encodeURIComponent(ok ? 'Rapport verzonden ✓' : 'Rapport mislukt — check RESEND_API_KEY en RAPPORT_EMAIL'));
});

init().then(() => {
  app.listen(PORT, () => console.log(`🚀 RankWerk draait op poort ${PORT}`));
  planner.start();
}).catch(e => {
  console.error('Database-init mislukt:', e);
  process.exit(1);
});
