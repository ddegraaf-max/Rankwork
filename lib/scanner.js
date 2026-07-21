// lib/scanner.js — SEO-audit engine
// Crawlt max MAX_PAGES pagina's per site (via sitemap.xml of interne links)
// en voert per pagina + per site een reeks checks uit. Geen externe API's nodig.

const cheerio = require('cheerio');

const MAX_PAGES = 15;
const FETCH_TIMEOUT = 15000;
const UA = 'RankWerkBot/1.0 (+SEO-audit; eigen sites)';

async function fetchTimed(url, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*' },
      ...opts
    });
    const ms = Date.now() - start;
    return { res, ms };
  } finally {
    clearTimeout(t);
  }
}

function normalizeBase(url) {
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '');
}

function sameHost(base, link) {
  try {
    const a = new URL(base);
    const b = new URL(link, base);
    return a.host.replace(/^www\./, '') === b.host.replace(/^www\./, '');
  } catch { return false; }
}

function cleanUrl(base, link) {
  try {
    const u = new URL(link, base);
    u.hash = '';
    return u.toString();
  } catch { return null; }
}

// ---------- Site-niveau checks ----------
async function checkSiteLevel(base) {
  const out = { https: base.startsWith('https://') };

  // robots.txt
  try {
    const { res } = await fetchTimed(base + '/robots.txt');
    out.robots = res.ok;
    if (res.ok) {
      const txt = await res.text();
      out.robotsBlokkeertAlles = /Disallow:\s*\/\s*$/mi.test(txt) && /User-agent:\s*\*/i.test(txt);
      const m = txt.match(/Sitemap:\s*(\S+)/i);
      if (m) out.sitemapInRobots = m[1];
    }
  } catch { out.robots = false; }

  // sitemap.xml
  const sitemapCandidates = [out.sitemapInRobots, base + '/sitemap.xml'].filter(Boolean);
  out.sitemap = false;
  out.sitemapUrls = [];
  for (const sm of sitemapCandidates) {
    try {
      const { res } = await fetchTimed(sm);
      if (!res.ok) continue;
      const xml = await res.text();
      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
      if (locs.length) {
        // sitemap-index? volg eerste sub-sitemap
        if (/<sitemapindex/i.test(xml)) {
          try {
            const { res: r2 } = await fetchTimed(locs[0]);
            if (r2.ok) {
              const xml2 = await r2.text();
              const locs2 = [...xml2.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
              out.sitemapUrls = locs2;
            }
          } catch { /* negeren */ }
        } else {
          out.sitemapUrls = locs;
        }
        out.sitemap = true;
        out.sitemapAantal = out.sitemapUrls.length;
        break;
      }
    } catch { /* volgende kandidaat */ }
  }

  // favicon
  try {
    const { res } = await fetchTimed(base + '/favicon.ico');
    out.favicon = res.ok;
  } catch { out.favicon = false; }

  return out;
}

// ---------- Pagina-niveau checks ----------
function auditHtml(url, html, statusCode, responseMs) {
  const $ = cheerio.load(html);
  const checks = [];
  const add = (ok, gewicht, label, detail, fix) =>
    checks.push({ ok: !!ok, gewicht, label, detail: detail || '', fix: ok ? '' : (fix || '') });

  const title = ($('head title').first().text() || '').trim();
  add(title.length > 0, 10, 'Title aanwezig', title ? `"${title.slice(0, 80)}"` : 'Geen <title> gevonden',
    'Voeg een unieke <title> toe met je belangrijkste zoekwoord vooraan.');
  if (title) {
    add(title.length >= 30 && title.length <= 65, 4, 'Title-lengte (30–65)', `${title.length} tekens`,
      'Herschrijf de title naar 30–65 tekens: zoekwoord + merknaam.');
  }

  const desc = ($('meta[name="description"]').attr('content') || '').trim();
  add(desc.length > 0, 8, 'Meta description aanwezig', desc ? `"${desc.slice(0, 90)}…"` : 'Ontbreekt',
    'Schrijf een description van 70–160 tekens met zoekwoord en call-to-action.');
  if (desc) {
    add(desc.length >= 70 && desc.length <= 165, 3, 'Description-lengte (70–165)', `${desc.length} tekens`,
      'Pas de lengte aan naar 70–165 tekens.');
  }

  const h1s = $('h1');
  add(h1s.length === 1, 7, 'Precies één H1', `${h1s.length} gevonden`,
    h1s.length === 0 ? 'Voeg één H1 toe met het hoofdzoekwoord van de pagina.'
                     : 'Gebruik maximaal één H1 per pagina; maak van de rest H2.');

  const canonical = $('link[rel="canonical"]').attr('href');
  add(!!canonical, 5, 'Canonical-tag', canonical || 'Ontbreekt',
    'Voeg <link rel="canonical" href="…"> toe om duplicate content te voorkomen.');

  const robotsMeta = ($('meta[name="robots"]').attr('content') || '').toLowerCase();
  add(!robotsMeta.includes('noindex'), 10, 'Indexeerbaar (geen noindex)', robotsMeta || 'geen robots-meta (prima)',
    'Verwijder noindex uit de robots-meta, anders komt deze pagina nooit in Google.');

  const lang = $('html').attr('lang');
  add(!!lang, 2, 'html lang-attribuut', lang || 'Ontbreekt', 'Zet lang="nl" (of "pl") op de <html>-tag.');

  const viewport = $('meta[name="viewport"]').attr('content');
  add(!!viewport, 3, 'Viewport-meta (mobiel)', viewport ? 'Aanwezig' : 'Ontbreekt',
    'Voeg <meta name="viewport" content="width=device-width, initial-scale=1"> toe.');

  const ogTitle = $('meta[property="og:title"]').attr('content');
  const ogImage = $('meta[property="og:image"]').attr('content');
  add(!!ogTitle, 2, 'Open Graph title', ogTitle ? 'Aanwezig' : 'Ontbreekt',
    'Voeg og:title/og:description toe voor betere weergave bij delen.');
  add(!!ogImage, 2, 'Open Graph image', ogImage ? 'Aanwezig' : 'Ontbreekt',
    'Voeg een og:image toe (1200×630px).');

  const jsonLd = $('script[type="application/ld+json"]').length;
  add(jsonLd > 0, 5, 'Structured data (JSON-LD)', jsonLd ? `${jsonLd} blok(ken)` : 'Ontbreekt',
    'Voeg schema.org JSON-LD toe (LocalBusiness, Product of Service) — belangrijk voor rich results.');

  const imgs = $('img');
  const zonderAlt = imgs.filter((_, el) => !($(el).attr('alt') || '').trim()).length;
  add(imgs.length === 0 || zonderAlt === 0, 3, 'Alt-teksten op afbeeldingen',
    imgs.length ? `${zonderAlt} van ${imgs.length} zonder alt` : 'Geen afbeeldingen',
    'Geef elke <img> een beschrijvende alt-tekst met waar relevant een zoekwoord.');

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const woorden = bodyText ? bodyText.split(' ').length : 0;
  add(woorden >= 300, 4, 'Voldoende content (≥300 woorden)', `${woorden} woorden`,
    'Breid de pagina uit met relevante tekst: uitleg, FAQ, werkgebied, prijzen.');

  let interneLinks = 0;
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && (href.startsWith('/') || sameHost(url, href))) interneLinks++;
  });
  add(interneLinks >= 3, 2, 'Interne links (≥3)', `${interneLinks} gevonden`,
    'Link vanuit de content naar andere relevante pagina\'s op je site.');

  add(responseMs < 1500, 4, 'Laadtijd server (<1,5s)', `${responseMs} ms`,
    'Optimaliseer laadtijd: caching, compressie (gzip/brotli), kleinere afbeeldingen (WebP).');

  add(statusCode >= 200 && statusCode < 300, 10, 'HTTP-status OK', `Status ${statusCode}`,
    'Los de foutstatus op of verwijder de pagina uit de sitemap.');

  const totGewicht = checks.reduce((s, c) => s + c.gewicht, 0);
  const okGewicht = checks.reduce((s, c) => s + (c.ok ? c.gewicht : 0), 0);
  const score = Math.round((okGewicht / totGewicht) * 100);

  return { score, checks, title, h1: h1s.first().text().trim().slice(0, 100) };
}

