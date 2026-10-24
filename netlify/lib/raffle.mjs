// Raffle: entries come from Givebutter tickets (API pull or Tickets export CSV),
// race participants (CSV, N entries each) and hand-added entries. Winners are
// drawn server-side with crypto.randomInt, then played on /raffle as a reel.
//
// Storage:
//   raffle         full doc (tickets, participants, prizes, draws) — admin only
//   raffle-screen  small public snapshot read by the screens every ~1.5 s
import { randomInt, randomUUID } from "node:crypto";
import { updateJSON, HttpError } from "./store.mjs";
import { gb } from "./givebutter.mjs";

const KEY = "raffle";
const SCREEN_KEY = "raffle-screen";

export const EMPTY = {
  title: "Raffle Drawing",
  live: false, // screens switch to the raffle while true
  current: null, // draw id shown on screen
  gbTickets: [], // { id, number, name, email, phone, type }
  gbPulledAt: null,
  gbSource: null, // "api" | "csv"
  typeEntries: {}, // ticket type title -> entries per ticket (0 = not a raffle ticket)
  participants: [], // { name, email, phone, bib }
  participantsEach: 2,
  participantsLoadedAt: null,
  manual: [], // { id, name, email, count, at }
  prizes: [], // { id, name, detail, image }
  // How prizes are given by default: "prize" = draw for a specific prize in order,
  // "choice" = draw a ticket and the winner picks from the prizes still available.
  awardMode: "prize",
  // { id, prizeId (null while a "choice" winner is choosing), prizeName, choice, number, name, email, source, at, status: "won" | "forfeit" }
  draws: [],
  // Tickets sold in person on /sell. Numbers are assigned once and stored, so they never change.
  // { id, numbers: ["20260001"], name, phone, email, count, payment: "cash" | "check" | "card", amount, at, voided,
  //   checkNo, stripe: { pi, brand, last4, refunded }, contactId, sms: { status, at, error }, gb: { status, id, error } }
  sales: [],
  saleSeq: 0,
  // Every ticket number is 8 digits: the prefix (the year) + 4 digits. Each source gets its own block
  // so numbers never collide: sold tickets 2026 0001…, race participants 2026 5001…, hand-added 2026 9001….
  numbering: { prefix: "2026", saleStart: 1, participantStart: 5001, manualStart: 9001 },
  salesConfig: {
    price: 5, // per ticket
    bundles: [{ count: 3, price: 10 }, { count: 7, price: 20 }],
    slipFooter: "Keep this slip. Good luck!",
    drawingInfo: "", // e.g. "Drawing Sun Oct 25 at 4:00 PM"
  },
  // Record event sales in Givebutter as transactions (POST /v1/transactions). By default they are
  // sent in one batch after the race ("Send N sales to Givebutter"); auto = send each sale right away.
  gbRecord: {
    enabled: true,
    auto: false,
    campaignCode: "", // e.g. the raffle campaign's code; blank = no campaign
    recordCard: true, // false if card sales are charged in Givebutter's own app (already a transaction there)
    timezone: "America/New_York",
    fallbackEmail: "", // used only if Givebutter requires an email and the buyer gave none
  },
  smsTemplate: "{event}: thanks {first}! Your raffle ticket numbers: {numbers}. Good luck! Reply STOP to opt out.",
  texted: {}, // entry number -> ISO time it was texted
  smsLog: [], // last 300 sends { at, to, name, numbers, ok, error, kind }
};

// Docs saved before the prices were set still carry the old placeholder prices ($10, 3 for $25,
// 10 for $75). Swap those for the real ones; any prices staff have changed are left alone.
function fixOldPrices(doc) {
  const c = doc.salesConfig;
  const b = (c && c.bundles) || [];
  if (c && Number(c.price) === 10 && b.length === 2 && b[0].count === 3 && b[0].price === 25 && b[1].count === 10 && b[1].price === 75) {
    doc.salesConfig = { ...c, price: EMPTY.salesConfig.price, bundles: structuredClone(EMPTY.salesConfig.bundles) };
  }
  return doc;
}

