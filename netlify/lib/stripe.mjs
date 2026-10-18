// Stripe card payments for raffle sales, taken on a Stripe Reader M2 paired to the
// "SRS Card Terminal" iPhone app. The M2 can only be driven by a native app, so the
// laptop (/sell) and the phone talk through a small queue stored in Netlify Blobs:
//
//   laptop  cardStart   -> creates a card_present PaymentIntent + a "waiting" request
//   phone   claim       -> takes the oldest waiting request, gets its client secret
//   phone   (collects on the M2, Stripe confirms the payment)
//   phone   result      -> server re-checks the PaymentIntent with Stripe, then
//                          creates the sale (numbers, text) exactly once
//   laptop  cardStatus  -> polls; when the sale exists it prints the slip
//
// The server never trusts the phone's word that a card was approved: a sale is only
// created after Stripe itself reports the PaymentIntent as succeeded.
//
// Env: STRIPE_SECRET_KEY (sk_live_… or sk_test_…), optional STRIPE_TERMINAL_LOCATION (tml_…).
import { randomUUID } from "node:crypto";
import { updateJSON, HttpError } from "./store.mjs";

const API = "https://api.stripe.com/v1";
export const QUEUE_KEY = "card-requests";
const STALE_WAIT_MS = 10 * 60_000; // waiting requests older than this are dropped
const KEEP = 60; // finished requests kept for the laptop/phone to read

export const stripeConfigured = () => !!process.env.STRIPE_SECRET_KEY;
export const stripeMode = () => (String(process.env.STRIPE_SECRET_KEY || "").startsWith("sk_live") || String(process.env.STRIPE_SECRET_KEY || "").startsWith("rk_live") ? "live" : "test");

// Stripe's form encoding: nested objects become key[sub]=value.
function encode(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === "object" ? encode(x, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x))));
    else if (typeof v === "object") encode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe(method, path, params, { idempotencyKey } = {}) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new HttpError(503, "Card payments aren't set up: add STRIPE_SECRET_KEY in Netlify environment variables.");
  const headers = { Authorization: `Bearer ${key}`, "Stripe-Version": "2024-06-20" };
  let url = API + path;
  let body;
  if (params && method === "GET") url += "?" + encode(params);
  else if (params) { body = encode(params); headers["content-type"] = "application/x-www-form-urlencoded"; }
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(9000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status >= 500 ? 502 : 400, `Stripe: ${data.error?.message || res.status}`);
  return data;
}

/* ---------------- Terminal setup ---------------- */
export async function connectionToken(locationId) {
  const t = await stripe("POST", "/terminal/connection_tokens", locationId ? { location: locationId } : {});
  return t.secret;
}

// Bluetooth readers must be registered to a Location. Use STRIPE_TERMINAL_LOCATION, else the
// first existing location, else create one for the race.
export async function terminalLocation(s) {
  if (process.env.STRIPE_TERMINAL_LOCATION) return process.env.STRIPE_TERMINAL_LOCATION;
  const cached = await s.get("stripe-location", { type: "json" });
  if (cached?.id && cached.mode === stripeMode()) return cached.id;
  const list = await stripe("GET", "/terminal/locations", { limit: 1 });
  let loc = list.data?.[0];
  if (!loc) {
    loc = await stripe("POST", "/terminal/locations", {
      display_name: "Sarah Ramsey Strong 5K",
      address: { line1: process.env.STRIPE_LOCATION_LINE1 || "Race day", city: process.env.STRIPE_LOCATION_CITY || "Event", state: process.env.STRIPE_LOCATION_STATE || "GA", postal_code: process.env.STRIPE_LOCATION_ZIP || "30000", country: "US" },
    });
  }
  await s.setJSON("stripe-location", { id: loc.id, mode: stripeMode() });
  return loc.id;
}

/* ---------------- Request queue ---------------- */
export async function getQueue(s) {
  return (await s.get(QUEUE_KEY, { type: "json" })) || { requests: [], terminals: {} };
}

