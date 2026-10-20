// Finishing (or abandoning) a card request. Safe to call from the phone and the laptop at
// the same time: the sale's id is the request id, so it can only be created once.
import { getQueue, updateQueue, retrievePi, cancelPi, cardInfo, notePiSale } from "./stripe.mjs";
import { completeSale } from "./sales.mjs";
import { HttpError } from "./store.mjs";

const OPEN = ["waiting", "processing"];

export async function findRequest(s, id) {
  const q = await getQueue(s);
  const r = q.requests.find((x) => x.id === id);
  if (!r) throw new HttpError(404, "That card payment wasn't found. It may have expired; start it again.");
  return r;
}

// Asks Stripe whether the card went through; creates the sale when it did.
// Returns the (updated) request.
export async function settleRequest(s, id) {
  let r = await findRequest(s, id);
  if (r.status === "succeeded" || !OPEN.includes(r.status)) return r;
  const pi = await retrievePi(r.piId);
  if (pi.status === "succeeded") {
    const card = cardInfo(pi);
    const { sale, created } = await completeSale(s, { ...r.draft, payment: "card", amount: pi.amount_received / 100 }, {
      id: r.id,
      stripe: { pi: pi.id, brand: card.brand, last4: card.last4, wallet: card.wallet, charge: card.charge, livemode: !!pi.livemode },
    });
    if (created) await notePiSale(pi.id, sale);
    await updateQueue(s, (q) => {
      const x = q.requests.find((y) => y.id === id);
      if (x) Object.assign(x, { status: "succeeded", saleId: sale.id, endedAt: new Date().toISOString(), card: { brand: card.brand, last4: card.last4 }, error: "" });
    });
    return { ...r, status: "succeeded", saleId: sale.id };
  }
  if (pi.status === "canceled") return markEnded(s, id, "canceled", "The card payment was canceled.");
  return { ...r, piStatus: pi.status };
}

export async function markEnded(s, id, status, error = "") {
  let out = null;
  await updateQueue(s, (q) => {
    const x = q.requests.find((y) => y.id === id);
    if (x && OPEN.includes(x.status)) Object.assign(x, { status, error, endedAt: new Date().toISOString() });
    out = x;
  });
  return out;
}

// Cancel from either side. If the card had in fact already been approved, keep the sale instead.
export async function cancelRequest(s, id, by) {
  const r = await settleRequest(s, id);
  if (r.status === "succeeded") return r;
  if (!OPEN.includes(r.status)) return r;
  await markEnded(s, id, "canceled", by === "phone" ? "Canceled on the card terminal." : "Canceled on the Sell page.");
  await cancelPi(r.piId);
  // A tap that slipped through between our check and the cancel still wins.
  return settleRequestAfterCancel(s, id);
}

async function settleRequestAfterCancel(s, id) {
  const r = await findRequest(s, id);
  const pi = await retrievePi(r.piId).catch(() => null);
  if (pi?.status === "succeeded") {
    await updateQueue(s, (q) => { const x = q.requests.find((y) => y.id === id); x.status = "processing"; });
    return settleRequest(s, id);
  }
  return r;
}

export async function noteEvent(s, id, terminalId, kind, message) {
  await updateQueue(s, (q) => {
    const x = q.requests.find((y) => y.id === id);
    if (!x || !OPEN.includes(x.status) || (x.terminal && x.terminal !== terminalId)) return;
    x.stage = kind; // "collecting" | "processing" | "declined"
    x.stageMessage = String(message || "").slice(0, 200);
    x.stageAt = new Date().toISOString();
  });
}
