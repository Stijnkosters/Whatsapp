/**
 * Drivemax Recovery — Railway app
 * - Serveert dashboard op / (met wachtwoord)
 * - API: /api/overview, /api/settings, /api/run (handmatig triggeren)
 * - Cron: elke 15 min recovery-run
 */
const express = require("express");
const cron = require("node-cron");
const path = require("path");
const db = require("./lib/db");
const { runRecovery, getRecovered } = require("./lib/recovery");

const app = express();
app.use(express.json());

// ---------- Basic Auth (heel de app achter wachtwoord) ----------
const USER = process.env.ADMIN_USER || "stijn";
const PASS = process.env.ADMIN_PASSWORD;
app.use((req, res, next) => {
  if (!PASS) return res.status(500).send("ADMIN_PASSWORD env var niet gezet.");
  const hdr = req.headers.authorization || "";
  const [type, cred] = hdr.split(" ");
  if (type === "Basic" && cred) {
    const [u, p] = Buffer.from(cred, "base64").toString().split(":");
    if (u === USER && p === PASS) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Drivemax Recovery"');
  res.status(401).send("Login vereist");
});

app.use(express.static(path.join(__dirname, "public")));

// ---------- API ----------

app.get("/api/overview", async (req, res) => {
  try {
    const [settings, stats] = await Promise.all([db.getSettings(), db.getStats()]);
    const recovered = await getRecovered(settings.reminder2?.discountCode);
    res.json({ settings, stats, recovered, now: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/settings", async (req, res) => {
  try {
    const s = req.body;
    // minimale validatie
    if (!s?.reminder1 || !s?.reminder2 || !s?.languages) throw new Error("Ongeldige settings");
    s.reminder1.delayMinutes = Math.max(15, parseInt(s.reminder1.delayMinutes) || 60);
    s.reminder2.delayMinutes = Math.max(60, parseInt(s.reminder2.delayMinutes) || 1440);
    s.reminder2.discountCode = String(s.reminder2.discountCode || "").trim().toUpperCase();
    await db.saveSettings(s);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/run", async (req, res) => {
  try {
    const result = await runRecovery();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Start ----------

const PORT = process.env.PORT || 3000;
(async () => {
  await db.init();
  cron.schedule("*/15 * * * *", () => {
    runRecovery().catch((e) => console.error("Cron fout:", e.message));
  });
  app.listen(PORT, () => console.log(`Drivemax Recovery live op poort ${PORT}`));
})();
