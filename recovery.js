/**
 * Recovery-logica:
 * - abandoned checkouts ophalen uit Shopify
 * - taal bepalen op basis van land klant (NL/BE→nl, DE/AT→de, PL→pl, rest→en)
 * - telefoonnummer normaliseren per land
 * - WhatsApp template versturen in de juiste taal via Meta Cloud API
 * - dedup via Postgres (nooit 2x hetzelfde bericht naar dezelfde checkout)
 */
const db = require("./db");

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const META_PHONE_ID = process.env.META_PHONE_ID;
const META_TOKEN = process.env.META_TOKEN;
const TEMPLATE_1 = process.env.TEMPLATE_1 || "checkout_reminder_1";
const TEMPLATE_2 = process.env.TEMPLATE_2 || "checkout_reminder_2";
const API_VERSION = "2025-01";

// land → WhatsApp template-taalcode (Meta language codes)
// Uitbreiden (bv. RouteGuard/FR): voeg regel toe + maak template-vertaling aan in Meta.
const COUNTRY_LANG = {
  NL: "nl", BE: "nl",
  DE: "de", AT: "de", CH: "de",
  PL: "pl",
  GB: "en_GB", UK: "en_GB", IE: "en_GB", US: "en_GB",
};
const DEFAULT_LANG = "en_GB";
// interne key (voor settings/stats): en_GB → "en"
const langKey = (metaLang) => metaLang.split("_")[0];

// land → landcode voor lokale nummers die met 0 beginnen
const DIAL = { NL: "31", BE: "32", DE: "49", AT: "43", CH: "41", PL: "48", GB: "44", UK: "44", IE: "353" };

// ---------- Shopify ----------

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_TOKEN },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function getAbandonedCheckouts(sinceISO) {
  const query = `
    query($q: String!, $cursor: String) {
      abandonedCheckouts(first: 50, query: $q, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id name createdAt abandonedCheckoutUrl
          totalPriceSet { shopMoney { amount } }
          customer { firstName phone defaultAddress { phone countryCodeV2 } }
          billingAddress { phone countryCodeV2 }
          shippingAddress { phone countryCodeV2 }
          lineItems(first: 1) { nodes { title } }
        }
      }
    }`;
  const q = `created_at:>'${sinceISO}'`;
  let nodes = [], cursor = null;
  do {
    const data = await shopifyGraphQL(query, { q, cursor });
    nodes = nodes.concat(data.abandonedCheckouts.nodes);
    const pi = data.abandonedCheckouts.pageInfo;
    cursor = pi.hasNextPage ? pi.endCursor : null;
  } while (cursor);
  return nodes;
}

// Recovered revenue via kortingscode (attributie reminder 2)
let recoveredCache = { at: 0, data: null };
async function getRecovered(code) {
  if (!code) return null;
  if (Date.now() - recoveredCache.at < 3600000) return recoveredCache.data;
  const query = `
    query($q: String!) {
      orders(first: 100, query: $q) {
        nodes { totalPriceSet { shopMoney { amount } } }
      }
    }`;
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  try {
    const data = await shopifyGraphQL(query, { q: `discount_code:${code} AND created_at:>'${since}'` });
    const orders = data.orders.nodes;
    const revenue = Math.round(orders.reduce((s, o) => s + parseFloat(o.totalPriceSet.shopMoney.amount), 0) * 100) / 100;
    recoveredCache = { at: Date.now(), data: { code, orders: orders.length, revenue } };
    return recoveredCache.data;
  } catch (e) {
    console.error("Recovered-query fout:", e.message);
    return recoveredCache.data;
  }
}

// ---------- Land, taal, telefoon ----------

function getCountry(c) {
  return (
    c.shippingAddress?.countryCodeV2 ||
    c.billingAddress?.countryCodeV2 ||
    c.customer?.defaultAddress?.countryCodeV2 ||
    null
  );
}