export async function getRaffle(s) {
  return fixOldPrices({ ...structuredClone(EMPTY), ...((await s.get(KEY, { type: "json" })) || {}) });
}

// Read-modify-write the raffle doc, then refresh the public snapshot.
export async function updateRaffle(s, fn) {
  const next = await updateJSON(s, KEY, async (cur) => {
    const doc = fixOldPrices({ ...structuredClone(EMPTY), ...(cur || {}) });
    return (await fn(doc)) || doc;
  });
  await s.setJSON(SCREEN_KEY, screenSnapshot(next));
  return next;
}

export async function getScreen(s) {
  return (await s.get(SCREEN_KEY, { type: "json" })) || screenSnapshot(structuredClone(EMPTY));
}

/* ---------------- Entries ---------------- */
const pad = (n, w = 4) => String(n).padStart(w, "0");
export const numbering = (doc) => ({ ...EMPTY.numbering, ...(doc.numbering || {}) });
const ticketNo = (doc, block, i) => { const n = numbering(doc); return n.prefix + pad(Number(n[block]) + i); };
export const personKey = (e) => (e.email ? e.email.trim().toLowerCase() : (e.name || "").trim().toLowerCase().replace(/\s+/g, " "));

// Expand everything into individual entries, each with a unique number.
export function buildEntries(doc) {
  const out = [];
  for (const t of doc.gbTickets) {
    const n = Math.max(0, Math.min(20, Number(doc.typeEntries[t.type] ?? 0) || 0));
    for (let k = 1; k <= n; k++) out.push({ number: n === 1 ? t.number : `${t.number}-${k}`, name: t.name, email: t.email, phone: t.phone || "", source: "givebutter", type: t.type });
  }
  let seq = 0;
  for (const p of doc.participants) {
    for (let k = 0; k < doc.participantsEach; k++) out.push({ number: ticketNo(doc, "participantStart", seq++), name: p.name, email: p.email, phone: p.phone || "", source: "participant", type: "Race participant" });
  }
  seq = 0;
  for (const m of doc.manual) {
    for (let k = 0; k < m.count; k++) out.push({ number: ticketNo(doc, "manualStart", seq++), name: m.name, email: m.email, phone: "", source: "manual", type: "Added by hand" });
  }
  for (const sale of doc.sales || []) {
    if (sale.voided) continue;
    for (const number of sale.numbers) out.push({ number, name: sale.name, email: sale.email || "", phone: sale.phone || "", source: "sale", type: "Sold at event", saleId: sale.id });
  }
  return out;
}

export function eligibleEntries(doc, entries = buildEntries(doc)) {
  const used = new Set(doc.draws.map((d) => d.number));
  return entries.filter((e) => !used.has(e.number));
}

export function poolSummary(doc) {
  const entries = buildEntries(doc);
  const eligible = eligibleEntries(doc, entries);
  const people = new Set(entries.map(personKey));
  const bySource = { givebutter: 0, participant: 0, manual: 0, sale: 0 };
  for (const e of entries) bySource[e.source]++;
  // Duplicate numbers would make a draw ambiguous — surface them.
  const seen = new Set(), dupes = new Set();
  for (const e of entries) (seen.has(e.number) ? dupes : seen).add(e.number);
  return { entries: entries.length, eligible: eligible.length, people: people.size, bySource, duplicateNumbers: [...dupes].slice(0, 20) };
}

/* ---------------- Draw ---------------- */
export function availablePrizes(doc) {
  const won = new Set(doc.draws.filter((d) => d.status === "won" && d.prizeId).map((d) => d.prizeId));
  return doc.prizes.filter((p) => !won.has(p.id));
}

export function nextPrize(doc) {
  return availablePrizes(doc)[0] || null;
}

// A "choice" winner who hasn't picked a prize yet.
export function choosingDraw(doc) {
  return doc.draws.find((d) => d.status === "won" && d.choice && !d.prizeId) || null;
}

