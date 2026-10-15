// Pulls live auction data from Givebutter's public auction feed — the same
// JSON the public auction page loads (it polls it every ~10 s itself):
//   GET https://givebutter.com/campaign-api/auctions/{auctionId}/items?page=N&perPage=100
//   GET https://givebutter.com/campaign-api/auctions/{auctionId}/categories
// One request returns every item with its top bid (amount, public bidder
// name like "Leslie H.", bidder #), bid count, next minimum and end time.
// Note: this feed is undocumented, so Givebutter could change it without notice.
import { updateJSON } from "./store.mjs";
import { money } from "./auction.mjs";

const BASE = "https://givebutter.com/campaign-api/auctions";
const META_KEY = "gb/sync";
const UA = "Mozilla/5.0 (compatible; SilentAuctionDisplay/1.0)";

/* ---------- fetching ---------- */
async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA }, signal: AbortSignal.timeout(7000) });
  const type = res.headers.get("content-type") || "";
  if (!res.ok || !type.includes("json")) {
    const blocked = res.status === 403 || res.status === 503 || type.includes("html");
    throw new Error(blocked
      ? `Givebutter blocked the server request (HTTP ${res.status}). Use the relay script (scripts/gb-relay.mjs) on an event laptop instead.`
      : `Givebutter feed returned HTTP ${res.status}.`);
  }
  return res.json();
}

export async function fetchFeed(auctionId) {
  const id = encodeURIComponent(auctionId);
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const j = await getJSON(`${BASE}/${id}/items?page=${page}&perPage=100&sortBy=ending_soonest`);
    items.push(...(j.data || []));
    if (!j.meta || j.meta.current_page >= j.meta.last_page) break;
  }
  let categories = [];
  try { categories = await getJSON(`${BASE}/${id}/categories`); } catch { /* optional */ }
  return { auctionId: String(auctionId), items, categories };
}

/* ---------- helpers ---------- */
const stripHtml = (h) => String(h || "").replace(/<\/(p|li|h\d)>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "’").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim().slice(0, 1000);
const amt = (v) => (v == null || v === "" ? null : money(v));

function tzOffsetMs(ts, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ts;
}
// "2026-10-25 15:45:00" in "America/New_York" -> ISO UTC
export function zonedToIso(local, tz) {
  if (!local) return null;
  const m = String(local).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return isNaN(Date.parse(local)) ? null : new Date(local).toISOString();
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (!tz) return new Date(guess).toISOString();
  let ts = guess - tzOffsetMs(guess, tz);
  ts = guess - tzOffsetMs(ts, tz); // correct across DST boundaries
  return new Date(ts).toISOString();
}

// Category names come back without ids; Givebutter lists them in id order.
function categoryMap(feed) {
  const ids = [...new Set(feed.items.map((i) => i.category_id).filter((x) => x != null))].sort((a, b) => a - b);
  const names = (feed.categories || []).map((c) => c.name);
  return ids.length === names.length ? Object.fromEntries(ids.map((id, i) => [id, names[i].replace(/!+$/, "")])) : {};
}

function bidFrom(b) {
  return {
    id: "gb-" + b.id,
    extId: String(b.id),
    amount: money(b.amount),
    name: b.bidder?.display_name || "",
    number: b.bidder?.number != null ? String(b.bidder.number) : "",
    at: b.bid_at || b.confirmed_at || new Date().toISOString(),
    source: "givebutter",
  };
}

