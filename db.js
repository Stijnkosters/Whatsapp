/**
 * Database-laag (Railway Postgres via DATABASE_URL)
 * - sent_messages: elk verstuurd bericht (dedup + dashboard)
 * - settings: instelbaar via dashboard
 */
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

const DEFAULT_SETTINGS = {
  reminder1: { enabled: true, delayMinutes: 60 },
  reminder2: { enabled: true, delayMinutes: 1440, discountCode: "TERUG5" },
  languages: { nl: true, de: true, pl: true, en: true },
  maxAgeGraceHours: 12, // hoe lang na de delay een cart nog benaderd mag worden
};

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sent_messages (
      id SERIAL PRIMARY KEY,
      checkout_id TEXT NOT NULL,
      checkout_name TEXT,
      reminder INT NOT NULL,
      phone_masked TEXT,
      first_name TEXT,
      amount NUMERIC DEFAULT 0,
      product TEXT,
      lang TEXT,
      country TEXT,
      sent_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (checkout_id, reminder)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
  `);
  const r = await pool.query(`SELECT 1 FROM settings WHERE key='config'`);
  if (!r.rowCount) {
    await pool.query(`INSERT INTO settings (key, value) VALUES ('config', $1)`, [
      JSON.stringify(DEFAULT_SETTINGS),
    ]);
  }
}

async function getSettings() {
  const r = await pool.query(`SELECT value FROM settings WHERE key='config'`);
  // merge met defaults zodat nieuwe velden na updates altijd bestaan
  return { ...DEFAULT_SETTINGS, ...(r.rows[0]?.value || {}) };
}

async function saveSettings(value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('config', $1)
     ON CONFLICT (key) DO UPDATE SET value = $1`,
    [JSON.stringify(value)]
  );
}

async function hasSent(checkoutId, reminder) {
  const r = await pool.query(
    `SELECT 1 FROM sent_messages WHERE checkout_id=$1 AND reminder=$2`,
    [checkoutId, reminder]
  );
  return r.rowCount > 0;
}

async function recordSent(m) {
  await pool.query(
    `INSERT INTO sent_messages
       (checkout_id, checkout_name, reminder, phone_masked, first_name, amount, product, lang, country)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (checkout_id, reminder) DO NOTHING`,
    [m.checkoutId, m.checkoutName, m.reminder, m.phoneMasked, m.firstName, m.amount, m.product, m.lang, m.country]
  );
}

async function getStats() {
  const totals = await pool.query(`
    SELECT reminder,
           COUNT(*)::int AS sent,
           COALESCE(SUM(amount),0)::float AS cart_value
    FROM sent_messages
    WHERE sent_at > now() - interval '30 days'
    GROUP BY reminder
  `);
  const perDay = await pool.query(`
    SELECT to_char(sent_at AT TIME ZONE 'Europe/Amsterdam','YYYY-MM-DD') AS day,
           reminder, COUNT(*)::int AS n
    FROM sent_messages
    WHERE sent_at > now() - interval '14 days'
    GROUP BY 1,2 ORDER BY 1
  `);
  const perLang = await pool.query(`
    SELECT lang, COUNT(*)::int AS n
    FROM sent_messages
    WHERE sent_at > now() - interval '30 days'
    GROUP BY lang ORDER BY n DESC
  `);
  const recent = await pool.query(`
    SELECT checkout_name, reminder, phone_masked, first_name, amount::float,
           product, lang, country, sent_at
    FROM sent_messages ORDER BY sent_at DESC LIMIT 30
  `);
  return {
    totals: totals.rows,
    perDay: perDay.rows,
    perLang: perLang.rows,
    recent: recent.rows,
  };
}

module.exports = { pool, init, getSettings, saveSettings, hasSent, recordSent, getStats };