// ---------- Hoofdscan ----------
async function scanSite(rawUrl) {
  const base = normalizeBase(rawUrl);
  const siteChecks = await checkSiteLevel(base);

  // Te crawlen pagina's bepalen
  let queue = [base + '/'];
  if (siteChecks.sitemapUrls && siteChecks.sitemapUrls.length) {
    queue = [base + '/', ...siteChecks.sitemapUrls.filter(u => sameHost(base, u))];
  }
  queue = [...new Set(queue.map(u => cleanUrl(base, u)).filter(Boolean))].slice(0, MAX_PAGES);

  const pages = [];
  const gezien = new Set(queue);

  for (let i = 0; i < queue.length && pages.length < MAX_PAGES; i++) {
    const url = queue[i];
    try {
      const { res, ms } = await fetchTimed(url);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('html')) continue;
      const html = await res.text();
      const audit = auditHtml(url, html, res.status, ms);
      pages.push({ url, status_code: res.status, response_ms: ms, ...audit });

      // Geen sitemap? Dan interne links van de homepage volgen
      if (!siteChecks.sitemap && i === 0) {
        const $ = cheerio.load(html);
        $('a[href]').each((_, el) => {
          const u = cleanUrl(base, $(el).attr('href'));
          if (u && sameHost(base, u) && !gezien.has(u) && queue.length < MAX_PAGES) {
            gezien.add(u); queue.push(u);
          }
        });
      }
    } catch (e) {
      pages.push({ url, status_code: 0, response_ms: 0, score: 0,
        checks: [{ ok: false, gewicht: 10, label: 'Pagina bereikbaar', detail: String(e.message || e).slice(0, 120),
                   fix: 'Controleer of de pagina online is en binnen 15s antwoordt.' }] });
    }
  }

  // Site-score: gemiddelde paginascore + site-niveau bonus/malus
  let score = pages.length ? Math.round(pages.reduce((s, p) => s + p.score, 0) / pages.length) : 0;
  if (!siteChecks.sitemap) score = Math.max(0, score - 8);
  if (!siteChecks.robots) score = Math.max(0, score - 4);
  if (!siteChecks.https) score = Math.max(0, score - 10);
  if (siteChecks.robotsBlokkeertAlles) score = Math.max(0, score - 30);

  return { base, score, siteChecks, pages };
}