/* ---------- apply a feed to storage ---------- */
export async function applyFeed(s, feed) {
  const cats = categoryMap(feed);
  let auctionEnd = null, withBids = 0;
  const seen = new Set();

  await Promise.all(feed.items.map(async (g) => {
    const key = `items/gb-${g.id}`;
    seen.add(key);
    const closesAt = zonedToIso(g.end_at, g.timezone);
    const aEnd = zonedToIso(g.auction_end_at, g.timezone);
    if (aEnd && (!auctionEnd || aEnd > auctionEnd)) auctionEnd = aEnd;

    // Bids Givebutter shows for this item (top bid first). Givebutter's
    // display_name is already privacy-masked ("Leslie H." / "Anonymous").
    const gbBids = [...(g.last_bids || []), ...(g.winning_bids || []), g.last_bid, g.winning_bid].filter((b) => b && b.amount != null);
    const top = gbBids.reduce((best, b) => (!best || +b.amount > +best.amount ? b : best), null);
    if (top) withBids++;

    await updateJSON(s, key, (cur) => {
      cur = cur || { id: `gb-${g.id}`, number: "", bids: [], createdBy: "givebutter-sync" };
      // Merge Givebutter bids; drop synced bids above the current top (retracted).
      const byId = new Map((cur.bids || []).map((b) => [b.extId || b.id, b]));
      for (const b of gbBids) byId.set(String(b.id), bidFrom(b));
      let bids = [...byId.values()];
      bids = bids.filter((b) => b.source !== "givebutter" || (top && b.amount <= +top.amount));
      if (!g.bid_count) bids = bids.filter((b) => b.source !== "givebutter");
      bids.sort((a, b) => a.amount - b.amount || Date.parse(a.at) - Date.parse(b.at));

      const pics = g.pictures || [];
      const soldOut = g.is_sold_out && !top;
      return {
        ...cur,
        externalId: String(g.id),
        name: g.name,
        description: stripHtml(g.description),
        category: cats[g.category_id] || cur.category || "",
        image: pics[0]?.url || cur.image || "",
        value: amt(g.retail_price),
        startingBid: amt(g.start_bid) ?? 0,
        minIncrement: amt(g.bid_increment) ?? 0,
        buyNow: g.allows_buy_now ? amt(g.price) : null,
        buyNowOnly: !!(g.allows_buy_now && !g.allows_bid),
        remaining: g.limited_quantity === false ? null : g.remaining ?? null,
        closesAt,
        status: soldOut ? "sold" : g.ended || g.is_canceled ? "closed" : "open",
        soldPrice: soldOut ? amt(g.price) : cur.soldPrice ?? null,
        gbBidCount: g.bid_count ?? bids.length,
        gbMinimumBid: amt(g.minimum_bid),
        gbUrl: g.url || "",
        bids,
        syncedAt: new Date().toISOString(),
      };
    });
  }));

  // Remove items deleted in Givebutter (only ones this sync created).
  const { blobs } = await s.list({ prefix: "items/gb-" });
  await Promise.all(blobs.filter((b) => !seen.has(b.key)).map((b) => s.delete(b.key)));

  return { items: feed.items.length, withBids, auctionEnd };
}

/* ---------- throttled sync, safe with many screens polling ---------- */
export async function readSyncMeta(s) {
  return (await s.get(META_KEY, { type: "json" })) || {};
}

export async function syncIfStale(s, settings, { force = false } = {}) {
  const auctionId = String(settings.gbAuctionId || "").trim();
  if (!auctionId) return null;
  const every = Math.max(5, Number(settings.syncSeconds) || 10) * 1000;
  const cur = await s.getWithMetadata(META_KEY, { type: "json" });
  const meta = cur?.data || {};
  if (!force && meta.auctionId === auctionId && Date.now() - (meta.lastAttempt || 0) < every) return meta;
  // A relay laptop is feeding us; don't also hammer Givebutter from the server.
  if (!force && meta.via === "relay" && Date.now() - (meta.lastSuccess || 0) < 60_000) return meta;

  // Claim this sync slot so simultaneous requests don't all hit Givebutter.
  const claim = { ...meta, auctionId, lastAttempt: Date.now() };
  const res = cur ? await s.setJSON(META_KEY, claim, { onlyIfMatch: cur.etag }) : await s.setJSON(META_KEY, claim, { onlyIfNew: true });
  if (!res.modified && !force) return meta;

  try {
    const feed = await fetchFeed(auctionId);
    const r = await applyFeed(s, feed);
    const next = { ...claim, lastSuccess: Date.now(), error: null, via: "server", ...r };
    await s.setJSON(META_KEY, next);
    return next;
  } catch (e) {
    const next = { ...claim, error: e.message };
    await s.setJSON(META_KEY, next);
    return next;
  }
}

// Used when a relay pushes the feed (see scripts/gb-relay.mjs).
export async function applyRelayedFeed(s, feed) {
  const r = await applyFeed(s, feed);
  const meta = await readSyncMeta(s);
  await s.setJSON(META_KEY, { ...meta, auctionId: feed.auctionId, lastAttempt: Date.now(), lastSuccess: Date.now(), error: null, via: "relay", ...r });
  return r;
}