export async function updateQueue(s, fn) {
  return updateJSON(s, QUEUE_KEY, async (cur) => {
    const q = cur || { requests: [], terminals: {} };
    q.terminals ||= {};
    const now = Date.now();
    // Expire waiting requests nobody picked up; keep a short history.
    for (const r of q.requests) if (r.status === "waiting" && now - Date.parse(r.createdAt) > STALE_WAIT_MS) { r.status = "expired"; r.endedAt = new Date().toISOString(); }
    const active = q.requests.filter((r) => ["waiting", "processing"].includes(r.status));
    const done = q.requests.filter((r) => !["waiting", "processing"].includes(r.status)).slice(-KEEP);
    q.requests = [...done, ...active].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    await fn(q);
    return q;
  });
}

const cents = (amount) => Math.round(Number(amount) * 100);

export async function createCardRequest(s, { draft, title, terminal }) {
  const amount = cents(draft.amount);
  if (amount < 50) throw new HttpError(400, "Card payments must be at least $0.50.");
  const id = randomUUID();
  const pi = await stripe("POST", "/payment_intents", {
    amount,
    currency: "usd",
    payment_method_types: ["card_present"],
    capture_method: "automatic",
    description: `Raffle tickets (${draft.count}) – ${draft.name}`.slice(0, 1000),
    metadata: { srs_request: id, buyer: draft.name.slice(0, 450), phone: draft.phone || "", tickets: String(draft.count), purpose: "raffle tickets" },
  }, { idempotencyKey: "srs-card-" + id });
  const req = {
    id,
    piId: pi.id,
    clientSecret: pi.client_secret,
    amount: draft.amount,
    status: "waiting",
    terminal: terminal || "", // "" = any phone may take it
    draft,
    title,
    createdAt: new Date().toISOString(),
  };
  await updateQueue(s, (q) => {
    // One active request per laptop at a time keeps the phones' screens unambiguous.
    for (const r of q.requests) if (r.status === "waiting" && r.draft.station && r.draft.station === draft.station) { r.status = "canceled"; r.endedAt = req.createdAt; r.error = "Replaced by a newer charge"; }
    q.requests.push(req);
  });
  return req;
}

// A phone asks for work. Returns the request it already holds, or claims the oldest waiting one.
export async function claimRequest(s, terminal) {
  let mine = null;
  await updateQueue(s, (q) => {
    q.terminals[terminal.id] = { ...terminal, seenAt: new Date().toISOString() };
    mine = q.requests.find((r) => r.status === "processing" && r.terminal === terminal.id) ||
      q.requests.find((r) => r.status === "waiting" && (!r.terminal || r.terminal === terminal.id)) || null;
    if (mine && mine.status === "waiting") { mine.status = "processing"; mine.terminal = terminal.id; mine.terminalName = terminal.name; mine.claimedAt = new Date().toISOString(); }
  });
  return mine;
}

export function publicRequest(r) {
  if (!r) return null;
  const { clientSecret, ...rest } = r;
  return rest;
}

// The card brand and last 4 for the slip, from the charge Stripe made.
export function cardInfo(pi) {
  const ch = pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  const c = ch?.payment_method_details?.card_present || ch?.payment_method_details?.interac_present || {};
  return { brand: c.brand || "", last4: c.last4 || "", wallet: c.wallet?.type || "", charge: ch?.id || "" };
}

export async function retrievePi(piId) {
  return stripe("GET", `/payment_intents/${encodeURIComponent(piId)}`, { "expand[]": "latest_charge" });
}

export async function cancelPi(piId) {
  try { await stripe("POST", `/payment_intents/${encodeURIComponent(piId)}/cancel`, {}); } catch { /* already succeeded or canceled */ }
}

export async function refundPi(piId) {
  return stripe("POST", "/refunds", { payment_intent: piId, metadata: { reason: "raffle sale voided" } }, { idempotencyKey: "srs-refund-" + piId });
}

export const cleanTerminalId = (v) => String(v || "").slice(0, 60);

// Phones that checked in during the last 20 seconds.
export function liveTerminals(q) {
  const now = Date.now();
  return Object.values(q.terminals || {})
    .filter((t) => now - Date.parse(t.seenAt) < 20_000)
    .map((t) => ({ ...t, busy: q.requests.some((r) => r.status === "processing" && r.terminal === t.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
