// lib/taken.js — vertaalt een scanresultaat naar taken met een stabiel check_id.
// Gedrag bij herscan:
//   • check faalt  → taak upserten op (site_id, check_id): detail bijwerken, klaar=false
//   • check slaagt → bestaande taak met dat check_id automatisch afvinken
//   • handmatige taken (check_id IS NULL, bron='handmatig') blijven onaangeraakt
const { pool } = require('../db');

function slug(label) {
  return label.toLowerCase()
    .replace(/[àáâä]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíîï]/g, 'i')
    .replace(/[òóôö]/g, 'o').replace(/[ùúûü]/g, 'u')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function pad(url) {
  try { const p = new URL(url).pathname; return p || '/'; } catch { return url; }
}
function prioVanGewicht(g) { return g >= 7 ? 'hoog' : g >= 4 ? 'middel' : 'laag'; }

function bouwTaken(result) {
  const open = [];   // { id, titel, detail, prio }
  const dicht = [];  // check_id's die nu slagen → afvinken

  // ---- Site-niveau ----
  const sc = result.siteChecks || {};
  const site = (id, faalt, titel, detail, prio) =>
    faalt ? open.push({ id: 'site|' + id, titel, detail, prio })
          : dicht.push('site|' + id);

  site('https', !sc.https, 'Zet de site op HTTPS',
    'Google straft niet-beveiligde sites af.', 'hoog');
  site('sitemap', !sc.sitemap, 'Voeg een sitemap.xml toe',
    'Er is geen (geldige) sitemap gevonden. Genereer er een en dien hem in via Google Search Console.'
    + (sc.catchAll ? ' Let op: je server geeft voor elk pad een 200 terug; zorg dat /sitemap.xml échte XML serveert.' : ''), 'hoog');
  site('robots', !sc.robots, 'Voeg robots.txt toe',
    'Er is geen (geldige) robots.txt gevonden. Maak er een met een verwijzing naar je sitemap.'
    + (sc.catchAll ? ' Let op: je server geeft voor elk pad een 200 terug; zorg dat /robots.txt échte tekst serveert.' : ''), 'middel');
  site('robots-blokkeert', !!sc.robotsBlokkeertAlles, 'robots.txt blokkeert Google!',
    'Het blok dat voor Googlebot/* geldt bevat "Disallow: /" — Google indexeert dan niets. '
    + '"Disallow: /" dat alleen voor AI-bots geldt (GPTBot, ClaudeBot e.d.) triggert deze melding niet.', 'hoog');
  site('botbescherming', result.pages.some(p => p.geblokkeerd), 'Botbescherming blokkeert de scanner',
    'Een of meer pagina\'s tonen een challenge-pagina aan RankWerkBot. Whitelist de bot of het server-IP; '
    + 'tot die tijd zijn de scanresultaten onvolledig.', 'middel');
  site('soft-404', !!sc.catchAll, 'Niet-bestaande URL\'s geven geen 404',
    'De server geeft voor elk willekeurig pad een 200 terug (soft-404). Google kan dan kapotte URL\'s '
    + 'indexeren. Laat niet-bestaande pagina\'s een echte 404-status teruggeven.', 'middel');
  if (sc.httpsRedirect !== undefined) {
    site('https-redirect', sc.httpsRedirect === false, 'http:// stuurt niet door naar https://',
      'Bezoekers (en Google) die de http://-variant opvragen komen niet automatisch op de beveiligde site uit. '
      + 'Stel een 301-redirect van http naar https in.', 'middel');
  }
  if (sc.wwwRedirect !== undefined) {
    site('www-redirect', sc.wwwRedirect === false, 'www/non-www niet consistent',
      `De variant ${sc.wwwVariant || ''} ${sc.wwwVariantOnbereikbaar ? 'is niet bereikbaar (DNS?)' : 'stuurt niet door naar de hoofdversie'}. `
      + 'Kies één versie (met of zonder www) en 301-redirect de andere ernaartoe.', 'laag');
  }
  const lijst = (l) => l && l.length ? ` Het gaat om: "${l.join('" · "')}".` : '';
  site('dubbele-titles', sc.dubbeleTitles > 0, 'Dubbele page titles',
    `${sc.dubbeleTitles || 0} pagina's delen dezelfde <title>.${lijst(sc.dubbeleTitlesLijst)} `
    + 'Geef elke pagina een unieke title met eigen zoekwoord — identieke titles concurreren met elkaar in Google.', 'hoog');
  site('dubbele-descriptions', sc.dubbeleDescriptions > 0, 'Dubbele meta descriptions',
    `${sc.dubbeleDescriptions || 0} pagina's delen dezelfde meta description.${lijst(sc.dubbeleDescriptionsLijst)} `
    + 'Schrijf per pagina een eigen description.', 'laag');
  const psi = sc.pagespeed;
  if (psi && psi.score != null) {
    site('pagespeed', psi.score < 50, 'PageSpeed-score is laag',
      `Google PageSpeed (mobiel) geeft ${psi.score}/100`
      + (psi.lcpMs ? `, LCP ${(psi.lcpMs / 1000).toFixed(1)}s` : '')
      + `. Optimaliseer afbeeldingen (WebP, juiste maten), beperk JavaScript en zet caching/compressie aan.`, 'middel');
  }

  // ---- Pagina-niveau: één taak per check per URL ----
  for (const p of result.pages) {
    if (p.geblokkeerd) continue; // al afgedekt door de site-taak hierboven
    const urlPad = pad(p.url);
    for (const c of p.checks) {
      const id = slug(c.label) + '|' + urlPad;
      if (c.ok) {
        dicht.push(id);
      } else {
        open.push({
          id,
          titel: `${c.label} — ${urlPad}`,
          detail: [c.detail, c.fix].filter(Boolean).join(' → '),
          prio: prioVanGewicht(c.gewicht)
        });
      }
    }
  }
  return { open, dicht };
}

async function verwerkTaken(siteId, result) {
  // Opruimen: oude geaggregeerde scantaken zonder check_id (uit eerdere versies)
  await pool.query(
    `DELETE FROM taken WHERE site_id = $1 AND bron = 'scan' AND check_id IS NULL`, [siteId]);

  const { open, dicht } = bouwTaken(result);

  for (const t of open) {
    await pool.query(
      `INSERT INTO taken (site_id, check_id, titel, detail, prioriteit, bron, klaar)
       VALUES ($1, $2, $3, $4, $5, 'scan', false)
       ON CONFLICT (site_id, check_id) WHERE check_id IS NOT NULL
       DO UPDATE SET titel = EXCLUDED.titel, detail = EXCLUDED.detail,
                     prioriteit = EXCLUDED.prioriteit, klaar = false`,
      [siteId, t.id, t.titel.slice(0, 200), t.detail, t.prio]);
  }

  let afgevinkt = 0;
  if (dicht.length) {
    const { rowCount } = await pool.query(
      `UPDATE taken SET klaar = true
       WHERE site_id = $1 AND bron = 'scan' AND NOT klaar AND check_id = ANY($2)`,
      [siteId, dicht]);
    afgevinkt = rowCount;
  }
  return { nieuwOfBijgewerkt: open.length, afgevinkt };
}

module.exports = { verwerkTaken, bouwTaken };
