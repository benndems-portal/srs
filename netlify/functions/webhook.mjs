// POST /api/webhook — receives bid updates (and Givebutter events).
// Auth: the shared secret in WEBHOOK_SECRET must arrive in the `Signature`
// header (what Givebutter sends) or, for tools that can't set headers, as
// ?secret=... on the URL.
import { timingSafeEqual, createHash } from "node:crypto";
import { store, json, HttpError } from "../lib/store.mjs";
import { processWebhook, logDelivery } from "../lib/webhook.mjs";

const same = (a, b) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const s = store();
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return json({ error: "WEBHOOK_SECRET is not set in Netlify environment variables." }, 503);
  const given = req.headers.get("signature") || req.headers.get("x-webhook-secret") || new URL(req.url).searchParams.get("secret") || "";
  if (!same(given, secret)) {
    await logDelivery(s, { at: new Date().toISOString(), event: "?", result: "rejected", detail: "Bad or missing signature" });
    return json({ error: "Invalid signature" }, 401);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }

  // Some tools batch events in an array.
  const events = Array.isArray(body) ? body.slice(0, 100) : [body];
  const results = [];
  for (const ev of events) {
    const entry = { at: new Date().toISOString(), event: String(ev?.event ?? ev?.type ?? "bid.created").slice(0, 60) };
    try {
      Object.assign(entry, await processWebhook(s, ev || {}));
    } catch (e) {
      Object.assign(entry, { result: "error", detail: e instanceof HttpError ? e.message : "Server error" });
      if (!(e instanceof HttpError)) console.error(e);
    }
    // Relay feed pushes arrive every ~10 s; their status shows under "Live sync", not in the log.
    if (entry.result !== "synced") {
      entry.payload = JSON.stringify(ev).slice(0, 1500); // for debugging field mapping in /admin
      await logDelivery(s, entry);
    }
    results.push({ event: entry.event, result: entry.result, detail: entry.detail });
  }
  // Retry-worthy only if something actually failed on our side.
  const failed = results.some((r) => r.result === "error" && /retry|try again|server/i.test(r.detail || ""));
  return json({ ok: !failed, results }, failed ? 500 : 200);
};

export const config = { path: "/api/webhook" };
