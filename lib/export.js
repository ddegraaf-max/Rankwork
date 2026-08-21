// lib/export.js — zet een scanresultaat om in een deelbaar Markdown-rapport,
// bijv. om in Claude (claude.ai) te plakken of te uploaden voor verdere analyse.
function ok(v) { return v ? '✅' : '❌'; }

function scanNaarMarkdown(site, scan, pages, taken) {
  const sc = scan.site_checks || {};
  const r = [];
  r.push(`# SEO-scanrapport — ${site.naam}`);
  r.push('');
  r.push(`- Site: ${site.url}`);
  if (site.zoekwoorden) r.push(`- Zoekwoorden: ${site.zoekwoorden}`);
  r.push(`- Gescand: ${new Date(scan.created_at).toLocaleString('nl-NL')}`);
  r.push(`- Sitescore: **${scan.score ?? '—'}/100**`);
  r.push('');
  r.push('## Site-niveau');
  r.push(`- ${ok(sc.https)} HTTPS`);
  r.push(`- ${ok(sc.robots)} robots.txt`);
  r.push(`- ${ok(sc.sitemap)} sitemap.xml${sc.sitemap ? ` (${sc.sitemapAantal} URL's)` : ''}`);
  r.push(`- ${ok(sc.favicon)} favicon`);
  r.push(`- ${ok(!sc.catchAll)} echte 404-pagina${sc.catchAll ? ' (elk pad geeft een 200 terug — soft-404)' : ''}`);
  if (sc.httpsRedirect !== undefined) r.push(`- ${ok(sc.httpsRedirect)} http → https redirect`);
  if (sc.wwwRedirect !== undefined) r.push(`- ${ok(sc.wwwRedirect)} www-consistentie (${sc.wwwVariant || ''})`);
  if (sc.dubbeleTitles !== undefined) {
    r.push(`- ${ok(!sc.dubbeleTitles)} unieke page titles${sc.dubbeleTitles ? ` (${sc.dubbeleTitles} pagina's met dezelfde title)` : ''}`);
    r.push(`- ${ok(!sc.dubbeleDescriptions)} unieke descriptions${sc.dubbeleDescriptions ? ` (${sc.dubbeleDescriptions} pagina's met dezelfde description)` : ''}`);
  }
  if (sc.robotsBlokkeertAlles) r.push('- ❌ **robots.txt blokkeert de hele site!**');
  const psi = sc.pagespeed;
  if (psi && !psi.fout && psi.score != null) {
    r.push(`- ${ok(psi.score >= 50)} PageSpeed ${psi.score}/100 (${psi.bron}`
      + (psi.lcpMs ? `, LCP ${(psi.lcpMs / 1000).toFixed(1)}s` : '')
      + (psi.cls != null ? `, CLS ${psi.cls}` : '')
      + (psi.inp ? `, INP ${psi.inp} ms` : '') + ')');
  }
  r.push('');
  r.push(`## Pagina's (${pages.length})`);
  for (const p of pages) {
    const checks = p.checks || [];
    const fouten = checks.filter(c => !c.ok);
    r.push('');
    r.push(`### ${p.url} — score ${p.score ?? '—'} (HTTP ${p.status_code}, ${p.response_ms} ms)`);
    for (const c of fouten) r.push(`- ❌ ${c.label} — ${c.detail}${c.fix ? ` → ${c.fix}` : ''}`);
    if (!fouten.length) r.push('- ✅ Alle checks in orde');
    else if (checks.length - fouten.length > 0) r.push(`- ✅ ${checks.length - fouten.length} overige checks in orde`);
  }
  if (taken && taken.length) {
    r.push('');
    r.push(`## Open taken (${taken.length})`);
    for (const t of taken) r.push(`- [${t.prioriteit}] ${t.titel}${t.detail ? ` — ${t.detail}` : ''}`);
  }
  r.push('');
  r.push('---');
  r.push('_Gemaakt met RankWerk. Tip: plak of upload dit rapport in Claude en vraag bijv.: '
    + '"Analyseer dit SEO-rapport en geef een concreet stappenplan met prioriteiten."_');
  return r.join('\n');
}

function bestandsnaam(site, scan, ext) {
  const slug = (site.naam || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `rankwerk-${slug}-scan${scan.id}.${ext}`;
}

module.exports = { scanNaarMarkdown, bestandsnaam };
