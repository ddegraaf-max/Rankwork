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

// Binaire/niet-HTML bestanden horen niet door de meta/content-checks
// (geen title/description/noindex/woordenaantal-oordeel over een PDF)
const BINAIR = /\.(pdf|jpe?g|png|gif|webp|svg|ico|zip|rar|7z|docx?|xlsx?|pptx?|mp[34]|mov|avi|webm|woff2?|ttf|eot|css|js|json|xml|txt)(\?|$)/i;
function isBinair(url) { return BINAIR.test(url); }

// Ziet de tekst er echt uit als robots.txt (en niet als HTML-fallback)?
function lijktRobots(txt) {
  if (/<html|<!doctype/i.test(txt.slice(0, 300))) return false;
  return /^(user-agent|disallow|allow|sitemap|crawl-delay)\s*:/mi.test(txt);
}
function lijktSitemap(xml) {
  return /<urlset|<sitemapindex/i.test(xml);
}

// Parseert robots.txt in user-agent-blokken
function parseRobotsBlokken(txt) {
  const blokken = [];
  let huidige = null;
  for (const ruwe of txt.split(/\r?\n/)) {
    const regel = ruwe.replace(/#.*$/, '').trim();
    if (!regel) continue;
    const m = regel.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const veld = m[1].toLowerCase(), waarde = m[2].trim();
    if (veld === 'user-agent') {
      // opeenvolgende user-agent-regels horen bij hetzelfde blok
      if (!huidige || huidige.regels.length > 0) {
        huidige = { agents: [], regels: [] };
        blokken.push(huidige);
      }
      huidige.agents.push(waarde.toLowerCase());
    } else if ((veld === 'disallow' || veld === 'allow') && huidige) {
      huidige.regels.push({ veld, waarde });
    }
  }
  return blokken;
}

// Beoordeelt of GOOGLE (of *) daadwerkelijk volledig geblokkeerd wordt.
// Een "Disallow: /" die alleen voor AI-bots geldt (GPTBot, ClaudeBot, enz. —
// bijv. Cloudflare's managed robots.txt) is GEEN blokkade voor de zoekindexering.
function robotsBlokkeertGoogle(txt) {
  const blokken = parseRobotsBlokken(txt);
  // Meest specifieke match wint: een expliciet Googlebot-blok gaat vóór het *-blok
  const googleBlok = blokken.find(b => b.agents.some(a => a === 'googlebot'))
                  || blokken.find(b => b.agents.includes('*'));
  if (!googleBlok) return false;
  const disallowAlles = googleBlok.regels.some(r => r.veld === 'disallow' && r.waarde === '/');
  const allowAlles = googleBlok.regels.some(r => r.veld === 'allow' && (r.waarde === '/' || r.waarde === ''));
  return disallowAlles && !allowAlles;
}

// Regels (allow/disallow) die voor onze eigen crawler gelden: RankWerkBot-blok, anders *-blok
function robotsRegelsVoorCrawler(txt) {
  const blokken = parseRobotsBlokken(txt);
  const blok = blokken.find(b => b.agents.some(a => a.includes('rankwerkbot')))
            || blokken.find(b => b.agents.includes('*'));
  return blok ? blok.regels : [];
}

// Robots-regel → regex (met * als wildcard en $ als eind-anker, zoals Google het doet)
function robotsRegex(waarde) {
  let eindAnker = false;
  if (waarde.endsWith('$')) { eindAnker = true; waarde = waarde.slice(0, -1); }
  const pat = waarde.split('*')
    .map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + pat + (eindAnker ? '$' : ''));
}

// Mag dit pad gecrawld worden volgens de regels? Langste match wint; allow wint bij gelijkspel.
function magVanRobots(regels, pad) {
  let besteLen = -1, mag = true;
  for (const r of regels) {
    if (!r.waarde) continue; // lege Disallow = alles toegestaan
    if (robotsRegex(r.waarde).test(pad)) {
      const len = r.waarde.length;
      if (len > besteLen) { besteLen = len; mag = (r.veld === 'allow'); }
      else if (len === besteLen && r.veld === 'allow') mag = true;
    }
  }
  return mag;
}

