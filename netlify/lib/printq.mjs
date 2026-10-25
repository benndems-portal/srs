// Print queue: phones (or any Sell page set to "print station") ask for a slip, and the laptop
// with the USB receipt printer, running /print, picks the jobs up and prints them.
import { randomUUID } from "node:crypto";
import { updateJSON } from "./store.mjs";

const KEY = "print-queue";
const KEEP = 60; // finished jobs kept for the station's history
const RECLAIM_MS = 45_000; // a job a station took but never confirmed goes back in the queue
const LIVE_MS = 20_000;

const blank = () => ({ jobs: [], printers: {} });

export async function getPrintQueue(s) {
  return (await s.get(KEY, { type: "json" })) || blank();
}

export async function updatePrintQueue(s, fn) {
  return updateJSON(s, KEY, async (cur) => {
    const q = cur || blank();
    q.printers ||= {};
    const now = Date.now();
    for (const j of q.jobs) if (j.status === "printing" && now - Date.parse(j.claimedAt) > RECLAIM_MS) { j.status = "queued"; j.claimedBy = ""; j.retries = (j.retries || 0) + 1; }
    const open = q.jobs.filter((j) => j.status !== "printed");
    const done = q.jobs.filter((j) => j.status === "printed").slice(-KEEP);
    q.jobs = [...done, ...open].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    await fn(q);
    return q;
  });
}

const clean = (v, n = 60) => String(v ?? "").slice(0, n);

// kind: "slip" (needs saleId) or "test"
export async function addJob(s, { saleId = "", kind = "slip", from = "", reprint = false }) {
  let job;
  await updatePrintQueue(s, (q) => {
    // Pressing print twice before the station got to it shouldn't print two slips.
    job = kind === "slip" && q.jobs.find((j) => j.saleId === saleId && j.status !== "printed");
    if (job) return;
    job = { id: randomUUID(), kind, saleId: clean(saleId, 80), from: clean(from), reprint: !!reprint, status: "queued", createdAt: new Date().toISOString() };
    q.jobs.push(job);
  });
  return job;
}

// Many slips at once (runner tickets). Skips sales that already have a slip waiting.
export async function addJobs(s, saleIds, from = "", reprint = false) {
  const added = [];
  await updatePrintQueue(s, (q) => {
    const waiting = new Set(q.jobs.filter((j) => j.status !== "printed").map((j) => j.saleId));
    const t = Date.now();
    saleIds.forEach((id, i) => {
      if (waiting.has(id)) return;
      const job = { id: randomUUID(), kind: "slip", saleId: clean(id, 80), from: clean(from), reprint: !!reprint, status: "queued", createdAt: new Date(t + i).toISOString() };
      q.jobs.push(job); added.push(job);
    });
  });
  return added;
}

// A print station checks in and takes the jobs waiting for it.
export async function claimJobs(s, printer, max = 4) {
  const p = { id: clean(printer?.id) || "station", name: clean(printer?.name) || "Print station" };
  let mine = [];
  await updatePrintQueue(s, (q) => {
    q.printers[p.id] = { ...p, seenAt: new Date().toISOString() };
    mine = q.jobs.filter((j) => j.status === "queued").slice(0, max);
    for (const j of mine) Object.assign(j, { status: "printing", claimedBy: p.id, claimedAt: new Date().toISOString() });
  });
  return mine;
}

export async function finishJobs(s, ids, printerId, error = "") {
  const set = new Set((ids || []).map(String));
  await updatePrintQueue(s, (q) => {
    for (const j of q.jobs) {
      if (!set.has(j.id)) continue;
      if (error) Object.assign(j, { status: "queued", claimedBy: "", error: clean(error, 200) });
      else Object.assign(j, { status: "printed", printedAt: new Date().toISOString(), printedBy: clean(printerId) });
    }
  });
}

export function livePrinters(q) {
  const now = Date.now();
  return Object.values(q.printers || {}).filter((p) => now - Date.parse(p.seenAt) < LIVE_MS).sort((a, b) => a.name.localeCompare(b.name));
}

export const waitingCount = (q) => q.jobs.filter((j) => j.status !== "printed").length;