// prizeId "choice" = the winner picks from the remaining prizes afterwards.
export function draw(doc, prizeId) {
  const choice = prizeId === "choice";
  const left = availablePrizes(doc);
  const waiting = choosingDraw(doc);
  if (waiting) throw new HttpError(409, `${waiting.name} (${waiting.number}) hasn't been given a prize yet. Assign their prize, or mark them not here, before drawing again.`);
  let prize = null;
  if (choice) {
    if (!left.length) throw new HttpError(400, doc.prizes.length ? "Every prize has been given out." : "Add at least one prize first.");
  } else {
    prize = prizeId ? doc.prizes.find((p) => p.id === prizeId) : left[0];
    if (!prize) throw new HttpError(400, doc.prizes.length ? "Every prize already has a winner." : "Add at least one prize first.");
    if (!left.includes(prize)) throw new HttpError(409, `“${prize.name}” already has a winner. Use “Redraw” on that result if the winner isn't here.`);
  }
  const pool = eligibleEntries(doc);
  if (!pool.length) throw new HttpError(400, "There are no entries left in the pool.");
  const e = pool[randomInt(pool.length)];
  const d = { id: randomUUID(), prizeId: prize ? prize.id : null, prizeName: prize ? prize.name : "", choice, number: e.number, name: e.name, email: e.email || "", phone: e.phone || "", source: e.source, type: e.type, at: new Date().toISOString(), status: "won", poolSize: pool.length };
  doc.draws.push(d);
  doc.current = d.id;
  return d;
}

// Give a "choice" winner the prize they picked (or change it).
export function assignPrize(doc, drawId, prizeId) {
  const d = doc.draws.find((x) => x.id === drawId);
  if (!d || d.status !== "won") throw new HttpError(404, "That draw isn't a current winner.");
  const prize = doc.prizes.find((p) => p.id === prizeId);
  if (!prize) throw new HttpError(400, "Pick a prize.");
  if (prize.id !== d.prizeId && !availablePrizes(doc).includes(prize)) throw new HttpError(409, `“${prize.name}” has already been given out.`);
  d.prizeId = prize.id;
  d.prizeName = prize.name;
  d.assignedAt = new Date().toISOString();
  return d;
}

/* ---------------- Public snapshot (no emails) ---------------- */
export function screenSnapshot(doc) {
  const entries = buildEntries(doc);
  const eligible = eligibleEntries(doc, entries);
  const winners = new Map(doc.draws.filter((d) => d.status === "won" && d.prizeId).map((d) => [d.prizeId, d]));
  const cur = doc.draws.find((d) => d.id === doc.current) || null;
  const prizeOf = (id) => doc.prizes.find((p) => p.id === id) || {};
  return {
    title: doc.title,
    live: !!doc.live,
    awardMode: doc.awardMode || "prize",
    available: availablePrizes(doc).length,
    entries: entries.length,
    eligible: eligible.length,
    people: new Set(entries.map(personKey)).size,
    prizes: doc.prizes.map((p) => {
      const w = winners.get(p.id);
      return { id: p.id, name: p.name, detail: p.detail, image: p.image, winner: w ? { number: w.number } : null };
    }),
    next: (() => { const p = nextPrize(doc); return p ? { id: p.id, name: p.name, detail: p.detail, image: p.image } : null; })(),
    current: cur
      ? {
          drawId: cur.id,
          at: cur.at,
          status: cur.status,
          choice: !!cur.choice,
          prize: cur.prizeId ? { id: cur.prizeId, name: cur.prizeName, detail: prizeOf(cur.prizeId).detail || "", image: prizeOf(cur.prizeId).image || "" } : null,
          // Only the ticket number goes on the public screen; names stay on the staff page.
          winner: { number: cur.number, source: cur.source },
        }
      : null,
    prefix: numbering(doc).prefix,
    updatedAt: new Date().toISOString(),
  };
}

/* ---------------- Givebutter tickets ---------------- */
const TICKET_NO = /^[A-Z]{1,2}\d{3,}$/i;

