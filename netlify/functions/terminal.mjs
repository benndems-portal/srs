// POST /api/terminal — used by the "SRS Card Terminal" iPhone app (paired to a Stripe Reader M2).
// Same staff password as /admin, sent in the x-admin-password header.
// Body: { action, ... }
//   config                      -> { locationId, mode, title, price }
//   connectionToken             -> { secret }   (Stripe Terminal SDK token provider)
//   poll { terminal }           -> { request }  (the charge this phone should take now, or null)
//   status { id }               -> { request }
//   event { id, terminal, kind, message }      (collecting / processing / declined, shown on /sell)
//   result { id, terminal, status, error }     (succeeded | canceled | failed)
import { timingSafeEqual } from "node:crypto";
import { store, json, HttpError } from "../lib/store.mjs";
import * as S from "../lib/stripe.mjs";
import { getRaffle } from "../lib/raffle.mjs";
import { settleRequest, cancelRequest, noteEvent, findRequest, markEnded } from "../lib/cards.mjs";

function checkPassword(req) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) throw new HttpError(503, "ADMIN_PASSWORD is not set in Netlify environment variables.");
  const a = Buffer.from(req.headers.get("x-admin-password") || ""), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, "Incorrect staff password.");
}

const clean = (t = {}) => ({
  id: String(t.id || "").slice(0, 60) || "phone",
  name: String(t.name || "Card terminal").slice(0, 60),
  reader: String(t.reader || "").slice(0, 80),
  battery: t.battery == null ? null : Math.round(Number(t.battery) * 100) / 100,
  app: String(t.app || "").slice(0, 20),
});

const forPhone = (r) => r && {
  id: r.id, status: r.status, amount: r.amount, clientSecret: r.clientSecret, piId: r.piId,
  name: r.draft.name, count: r.draft.count, title: r.title, createdAt: r.createdAt, error: r.error || "", saleId: r.saleId || null,
};

const actions = {
  async config({ s }) {
    const doc = await getRaffle(s);
    return { locationId: await S.terminalLocation(s), mode: S.stripeMode(), title: doc.title };
  },
  async connectionToken({ s }) {
    return { secret: await S.connectionToken() };
  },
  async poll({ s, body }) {
    const t = clean(body.terminal);
    return { request: forPhone(await S.claimRequest(s, t)) };
  },
  async status({ s, body }) {
    return { request: forPhone(await findRequest(s, String(body.id || ""))) };
  },
  async event({ s, body }) {
    await noteEvent(s, String(body.id || ""), clean(body.terminal).id, String(body.kind || ""), body.message);
    return { ok: true };
  },
  async result({ s, body }) {
    const id = String(body.id || "");
    let r;
    if (body.status === "succeeded") r = await settleRequest(s, id);
    else if (body.status === "canceled") r = await cancelRequest(s, id, "phone");
    else {
      // A hard failure on the phone (reader disconnected, etc.). Double-check with Stripe first.
      r = await settleRequest(s, id);
      if (r.status !== "succeeded") r = await markEnded(s, id, "failed", String(body.error || "The card terminal reported an error.").slice(0, 300));
    }
    return { request: forPhone(r) };
  },
};

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    checkPassword(req);
    const body = await req.json().catch(() => ({}));
    const fn = actions[body.action];
    if (!fn) throw new HttpError(400, "Unknown action.");
    return json(await fn({ s: store(), body }));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
};

export const config = { path: "/api/terminal" };