function normalizePhone(raw, country) {
  if (!raw) return null;
  let p = raw.replace(/[\s\-().]/g, "");
  if (p.startsWith("00")) p = "+" + p.slice(2);
  if (p.startsWith("0") && !p.startsWith("+")) {
    const dial = DIAL[country] || "31";
    p = "+" + dial + p.slice(1);
  }
  if (!p.startsWith("+")) {
    if (/^(31|32|49|43|41|48|44|353)\d{7,}$/.test(p)) {
      // begint al met landcode
      p = "+" + p;
    } else if (DIAL[country] && /^\d{8,10}$/.test(p)) {
      // lokaal formaat zonder voorloop-0 (bv. Pools: 601234567) → landcode ervoor
      p = "+" + DIAL[country] + p;
    } else {
      return null;
    }
  }
  const digits = p.slice(1).replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 15) return null;
  return digits;
}

function extractPhone(c, country) {
  return (
    normalizePhone(c.customer?.phone, country) ||
    normalizePhone(c.shippingAddress?.phone, country) ||
    normalizePhone(c.billingAddress?.phone, country) ||
    normalizePhone(c.customer?.defaultAddress?.phone, country)
  );
}

const maskPhone = (d) => (d ? d.slice(0, 4) + "•••" + d.slice(-3) : "");

// ---------- WhatsApp ----------

async function sendTemplate(phone, templateName, metaLang, bodyParams) {
  const res = await fetch(`https://graph.facebook.com/v21.0/${META_PHONE_ID}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${META_TOKEN}` },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: {
        name: templateName,
        language: { code: metaLang },
        components: [{ type: "body", parameters: bodyParams.map((t) => ({ type: "text", text: t })) }],
      },
    }),
  });
  const json = await res.json();
  if (json.error) {
    console.error(`  ✗ WA fout ${maskPhone(phone)} [${metaLang}]: ${json.error.message}`);
    return false;
  }
  console.log(`  ✓ ${templateName} [${metaLang}] → ${maskPhone(phone)}`);
  return true;
}

// ---------- Hoofd-run (elke 15 min via cron) ----------

async function runRecovery() {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN || !META_PHONE_ID || !META_TOKEN) {
    console.error("Env vars ontbreken — run overgeslagen.");
    return { sent: 0, error: "env" };
  }
  const s = await db.getSettings();
  const since = new Date(Date.now() - 3 * 86400000).toISOString();
  const checkouts = await getAbandonedCheckouts(since);
  console.log(`[run ${new Date().toISOString()}] ${checkouts.length} open abandoned checkout(s)`);

  const reminders = [
    { n: 1, cfg: s.reminder1, template: TEMPLATE_1, withDiscount: false },
    { n: 2, cfg: s.reminder2, template: TEMPLATE_2, withDiscount: true },
  ];
  const graceMin = (s.maxAgeGraceHours || 12) * 60;
  let sent = 0;

  for (const c of checkouts) {
    const ageMin = (Date.now() - new Date(c.createdAt).getTime()) / 60000;
    const country = getCountry(c);
    const metaLang = COUNTRY_LANG[country] || DEFAULT_LANG;
    if (!s.languages[langKey(metaLang)]) continue; // taal uitgeschakeld in dashboard
    const phone = extractPhone(c, country);
    if (!phone || !c.abandonedCheckoutUrl) continue;
    const firstName = c.customer?.firstName || "";

    for (const r of reminders) {
      if (!r.cfg?.enabled) continue;
      if (ageMin < r.cfg.delayMinutes || ageMin > r.cfg.delayMinutes + graceMin) continue;
      if (await db.hasSent(c.id, r.n)) continue;
      if (r.withDiscount && !s.reminder2.discountCode) continue;

      const params = r.withDiscount
        ? [firstName || "-", s.reminder2.discountCode, c.abandonedCheckoutUrl]
        : [firstName || "-", c.abandonedCheckoutUrl];

      const ok = await sendTemplate(phone, r.template, metaLang, params);
      if (ok) {
        await db.recordSent({
          checkoutId: c.id,
          checkoutName: c.name,
          reminder: r.n,
          phoneMasked: maskPhone(phone),
          firstName,
          amount: parseFloat(c.totalPriceSet?.shopMoney?.amount || 0),
          product: c.lineItems?.nodes?.[0]?.title || "",
          lang: langKey(metaLang),
          country: country || "?",
        });
        sent++;
      }
      await new Promise((r2) => setTimeout(r2, 300));
    }
  }
  console.log(`Run klaar: ${sent} bericht(en) verstuurd`);
  return { sent, checkouts: checkouts.length };
}

module.exports = { runRecovery, getRecovered };