// Givebutter shows each ticket a number like "A1042". The API documents `id`
// and `id_suffix`; use whichever looks like that number, else the suffix/id.
export function mapGbTicket(t) {
  const cands = [t.number, t.ticket_number, t.id_suffix, t.code, t.id].filter((v) => v != null && v !== "").map(String);
  const number = (cands.find((c) => TICKET_NO.test(c)) || String(t.id_suffix || t.id || "")).toUpperCase();
  const name = (t.name || [t.first_name, t.last_name].filter(Boolean).join(" ") || "").trim();
  return {
    id: String(t.id ?? number),
    number,
    name: name || "Ticket holder",
    email: String(t.email || "").trim(),
    phone: String(t.phone || "").trim(),
    type: String(t.title || t.ticket_title || t.ticket_name || t.description || "Ticket").trim(),
  };
}

export async function pullGivebutterTickets(campaignId) {
  const first = await gb(`/tickets?page=1&per_page=100`);
  const pages = [first];
  const last = Math.min(Number(first.meta?.last_page) || 1, 200);
  for (let p = 2; p <= last; p += 8) {
    const batch = [];
    for (let q = p; q < p + 8 && q <= last; q++) batch.push(gb(`/tickets?page=${q}&per_page=100`));
    pages.push(...(await Promise.all(batch)));
  }
  let raw = pages.flatMap((r) => r.data || []);
  // If a campaign is set and tickets carry a campaign reference, keep only that campaign's.
  if (campaignId) {
    const tagged = raw.filter((t) => t.campaign_id != null || t.campaign?.id != null);
    if (tagged.length) raw = raw.filter((t) => String(t.campaign_id ?? t.campaign?.id) === String(campaignId));
  }
  // Skip refunded / cancelled tickets when Givebutter tells us about them.
  raw = raw.filter((t) => !["refunded", "cancelled", "canceled", "voided", "void"].includes(String(t.status || "").toLowerCase()));
  return { tickets: dedupe(raw.map(mapGbTicket)), sample: raw[0] || null };
}

export function dedupe(tickets) {
  const m = new Map();
  for (const t of tickets) if (t.number) m.set(t.number, t);
  return [...m.values()].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
}

// A ticket type counts as a raffle entry by default if its name says so.
export function defaultEntriesFor(type) {
  return /raffle|drawing|sweepstake|50\s*\/\s*50|chance/i.test(type) ? 1 : 0;
}

/* ---------------- Event sales ---------------- */
// Cheapest way to make up `count` tickets from single tickets and bundles
// (e.g. with 1 for $5, 3 for $10, 7 for $20: 10 tickets = 7 + 3 = $30).
export function salePrice(cfg, count) {
  const each = Number(cfg?.price) || 0;
  const packs = [{ count: 1, price: each }, ...((cfg?.bundles) || []).filter((b) => b.count > 0 && Number.isFinite(Number(b.price)))];
  const best = [0];
  for (let n = 1; n <= count; n++) {
    best[n] = Infinity;
    for (const p of packs) if (p.count <= n) best[n] = Math.min(best[n], best[n - p.count] + Number(p.price));
  }
  return Math.round(best[count] * 100) / 100;
}

export function createSale(doc, { id, name, phone, email, count, payment, amount, checkNo, stripe, contactId, station }) {
  const n = numbering(doc);
  const last = Number(n.saleStart) + doc.saleSeq + count - 1;
  const ceiling = [Number(n.participantStart), Number(n.manualStart)].filter((b) => b > Number(n.saleStart)).sort((a, b) => a - b)[0] ?? 10000;
  if (last >= ceiling) throw new HttpError(409, `Sold ticket numbers have reached ${n.prefix}${pad(ceiling)}, where the next block starts. Change the numbering on the staff page (Raffle › Ticket numbers).`);
  const numbers = [];
  for (let i = 0; i < count; i++) numbers.push(ticketNo(doc, "saleStart", doc.saleSeq++));
  const sale = { id: id || randomUUID(), numbers, name, phone, email, count, payment, amount, at: new Date().toISOString(), voided: false, sms: phone ? { status: "pending" } : { status: "none" } };
  if (checkNo) sale.checkNo = checkNo;
  if (stripe) sale.stripe = stripe;
  if (contactId) sale.contactId = contactId;
  if (station) sale.station = station;
  doc.sales.push(sale);
  return sale;
}

