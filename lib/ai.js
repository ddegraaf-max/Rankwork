// lib/ai.js — SEO-advies via de Anthropic API (optioneel, werkt alleen met ANTHROPIC_API_KEY)
const KEY = process.env.ANTHROPIC_API_KEY;

async function seoAdvies(site, scanResult) {
  if (!KEY) return null;
  const samenvatting = {
    site: site.url,
    zoekwoorden: site.zoekwoorden,
    score: scanResult.score,
    siteChecks: scanResult.siteChecks,
    paginas: scanResult.pages.map(p => ({
      url: p.url, score: p.score, title: p.title,
      problemen: p.checks.filter(c => !c.ok).map(c => c.label)
    }))
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `Je bent een Nederlandse SEO-specialist. Hieronder een scanresultaat van een site.
Geef in het Nederlands een kort, concreet actieplan (max ~350 woorden) in platte tekst:
1) De 3 belangrijkste quick wins, 2) contentadvies passend bij de zoekwoorden,
3) één structureel advies voor de lange termijn. Geen inleiding, direct beginnen.

${JSON.stringify(samenvatting, null, 2)}`
      }]
    })
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error('Anthropic API-fout: ' + t.slice(0, 200));
  }
  const data = await res.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

module.exports = { seoAdvies, aiBeschikbaar: !!KEY };