// ---------- Site-niveau checks ----------
async function checkSiteLevel(base) {
  const out = { https: base.startsWith('https://') };

  // Catch-all-detectie: geeft de server voor élk pad een 200 terug?
  // (Veel Express-apps doen dit; dan bewijst een 200 op /robots.txt niets.)
  try {
    const { res } = await fetchTimed(base + '/rankwerk-bestaat-niet-' + Date.now());
    out.catchAll = res.ok;
  } catch { out.catchAll = false; }

  // robots.txt — alleen geldig als de inhoud er ook echt als robots.txt uitziet
  out.robots = false;
  try {
    const { res } = await fetchTimed(base + '/robots.txt');
    if (res.ok) {
      const txt = await res.text();
      if (lijktRobots(txt)) {
        out.robots = true;
        out.robotsBlokkeertAlles = robotsBlokkeertGoogle(txt);
        out.crawlRegels = robotsRegelsVoorCrawler(txt);
        const m = txt.match(/Sitemap:\s*(\S+)/i);
        if (m) out.sitemapInRobots = m[1];
      }
    }
  } catch { /* geen robots.txt */ }

  // sitemap.xml — alleen geldig als het echt sitemap-XML is
  const sitemapCandidates = [out.sitemapInRobots, base + '/sitemap.xml'].filter(Boolean);
  out.sitemap = false;
  out.sitemapUrls = [];
  for (const sm of sitemapCandidates) {
    try {
      const { res } = await fetchTimed(sm);
      if (!res.ok) continue;
      const xml = await res.text();
      if (!lijktSitemap(xml)) continue;
      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
      if (locs.length) {
        // sitemap-index? volg eerste sub-sitemap
        if (/<sitemapindex/i.test(xml)) {
          try {
            const { res: r2 } = await fetchTimed(locs[0]);
            if (r2.ok) {
              const xml2 = await r2.text();
              if (lijktSitemap(xml2)) {
                out.sitemapUrls = [...xml2.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1]);
              }
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

  // favicon — een HTML-antwoord telt niet als favicon
  out.favicon = false;
  try {
    const { res } = await fetchTimed(base + '/favicon.ico');
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    out.favicon = res.ok && !ct.includes('html');
  } catch { /* geen favicon */ }

  return out;
}

// Herkent challenge-pagina's van botbescherming (Cloudflare e.d.)
// zodat we geen valse "title ontbreekt"-meldingen geven op een blokkadepagina.
function isBotChallenge(html, statusCode) {
  const kop = html.slice(0, 4000).toLowerCase();
  return /just a moment|attention required|checking your browser|cf-chl|challenge-platform|ddos-guard|__cf_chl/i.test(kop)
    || (statusCode === 403 && /cloudflare/i.test(kop))
    || statusCode === 503 && /cloudflare|enable javascript/i.test(kop);
}

// ---------- Pagina-niveau checks ----------
function auditHtml(url, html, statusCode, responseMs) {
  if (isBotChallenge(html, statusCode)) {
    return {
      geblokkeerd: true, score: null, title: '', h1: '',
      checks: [{ ok: false, gewicht: 10, label: 'Scanner geblokkeerd door botbescherming',
        detail: `De site toont een challenge-pagina (bijv. Cloudflare) aan RankWerkBot; de echte pagina kon niet worden beoordeeld.`,
        fix: 'Whitelist de RankWerkBot user-agent of het IP van je RankWerk-server in je botbescherming. Deze pagina telt niet mee in de score.' }]
    };
  }
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

  // Mag deze URL gescand worden?
  //  • nooit /cdn-cgi/ (Cloudflare-systeemURL's zoals email-protection)
  //  • geen binaire bestanden
  //  • respecteer de Disallow-regels uit de robots.txt van de site zelf
  const crawlRegels = siteChecks.crawlRegels || [];
  const magScannen = (u) => {
    if (!u || isBinair(u)) return false;
    let padMetQuery;
    try { const p = new URL(u); padMetQuery = (p.pathname || '/') + (p.search || ''); }
    catch { return false; }
    if (padMetQuery.includes('/cdn-cgi/')) return false;
    return magVanRobots(crawlRegels, padMetQuery);
  };

  // Te crawlen pagina's bepalen
  let queue = [base + '/'];
  if (siteChecks.sitemapUrls && siteChecks.sitemapUrls.length) {
    queue = [base + '/', ...siteChecks.sitemapUrls.filter(u => sameHost(base, u))];
  }
  queue = [...new Set(queue.map(u => cleanUrl(base, u)).filter(magScannen))].slice(0, MAX_PAGES);

  const pages = [];
  const gezien = new Set(queue);

  for (let i = 0; i < queue.length && pages.length < MAX_PAGES; i++) {
    const url = queue[i];
    try {
      const { res, ms } = await fetchTimed(url);
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      // Backstop: ook op content-type filteren (bijv. een PDF zonder .pdf in de URL)
      if (!ct.includes('html')) continue;
      const html = await res.text();
      const audit = auditHtml(url, html, res.status, ms);
      pages.push({ url, status_code: res.status, response_ms: ms, ...audit });

      // Geen sitemap? Dan interne links van de homepage volgen
      if (!siteChecks.sitemap && i === 0) {
        const $ = cheerio.load(html);
        $('a[href]').each((_, el) => {
          const u = cleanUrl(base, $(el).attr('href'));
          if (u && sameHost(base, u) && magScannen(u) && !gezien.has(u) && queue.length < MAX_PAGES) {
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

  // Site-score: gemiddelde van betrouwbaar gescande pagina's + site-niveau bonus/malus
  // (door botbescherming geblokkeerde pagina's tellen niet mee)
  const scoorbaar = pages.filter(p => p.score !== null && p.score !== undefined);
  let score = scoorbaar.length
    ? Math.round(scoorbaar.reduce((s, p) => s + p.score, 0) / scoorbaar.length)
    : null;
  if (score !== null) {
    if (!siteChecks.sitemap) score = Math.max(0, score - 8);
    if (!siteChecks.robots) score = Math.max(0, score - 4);
    if (!siteChecks.https) score = Math.max(0, score - 10);
    if (siteChecks.robotsBlokkeertAlles) score = Math.max(0, score - 30);
  }

  return { base, score, siteChecks, pages };
}

module.exports = { scanSite, normalizeBase };
