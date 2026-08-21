# RankWerk

SEO-controlekamer voor al je sites. Voeg sites toe, scan ze automatisch, krijg een score per site en per pagina, en werk de gegenereerde takenlijst af.

## Wat het doet

- **Scanner**: crawlt max 15 pagina's per site (via sitemap.xml, anders interne links) en controleert per pagina: title, meta description, H1, canonical, noindex, lang, viewport, Open Graph, structured data (JSON-LD), alt-teksten, contentlengte, interne links, laadtijd en HTTP-status.
- **Site-niveau**: HTTPS, robots.txt, sitemap.xml, favicon, en waarschuwt als robots.txt de hele site blokkeert.
- **Score 0–100** per pagina en per site, met kleurcodering (groen/oranje/rood).
- **Takenlijst**: elke scan genereert automatisch taken met prioriteit; afvinken en eigen taken toevoegen kan.
- **AI-actieplan** (optioneel): met een `ANTHROPIC_API_KEY` maakt Claude na elke scan automatisch een concreet Nederlands actieplan en zet het uitvoerbare werk als AI-taken klaar.

## Installatie (Railway)

1. Repo naar GitHub pushen (ZIP → GitHub Desktop → push).
2. Nieuw Railway-project → deploy from repo.
3. PostgreSQL toevoegen in hetzelfde project.
4. Environment variables op de app-service:
   - `DATABASE_URL` → `${{Postgres.DATABASE_URL}}`
   - `ANTHROPIC_API_KEY` → (optioneel, voor AI-advies)
5. Klaar — schema wordt automatisch aangemaakt bij de eerste start.

## Lokaal draaien

```bash
npm install
DATABASE_URL=postgres://... node server.js
```

## Let op

- Er zit **geen login** op deze tool. Zet hem achter een privé-URL of voeg basic auth toe voordat je hem publiek deployt.
- Een scan draait op de achtergrond; ververs de sitepagina na ±30 seconden.

## Beveiliging & planner (v2)

**2FA-login**: zet `ADMIN_WACHTWOORD` en `SESSION_SECRET` in Railway. Eerste login: wachtwoord → QR-code scannen met je authenticator-app → code bevestigen. Daarna altijd wachtwoord + 6-cijferige code.

**24/7 planner** (start automatisch mee):
- Elke 60 seconden: uptime-check op al je sites (online-indicator + 24u-percentage op het dashboard).
- Doorlopende scanrotatie: elke site wordt maximaal 1× per 24 uur volledig gescand (`SCAN_INTERVAL_MIN` om aan te passen); nieuwe problemen worden direct taken.
- Dagrapport per e-mail om 7:00 (`RAPPORT_UUR`): scores met verschil t.o.v. vorige scan, open taken, uptime. Vereist `RESEND_API_KEY`, `RAPPORT_EMAIL` en optioneel `RAPPORT_VAN` (geverifieerd Resend-domein).

**Alle environment variables**
| Variabele | Verplicht | Uitleg |
|---|---|---|
| `DATABASE_URL` | ja | `${{Postgres.DATABASE_URL}}` |
| `ADMIN_WACHTWOORD` | ja (productie) | Zonder deze staat de tool open |
| `SESSION_SECRET` | ja (productie) | Lange willekeurige string |
| `RESEND_API_KEY` | voor rapport | Resend API-key |
| `RAPPORT_EMAIL` | voor rapport | Ontvanger van het dagrapport |
| `RAPPORT_VAN` | optioneel | Afzender, bijv. `RankWerk <rapport@jouwdomein.nl>` |
| `RAPPORT_UUR` | optioneel | Uur van verzending (standaard 7) |
| `SCAN_INTERVAL_MIN` | optioneel | Min. minuten tussen scans per site (standaard 1440 = 24 uur) |
| `ANTHROPIC_API_KEY` | optioneel | AI-actieplan per site |
