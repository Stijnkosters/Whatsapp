# Drivemax Recovery — Railway Setup

WhatsApp abandoned checkout recovery in 4 talen (NL/DE/PL/EN) + live dashboard met instellingen.
Vervangt CK: WhatsApp (€42/mnd). Kosten: Railway ~$5/mnd + Meta per bericht (~€0,05–0,10).

---

## STAP 1 — GitHub repo (5 min)

1. Maak op github.com een **private** repo: `drivemax-recovery`
2. Upload alle bestanden uit deze map (mapstructuur behouden):

```
package.json
server.js
lib/db.js
lib/recovery.js
public/index.html
.gitignore
```

## STAP 2 — Railway (10 min)

1. Ga naar https://railway.app → log in met GitHub
2. **New Project → Deploy from GitHub repo** → kies `drivemax-recovery`
3. In het project: **+ New → Database → PostgreSQL** (Railway koppelt `DATABASE_URL` automatisch aan je service — check bij de service onder Variables of hij er staat; zo niet: voeg een Variable Reference toe naar Postgres)
4. Klik op je service → **Variables** → voeg toe:

| Variable | Waarde |
|---|---|
| `SHOPIFY_STORE` | `ji4svd-yf.myshopify.com` |
| `SHOPIFY_TOKEN` | `shpat_...` (zie stap 4) |
| `META_PHONE_ID` | uit Meta (zie stap 3) |
| `META_TOKEN` | system user token uit Meta |
| `ADMIN_USER` | `stijn` |
| `ADMIN_PASSWORD` | sterk wachtwoord — dit is de login van je dashboard |

5. **Settings → Networking → Generate Domain** → je krijgt een URL zoals `drivemax-recovery.up.railway.app`. Dat is je dashboard.
6. (Optioneel) Custom domain: voeg `recovery.drivemax.nl` toe als CNAME.

Deploy gaat automatisch bij elke push naar GitHub.

## STAP 3 — Meta WhatsApp Business API (30 min + goedkeuring)

1. https://developers.facebook.com → Create App → type "Business"
2. Product **WhatsApp** toevoegen
3. Apart zakelijk telefoonnummer registreren (niet je persoonlijke WhatsApp)
4. Noteer **Phone Number ID** → env var `META_PHONE_ID`
5. Business Settings → System Users → maak admin aan → genereer token met
   `whatsapp_business_messaging` + `whatsapp_business_management`, "Never expire" → `META_TOKEN`

### Templates indienen — 4 talen

Belangrijk: in Meta maak je **één template-naam** aan en voegt daar **taalversies** aan toe
(WhatsApp Manager → Message Templates → Create Template → daarna per taal "Add language").

**Template `checkout_reminder_1`** — categorie Utility:

| Taal | Body |
|---|---|
| Nederlands (nl) | `Hoi {{1}}, je bestelling bij Drivemax staat nog voor je klaar. Rond hem hier af: {{2}}` |
| Duits (de) | `Hallo {{1}}, deine Bestellung bei Drivemax wartet noch auf dich. Hier kannst du sie abschließen: {{2}}` |
| Pools (pl) | `Cześć {{1}}, Twoje zamówienie w Drivemax wciąż na Ciebie czeka. Dokończ je tutaj: {{2}}` |
| Engels (en_GB) | `Hi {{1}}, your Drivemax order is still waiting for you. Complete it here: {{2}}` |

**Template `checkout_reminder_2`** — categorie Marketing:

| Taal | Body |
|---|---|
| Nederlands (nl) | `Hoi {{1}}, je winkelwagen bij Drivemax staat nog steeds klaar. Met code {{2}} krijg je 5% extra korting. Rond je bestelling hier af: {{3}}` |
| Duits (de) | `Hallo {{1}}, dein Warenkorb bei Drivemax ist noch da. Mit dem Code {{2}} erhältst du 5% Extra-Rabatt. Schließe deine Bestellung hier ab: {{3}}` |
| Pools (pl) | `Cześć {{1}}, Twój koszyk w Drivemax wciąż czeka. Z kodem {{2}} otrzymasz dodatkowe 5% rabatu. Dokończ zamówienie tutaj: {{3}}` |
| Engels (en_GB) | `Hi {{1}}, your Drivemax cart is still there. Use code {{2}} for an extra 5% off. Complete your order here: {{3}}` |

> Tips: geen emoji's/ALL CAPS (afkeurrisico). Elke taalversie wordt apart beoordeeld.
> Kortingscode moet in Shopify bestaan (Discounts → maak bv. `TERUG5`, 5%).

### Taalbepaling (automatisch)

Land van klantadres → taal: NL/BE → Nederlands · DE/AT/CH → Duits · PL → Pools · GB/IE/US en al het overige → Engels.
Frans toevoegen voor RouteGuard later = 1 regel code + 1 template-vertaling.

## STAP 4 — Shopify custom app (5 min)

1. Shopify Admin → Settings → Apps and sales channels → **Develop apps** → Create app
2. Naam: "Recovery" → Admin API scope: **`read_orders`**
3. Install → kopieer Admin API token (`shpat_...`) → env var `SHOPIFY_TOKEN` in Railway

## STAP 5 — Testen

1. Open je Railway-URL → log in met `ADMIN_USER` / `ADMIN_PASSWORD`
2. Dashboard → **▶ Run nu handmatig** → moet "Run klaar: 0 verstuurd (X checkouts gecheckt)" geven
3. Doe een test-checkout op drivemax.nl met je 06-nummer, reken niet af
4. Na de ingestelde wachttijd (standaard 60 min) stuurt de cron het bericht — of klik "Run nu"
5. Bericht binnen? Check het dashboard: bericht staat in de lijst met land/taal

## Dashboard — wat je kunt instellen

- Reminder 1 en 2 aan/uit
- Wachttijden per reminder (minuten)
- Kortingscode (live aanpasbaar)
- Talen aan/uit per markt
- Handmatige run-knop
- Alles live: berichten per dag, per taal, cartwaarde, recovered revenue via je code

## Techniek (voor referentie)

- Cron: elke 15 min checkt open abandoned checkouts (laatste 3 dagen)
- Dedup via Postgres: per checkout max 1× reminder 1 en 1× reminder 2 — ook na herstart/downtime nooit dubbel
- Grace-window: carts ouder dan wachttijd + 12u worden niet meer benaderd (geen blast na downtime)
- Checkouts die alsnog afgerekend zijn verdwijnen uit Shopify's abandoned lijst → geen bericht
- Telefoonnummers per land genormaliseerd (06→+31, 0151→+49, etc.) en gemaskeerd opgeslagen

## CK: WhatsApp pas opzeggen als

1. Alle taalversies van beide templates goedgekeurd zijn
2. Testbericht ontvangen
3. 1–2 dagen parallel gedraaid zonder fouten (Railway → service → Logs)
