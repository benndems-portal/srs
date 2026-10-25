// Creating an event raffle sale: shared by /sell (cash, check, card charged elsewhere)
// and by card payments finished on the iPhone terminal app.
import * as R from "./raffle.mjs";
import { HttpError } from "./store.mjs";
import { gbWrite } from "./givebutter.mjs";
import { smsConfigured, normalizePhone, sendSms, renderTemplate } from "./sms.mjs";
import { money } from "./auction.mjs";

const str = (v, max = 500) => String(v ?? "").trim().slice(0, max);
const amountOf = (v) => {
  if (v === "" || v == null) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? money(n) : null;
};

export const runnerCount = (cfg) => Math.max(1, Math.min(20, Math.floor(Number(cfg?.runnerTickets ?? R.EMPTY.salesConfig.runnerTickets)) || 2));
export const RUNNER_NAME = "Race participant";

// A runner who already has free tickets (same phone, or same name when there's no phone). Unnamed bulk tickets never match.
export function existingRunnerSale(doc, draft) {
  const nm = (v) => String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!draft.phone && nm(draft.name) === nm(RUNNER_NAME)) return null;
  return (doc.sales || []).find((x) => x.payment === "runner" && !x.voided && (draft.phone ? x.phone === draft.phone : !x.phone && nm(x.name) === nm(draft.name))) || null;
}

// Checks the form and returns a clean sale draft (no numbers yet).
export function saleDraft(body, salesConfig) {
  const name = str(body.name, 120);
  // Free runner tickets: always the configured number (2), whatever quantity was picked.
  const count = body.payment === "runner" ? runnerCount(salesConfig) : Math.floor(Number(body.count) || 0);
  if (!name) throw new HttpError(400, "Enter the buyer's name.");
  if (count < 1 || count > 500) throw new HttpError(400, "How many tickets? (1–500)");
  const rawPhone = str(body.phone, 40);
  const phone = normalizePhone(rawPhone);
  if (rawPhone && !phone) throw new HttpError(400, "That phone number doesn't look right. Use 10 digits, e.g. 555-123-4567.");
  const payment = ["cash", "check", "card", "runner"].includes(body.payment) ? body.payment : "cash";
  const amount = payment === "runner" ? 0 : amountOf(body.amount) ?? R.salePrice(salesConfig, count);
  return {
    name,
    phone,
    email: str(body.email, 200),
    count,
    payment,
    amount,
    checkNo: payment === "check" ? str(body.checkNo, 30) : "",
    contactId: str(body.contactId, 40),
    station: str(body.station, 40),
  };
}

// Creates the sale (once — `id` makes it idempotent), texts the numbers and, if auto-recording
// is on, records it in Givebutter. Returns { doc, sale, created }.
export async function completeSale(s, draft, extra = {}) {
  let sale, created = false;
  let doc = await R.updateRaffle(s, (d) => {
    sale = extra.id ? d.sales.find((x) => x.id === extra.id) : null;
    if (sale) return;
    sale = R.createSale(d, { ...draft, ...extra });
    created = true;
  });
  if (!created) return { doc, sale, created };
  const cfg = { ...R.EMPTY.gbRecord, ...(doc.gbRecord || {}) };
  const [gbRes, smsRes] = await Promise.all([
    cfg.auto && R.shouldRecord(doc, sale) ? recordSaleInGb(doc, sale) : null,
    sale.phone ? sendSaleText(doc, sale) : null,
  ]);
  if (gbRes || smsRes) {
    doc = await R.updateRaffle(s, (d) => {
      const x = d.sales.find((y) => y.id === sale.id);
      if (gbRes) x.gb = gbRes;
      if (smsRes) applySmsResult(d, x, smsRes);
    });
    sale = doc.sales.find((x) => x.id === sale.id);
  }
  return { doc, sale, created };
}

export async function sendSaleText(doc, sale) {
  try {
    if (!sale.phone) throw new Error("No phone number");
    await sendSms(sale.phone, renderTemplate(doc.smsTemplate, R.smsBody(doc, sale)));
    return { status: "sent", at: new Date().toISOString() };
  } catch (e) {
    return { status: smsConfigured() ? "failed" : "not-configured", at: new Date().toISOString(), error: e.message };
  }
}

export function applySmsResult(d, x, result) {
  x.sms = result;
  if (result.status === "sent") for (const n of x.numbers) d.texted[n] = result.at;
  R.logSms(d, { to: x.phone, name: x.name, numbers: x.numbers, ok: result.status === "sent", error: result.error || "", kind: "sale" });
}

export async function textSale(s, doc, saleId) {
  const result = await sendSaleText(doc, doc.sales.find((x) => x.id === saleId));
  return R.updateRaffle(s, (d) => applySmsResult(d, d.sales.find((y) => y.id === saleId), result));
}

// POST /v1/transactions for one sale. Never throws; returns the status to store on the sale.
export async function recordSaleInGb(doc, sale) {
  if (!process.env.GIVEBUTTER_API_KEY) return { status: "not-configured", at: new Date().toISOString(), error: "GIVEBUTTER_API_KEY isn't set" };
  try {
    const tx = await gbWrite("POST", "/transactions", R.gbTransactionBody(doc, sale));
    return { status: "recorded", id: String(tx.id ?? tx.tid ?? ""), at: new Date().toISOString() };
  } catch (e) {
    return { status: "failed", at: new Date().toISOString(), error: e.message };
  }
}
