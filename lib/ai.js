// lib/ai.js — SEO-advies via de Anthropic API (optioneel, werkt alleen met ANTHROPIC_API_KEY)
const KEY = process.env.ANTHROPIC_API_KEY;
const { pool } = require('../db');

async function maakActieplan(site, scanResult) {
  if (!KEY) return null;
  const samenvatting = {
    site: site.url,
    zoekwoorden: site.zoekwoorden,
    score: scanResult.score,
    siteChecks: scanResult.siteChecks,
    paginas: scanResult.pages.map(p => ({
      url: p.url, score: p.score, title: p.title,
      problemen: p.checks.filter(c => !c.ok).map(c => ({ label: c.label, detail: c.detail, fix: c.fix }))
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
      max_tokens: 1600,
      messages: [{
        role: 'user',
        content: `Maak uitsluitend een JSON-object met deze vorm: {"plan":"...","acties":[{"titel":"...","detail":"...","prioriteit":"hoog|middel|laag"}]}.
Gebruik alleen problemen uit de scandata hieronder. Maak maximaal 5 acties die iemand concreet kan uitvoeren. Verzin geen toegang, bestanden of wijzigingen. Benoem bij acties die handmatige controle of toegang tot een CMS/server vereisen dat expliciet in detail. Schrijf in het Nederlands. Het plan is kort en praktisch; acties mogen geen markdown bevatten.

${JSON.stringify(samenvatting, null, 2)}`
      }]
    })
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error('Anthropic API-fout: ' + t.slice(0, 200));
  }
  const data = await res.json();
  const tekst = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const json = tekst.replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  try {
    const plan = JSON.parse(json);
    if (!plan || typeof plan.plan !== 'string' || !Array.isArray(plan.acties)) return null;
    plan.acties = plan.acties.filter(a => a && typeof a.titel === 'string').slice(0, 5)
      .map(a => ({ titel: a.titel.trim().slice(0, 200), detail: String(a.detail || '').trim(),
        prioriteit: ['hoog', 'middel', 'laag'].includes(a.prioriteit) ? a.prioriteit : 'middel' }));
    return { plan: plan.plan.trim(), acties: plan.acties };
  } catch {
    return null;
  }
}

// Maakt het actieplan en houdt de status bij op de site (bezig → klaar/fout),
// zodat de sitepagina kan tonen dat de scandata wordt verzameld en geanalyseerd.
async function verwerkActieplan(site, scanResult) {
  if (!KEY) return null;
  await pool.query(`UPDATE sites SET ai_status = 'bezig' WHERE id = $1`, [site.id]);
  try {
    const actieplan = await maakActieplan(site, scanResult);
    if (!actieplan) {
      await pool.query(`UPDATE sites SET ai_status = 'fout' WHERE id = $1`, [site.id]);
      return null;
    }
    await pool.query(
      `UPDATE sites SET ai_plan = $1, ai_status = 'klaar', ai_plan_op = now() WHERE id = $2`,
      [actieplan.plan, site.id]);
    // Oude open AI-taken opruimen: het nieuwe plan is op de nieuwste scan gebaseerd en
    // vervangt de vorige adviezen volledig (afgevinkte AI-taken blijven staan als historie)
    await pool.query(`DELETE FROM taken WHERE site_id = $1 AND bron = 'ai' AND NOT klaar`, [site.id]);
    for (const actie of actieplan.acties) {
      await pool.query(
        `INSERT INTO taken (site_id, titel, detail, prioriteit, bron, klaar)
         VALUES ($1, $2, $3, $4, 'ai', false)
         ON CONFLICT (site_id, titel) DO UPDATE SET detail = EXCLUDED.detail,
           prioriteit = EXCLUDED.prioriteit, bron = 'ai', klaar = false`,
        [site.id, actie.titel, actie.detail, actie.prioriteit]);
    }
    return actieplan;
  } catch (e) {
    await pool.query(`UPDATE sites SET ai_status = 'fout' WHERE id = $1`, [site.id]).catch(() => {});
    throw e;
  }
}

module.exports = { maakActieplan, verwerkActieplan, aiBeschikbaar: !!KEY };
