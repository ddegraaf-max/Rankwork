// lib/ai.js — SEO-advies via de Anthropic API (optioneel, werkt alleen met ANTHROPIC_API_KEY)
const KEY = process.env.ANTHROPIC_API_KEY;
const { pool } = require('../db');

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
BELANGRIJK: baseer je uitsluitend op de meegegeven scandata. Verzin geen problemen die er niet in staan,
en herhaal geen punten die volgens de data al in orde zijn. Vermeld bij twijfel dat handmatige controle nodig is.
Houd rekening met het sitetype: voor een kleine site of one-pager zijn adviezen als "landingspagina's per stad"
strategische lange-termijnkeuzes, geen quick wins — benoem dat dan zo.
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

async function verwerkActieplan(site, scanResult) {
  const actieplan = await maakActieplan(site, scanResult);
  if (!actieplan) return null;
  await pool.query('UPDATE sites SET ai_plan = $1 WHERE id = $2', [actieplan.plan, site.id]);
  for (const actie of actieplan.acties) {
    await pool.query(
      `INSERT INTO taken (site_id, titel, detail, prioriteit, bron, klaar)
       VALUES ($1, $2, $3, $4, 'ai', false)
       ON CONFLICT (site_id, titel) DO UPDATE SET detail = EXCLUDED.detail,
         prioriteit = EXCLUDED.prioriteit, bron = 'ai', klaar = false`,
      [site.id, actie.titel, actie.detail, actie.prioriteit]);
  }
  return actieplan;
}

module.exports = { seoAdvies, maakActieplan, verwerkActieplan, aiBeschikbaar: !!KEY };