export function salesSummary(doc) {
  const live = (doc.sales || []).filter((x) => !x.voided);
  const sum = (arr, f) => Math.round(arr.reduce((t, x) => t + (Number(f(x)) || 0), 0) * 100) / 100;
  return {
    sales: live.length,
    tickets: sum(live, (x) => x.count),
    cash: sum(live.filter((x) => x.payment === "cash"), (x) => x.amount),
    check: sum(live.filter((x) => x.payment === "check"), (x) => x.amount),
    card: sum(live.filter((x) => x.payment === "card"), (x) => x.amount),
    stripe: sum(live.filter((x) => x.payment === "card" && x.stripe?.pi), (x) => x.amount),
    voided: (doc.sales || []).length - live.length,
  };
}

/* ---------------- Texting queue ---------------- */
// Entries that have a phone and haven't been texted yet, grouped per phone number.
export function textQueue(doc, normalize, entries = buildEntries(doc)) {
  const groups = new Map();
  let noPhone = 0;
  for (const e of entries) {
    if (doc.texted[e.number]) continue;
    const to = normalize(e.phone);
    if (!to) { noPhone++; continue; }
    if (!groups.has(to)) groups.set(to, { to, name: e.name, numbers: [], sources: new Set() });
    const g = groups.get(to);
    g.numbers.push(e.number);
    g.sources.add(e.source);
  }
  return { groups: [...groups.values()].map((g) => ({ ...g, sources: [...g.sources] })), noPhone };
}

export function smsBody(doc, { name, numbers }) {
  const first = String(name || "").trim().split(/\s+/)[0] || "there";
  return { first, numbers: numbers.join(", "), count: numbers.length, name: name || "", event: doc.title };
}

export function logSms(doc, entry) {
  doc.smsLog = [{ at: new Date().toISOString(), ...entry }, ...(doc.smsLog || [])].slice(0, 300);
}

/* ---------------- Recording sales in Givebutter ---------------- */
export function numberRange(numbers) {
  return numbers.length > 2 ? `${numbers[0]}–${numbers[numbers.length - 1]}` : numbers.join(", ");
}

// Body for POST /v1/transactions. external_id makes the sale identifiable (and lets us
// check before re-sending); the internal note carries the ticket numbers.
export function gbTransactionBody(doc, sale) {
  const cfg = { ...EMPTY.gbRecord, ...(doc.gbRecord || {}) };
  const parts = String(sale.name || "").trim().split(/\s+/);
  const first = parts.shift() || "Raffle";
  const last = parts.join(" ") || "Buyer";
  const body = {
    amount: Number(sale.amount || 0).toFixed(2),
    method: ["card", "check"].includes(sale.payment) ? sale.payment : "cash",
    transacted_at: sale.at,
    timezone: cfg.timezone,
    first_name: first,
    last_name: last,
    external_id: "srs-raffle-" + sale.id,
    external_label: "SRS raffle sale",
    internal_note: `Raffle tickets ${numberRange(sale.numbers)} (${sale.count}). Raffle ticket purchase, not a tax-deductible donation.` +
      (sale.checkNo ? ` Check #${sale.checkNo}.` : "") +
      (sale.stripe?.pi ? ` Paid by card through Stripe (${[sale.stripe.brand, sale.stripe.last4 && "…" + sale.stripe.last4].filter(Boolean).join(" ")}, ${sale.stripe.pi}).` : sale.payment === "card" ? " Card charged outside the Sell page." : "") +
      " Recorded by the raffle Sell page.",
  };
  if (sale.contactId) body.contact_id = /^\d+$/.test(sale.contactId) ? Number(sale.contactId) : sale.contactId;
  if (sale.email) body.email = sale.email;
  else if (cfg.fallbackEmail) body.email = cfg.fallbackEmail;
  if (sale.phone) body.phone = sale.phone;
  if (cfg.campaignCode) body.campaign_code = cfg.campaignCode;
  return body;
}

export function shouldRecord(doc, sale) {
  const cfg = { ...EMPTY.gbRecord, ...(doc.gbRecord || {}) };
  if (!cfg.enabled || sale.voided) return false;
  if (sale.payment === "card" && !cfg.recordCard) return false;
  return !(sale.gb && sale.gb.status === "recorded");
}
