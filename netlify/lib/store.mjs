// Storage layer. Uses Netlify Blobs in production; an in-memory store when
// LOCAL_MEMORY_STORE=1 (used by the local test harness).
import { getStore } from "@netlify/blobs";

const STORE_NAME = "silent-auction";

function memoryStore() {
  globalThis.__auctionMem ??= new Map();
  const mem = globalThis.__auctionMem;
  let n = 0;
  return {
    async get(key) {
      const v = mem.get(key);
      return v ? structuredClone(v.data) : null;
    },
    async getWithMetadata(key) {
      const v = mem.get(key);
      return v ? { data: structuredClone(v.data), etag: v.etag, metadata: {} } : null;
    },
    async setJSON(key, data, opts = {}) {
      const cur = mem.get(key);
      if (opts.onlyIfMatch && (!cur || cur.etag !== opts.onlyIfMatch)) return { modified: false };
      if (opts.onlyIfNew && cur) return { modified: false };
      const etag = `"${++n}"`;
      mem.set(key, { data: structuredClone(data), etag });
      return { modified: true, etag };
    },
    async delete(key) {
      mem.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return { blobs: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}

export function store() {
  if (process.env.LOCAL_MEMORY_STORE === "1") return memoryStore();
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

export const DEFAULT_SETTINGS = {
  title: "Silent Auction",
  subtitle: "",
  endsAt: null, // ISO string
  hotMinutes: 5, // a bid in the last N minutes marks an item "hot"
  closingSoonMinutes: 15,
  campaignId: "", // Givebutter campaign ID (number as string)
  gbAuctionId: "", // Givebutter auction ID — live bids are synced from its public feed
  syncSeconds: 10, // how often to pull the auction feed
  showGivebutter: true,
  bidUrl: "", // shown on screen as "Bid at ..."
  rotateSeconds: 15, // seconds per page on the display
  closedMessage: "Bidding is closed — thank you for your generosity!",
};

export async function getSettings(s = store()) {
  const saved = (await s.get("settings", { type: "json" })) || {};
  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function listItems(s = store()) {
  const { blobs } = await s.list({ prefix: "items/" });
  const items = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
  return items.filter(Boolean).sort(compareItems);
}

export function compareItems(a, b) {
  const na = parseFloat(a.number), nb = parseFloat(b.number);
  if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
  return String(a.number || a.name).localeCompare(String(b.number || b.name), undefined, { numeric: true });
}

// Read-modify-write with optimistic concurrency so two volunteers entering
// bids at the same moment never silently overwrite each other.
export async function updateJSON(s, key, fn, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    const cur = await s.getWithMetadata(key, { type: "json" });
    const next = await fn(cur ? cur.data : null);
    const res = cur
      ? await s.setJSON(key, next, { onlyIfMatch: cur.etag })
      : await s.setJSON(key, next, { onlyIfNew: true });
    if (res.modified) return next;
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 120));
  }
  throw new HttpError(409, "Someone else just updated this item. Please try again.");
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
