// db.js — PostgreSQL pool + schema-initialisatie
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : (process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false)
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sites (
      id SERIAL PRIMARY KEY,
      naam TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      zoekwoorden TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS scans (
      id SERIAL PRIMARY KEY,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'bezig', -- bezig | klaar | fout
      score INTEGER,
      site_checks JSONB DEFAULT '{}'::jsonb,
      fout TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      finished_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS scan_pages (
      id SERIAL PRIMARY KEY,
      scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      status_code INTEGER,
      response_ms INTEGER,
      score INTEGER,
      checks JSONB DEFAULT '[]'::jsonb
    );

    CREATE TABLE IF NOT EXISTS instellingen (
      sleutel TEXT PRIMARY KEY,
      waarde TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS uptime (
      id SERIAL PRIMARY KEY,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      ok BOOLEAN NOT NULL,
      status_code INTEGER,
      response_ms INTEGER,
      gemeten_op TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS uptime_site_tijd ON uptime (site_id, gemeten_op);

    CREATE TABLE IF NOT EXISTS taken (
      id SERIAL PRIMARY KEY,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      titel TEXT NOT NULL,
      detail TEXT DEFAULT '',
      prioriteit TEXT DEFAULT 'middel', -- hoog | middel | laag
      bron TEXT DEFAULT 'scan',         -- scan | handmatig | ai
      klaar BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (site_id, titel)
    );
  `);
  // Migratie: stabiele check_id per taak (voor upsert + auto-afvinken bij herscan)
  await pool.query(`
    ALTER TABLE taken ADD COLUMN IF NOT EXISTS check_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS taken_site_check
      ON taken (site_id, check_id) WHERE check_id IS NOT NULL;
  `);
  // Opruimen: open taken over Cloudflare-systeemURL's (/cdn-cgi/) — die worden niet meer gescand
  const { rowCount } = await pool.query(
    `DELETE FROM taken WHERE NOT klaar
       AND (check_id LIKE '%/cdn-cgi/%' OR titel LIKE '%/cdn-cgi/%')`);
  if (rowCount > 0) console.log(`🧹 ${rowCount} open /cdn-cgi/-taken opgeruimd`);
  console.log('✅ Database-schema gereed');
}

module.exports = { pool, init };
