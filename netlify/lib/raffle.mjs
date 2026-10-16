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
const REEL_SIZE = 60;

export const EMPTY = {
  title: "Raffle Drawing",
  live: false, // screens switch to the raffle while true
  current: null, // draw id shown on screen
  gbTickets: [], // { id, number, name, email, type }
  gbPulledAt: null,
  gbSource: null, // "api" | "csv"
  typeEntries: {}, // ticket type title -> entries per ticket (0 = not a raffle ticket)
  participants: [], // { name, email, bib }
  participantsEach: 2,
  participantsLoadedAt: null,
  manual: [], // { id, name, email, count, at }
  prizes: [], // { id, name, detail, image }
  draws: [], // { id, prizeId, prizeName, number, name, email, source, at, status: "won" | "forfeit" }
};

export async function getRaffle(s) {
  return { ...structuredClone(EMPTY), ...((await s.get(KEY, { type: "json" })) || {}) };
}

// Read-modify-write the raffle doc, then refresh the public snapshot.
export async function updateRaffle(s, fn) {
  const next = await updateJSON(s, KEY, async (cur) => {
    const doc = { ...structuredClone(EMPTY), ...(cur || {}) };
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
export const personKey = (e) => (e.email ? e.email.trim().toLowerCase() : (e.name || "").trim().toLowerCase().replace(/\s+/g, " "));

// Expand everything into individual entries, each with a unique number.
export function buildEntries(doc) {
  const out = [];
  for (const t of doc.gbTickets) {
    const n = Math.max(0, Math.min(20, Number(doc.typeEntries[t.type] ?? 0) || 0));
    for (let k = 1; k <= n; k++) out.push({ number: n === 1 ? t.number : `${t.number}-${k}`, name: t.name, email: t.email, source: "givebutter", type: t.type });
  }
  let seq = 0;
  for (const p of doc.participants) {
    for (let k = 0; k < doc.participantsEach; k++) out.push({ number: "R" + pad(++seq), name: p.name, email: p.email, source: "participant", type: "Race participant" });
  }
  seq = 0;
  for (const m of doc.manual) {
    for (let k = 0; k < m.count; k++) out.push({ number: "M" + pad(++seq), name: m.name, email: m.email, source: "manual", type: "Added by hand" });
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
  const bySource = { givebutter: 0, participant: 0, manual: 0 };
  for (const e of entries) bySource[e.source]++;
  // Duplicate numbers would make a draw ambiguous — surface them.
  const seen = new Set(), dupes = new Set();
  for (const e of entries) (seen.has(e.number) ? dupes : seen).add(e.number);
  return { entries: entries.length, eligible: eligible.length, people: people.size, bySource, duplicateNumbers: [...dupes].slice(0, 20) };
}

/* ---------------- Draw ---------------- */
export function nextPrize(doc) {
  const won = new Set(doc.draws.filter((d) => d.status === "won").map((d) => d.prizeId));
  return doc.prizes.find((p) => !won.has(p.id)) || null;
}

export function draw(doc, prizeId) {
  const prize = prizeId ? doc.prizes.find((p) => p.id === prizeId) : nextPrize(doc);
  if (!prize) throw new HttpError(400, doc.prizes.length ? "Every prize already has a winner." : "Add at least one prize first.");
  if (doc.draws.some((d) => d.prizeId === prize.id && d.status === "won"))
    throw new HttpError(409, `“${prize.name}” already has a winner. Use “Redraw” on that result if the winner isn't here.`);
  const pool = eligibleEntries(doc);
  if (!pool.length) throw new HttpError(400, "There are no entries left in the pool.");
  const e = pool[randomInt(pool.length)];
  const d = { id: randomUUID(), prizeId: prize.id, prizeName: prize.name, number: e.number, name: e.name, email: e.email || "", source: e.source, type: e.type, at: new Date().toISOString(), status: "won", poolSize: pool.length };
  doc.draws.push(d);
  doc.current = d.id;
  return d;
}

/* ---------------- Public snapshot (no emails) ---------------- */
function sample(arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0 && a.length - i <= n; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(-n);
}

export function screenSnapshot(doc) {
  const entries = buildEntries(doc);
  const eligible = eligibleEntries(doc, entries);
  const winners = new Map(doc.draws.filter((d) => d.status === "won").map((d) => [d.prizeId, d]));
  const cur = doc.draws.find((d) => d.id === doc.current) || null;
  const prizeOf = (id) => doc.prizes.find((p) => p.id === id) || {};
  const reelFrom = eligible.length ? eligible : entries;
  return {
    title: doc.title,
    live: !!doc.live,
    entries: entries.length,
    eligible: eligible.length,
    people: new Set(entries.map(personKey)).size,
    prizes: doc.prizes.map((p) => {
      const w = winners.get(p.id);
      return { id: p.id, name: p.name, detail: p.detail, image: p.image, winner: w ? { name: w.name, number: w.number } : null };
    }),
    next: (() => { const p = nextPrize(doc); return p ? { id: p.id, name: p.name, detail: p.detail, image: p.image } : null; })(),
    current: cur
      ? {
          drawId: cur.id,
          at: cur.at,
          status: cur.status,
          prize: { id: cur.prizeId, name: cur.prizeName, detail: prizeOf(cur.prizeId).detail || "", image: prizeOf(cur.prizeId).image || "" },
          winner: { name: cur.name, number: cur.number, source: cur.source },
          // Names that fly past on the reel before it lands on the winner.
          reel: sample(reelFrom.filter((e) => e.number !== cur.number), REEL_SIZE).map((e) => ({ number: e.number, name: e.name })),
        }
      : null,
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