// ---------- Taken genereren uit scanresultaat ----------
function genereerTaken(result) {
  const taken = [];
  const push = (titel, detail, prioriteit) => taken.push({ titel, detail, prioriteit });

  if (!result.siteChecks.https) push('Zet de site op HTTPS', 'Google straft niet-beveiligde sites af.', 'hoog');
  if (!result.siteChecks.sitemap) push('Voeg een sitemap.xml toe',
    'Genereer een sitemap en dien hem in via Google Search Console.', 'hoog');
  if (!result.siteChecks.robots) push('Voeg robots.txt toe',
    'Met daarin een verwijzing naar je sitemap (Sitemap: https://…/sitemap.xml).', 'middel');
  if (result.siteChecks.robotsBlokkeertAlles) push('robots.txt blokkeert de hele site!',
    'Disallow: / verwijderen, anders indexeert Google niets.', 'hoog');

  // Meest voorkomende paginaproblemen bundelen
  const teller = {};
  for (const p of result.pages) {
    for (const c of p.checks) {
      if (!c.ok) {
        teller[c.label] = teller[c.label] || { n: 0, fix: c.fix, gewicht: c.gewicht };
        teller[c.label].n++;
      }
    }
  }
  for (const [label, info] of Object.entries(teller)) {
    const prio = info.gewicht >= 7 ? 'hoog' : info.gewicht >= 4 ? 'middel' : 'laag';
    push(`${label} — ${info.n} pagina('s)`, info.fix, prio);
  }
  return taken;
}

module.exports = { scanSite, genereerTaken, normalizeBase };
