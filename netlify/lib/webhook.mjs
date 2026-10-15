// Webhook processing. Accepts:
//   • Bid events from any sender (Givebutter, Zapier, Make, a custom script)
//     — any event name containing "bid", e.g. "bid.created", "auction.bid.placed".
//     Field names are matched flexibly (see README "Webhook payload").
//   • Bid removals — event containing "bid" plus "retract|delete|cancel|void|remove".
//   • Item closed/won — event containing "item" plus "close|won|winner|end".
//   • Givebutter's own events: campaign.updated (refreshes campaign totals
//     instantly) and transaction.succeeded (marks items paid / Buy Now sold).
import { randomUUID, createHash } from "node:crypto";
import { listItems, getSettings, updateJSON } from "./store.mjs";
import { money, highBid } from "./auction.mjs";
import { applyRelayedFeed } from "./gbsync.mjs";

const LOG_KEY = "webhook/log";
const LOG_MAX = 60;

/* ---------- small helpers ---------- */
const first = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== "");
const norm = (v) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const toAmount = (v, cents) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return money(cents ? n / 100 : n);
};
const toIso = (v) => {
  if (!v) return new Date().toISOString();
  const t = typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
  return isNaN(t) ? new Date().toISOString() : new Date(t).toISOString();
};
const personName = (p) => {
  if (!p || typeof p !== "object") return typeof p === "string" ? p : "";
  return first(p.name, p.full_name, [p.first_name, p.last_name].filter(Boolean).join(" ")) || "";
};

/* ---------- normalise an incoming payload into a bid ---------- */
export function extractBid(body) {
  const d = body.data && typeof body.data === "object" ? body.data : body.payload && typeof body.payload === "object" ? body.payload : body;
  const bid = d.bid && typeof d.bid === "object" ? d.bid : d;
  const item = first(bid.item, d.item, d.auction_item, bid.auction_item) || {};
  const bidder = first(bid.bidder, d.bidder, bid.contact, d.contact, d.supporter, d.user) || {};
  const cents = first(bid.amount_cents, bid.amount_in_cents, d.amount_cents) != null;

  return {
    bidId: first(bid.id && bid !== d ? bid.id : undefined, d.bid_id, bid.bid_id, body.bid_id, d.id && d !== body ? d.id : undefined, body.id) ?? null,
    amount: toAmount(first(bid.amount_cents, bid.amount_in_cents, d.amount_cents, bid.amount, bid.bid_amount, d.bid_amount, d.amount, d.current_bid, d.high_bid, d.highest_bid), cents),
    at: toIso(first(bid.created_at, bid.placed_at, bid.bid_at, d.created_at, d.placed_at, d.timestamp, body.created_at, body.timestamp)),
    name: first(personName(bidder), d.bidder_name, bid.bidder_name, personName({ first_name: d.first_name, last_name: d.last_name })) || "",
    number: String(first(bidder.bidder_number, bidder.number, bidder.paddle_number, d.bidder_number, bid.bidder_number, d.paddle_number) ?? ""),
    item: {
      externalId: first(item.id, d.item_id, bid.item_id, d.auction_item_id, bid.auction_item_id),
      number: first(item.number, item.item_number, item.lot, item.lot_number, d.item_number, bid.item_number, d.lot_number),
      name: first(item.name, item.title, d.item_name, bid.item_name, d.item_title),
      value: first(item.value, item.fair_market_value, item.fmv),
      startingBid: first(item.starting_bid, item.min_bid, item.opening_bid),
      category: first(item.category, item.category_name),
    },
  };
}

function matchItem(items, ref) {
  const ext = ref.externalId != null ? String(ref.externalId) : null;
  return (
    (ext && items.find((i) => i.externalId && String(i.externalId) === ext)) ||
    (ref.number != null && items.find((i) => norm(i.number) === norm(ref.number))) ||
    (ref.name && items.find((i) => norm(i.name) === norm(ref.name))) ||
    null
  );
}

/* ---------- event handlers ---------- */
async function handleBid(s, body, settings) {
  const b = extractBid(body);
  if (!b.amount) return { result: "error", detail: "No bid amount found in payload." };
  const items = await listItems(s);
  let item = matchItem(items, b.item);

  // Unknown item: create it so no bid is ever dropped (staff can tidy it up later).
  if (!item) {
    const ref = b.item.externalId ?? b.item.number ?? b.item.name;
    if (ref == null) return { result: "unmatched", detail: "Payload has no item id, number or name." };
    // Deterministic id, so two simultaneous first bids create one item, not two.
    const id = "wh-" + createHash("sha256").update(norm(ref)).digest("hex").slice(0, 16);
    item = {
      id,
      externalId: b.item.externalId != null ? String(b.item.externalId) : "",
      number: b.item.number != null ? String(b.item.number) : "",
      name: b.item.name || `Item ${b.item.number ?? b.item.externalId}`,
      description: "",
      category: b.item.category || "",
      image: "",
      value: toAmount(b.item.value),
      startingBid: toAmount(b.item.startingBid) ?? 0,
      minIncrement: 0,
      buyNow: null,
      closesAt: null,
      status: "open",
      bids: [],
      createdBy: "webhook",
      updatedAt: new Date().toISOString(),
    };
    await s.setJSON(`items/${item.id}`, item, { onlyIfNew: true }); // no-op if another request created it first
  }

  let outcome = "recorded";
  await updateJSON(s, `items/${item.id}`, (cur) => {
    cur.bids = cur.bids || [];
    // Idempotency: the same bid delivered twice is ignored.
    const dupe = b.bidId != null
      ? cur.bids.find((x) => x.extId === String(b.bidId))
      : cur.bids.find((x) => x.amount === b.amount && x.at === b.at && norm(x.name) === norm(b.name));
    if (dupe) { outcome = "duplicate"; return cur; }
    if (b.item.externalId != null && !cur.externalId) cur.externalId = String(b.item.externalId);
    cur.bids.push({ id: randomUUID(), extId: b.bidId != null ? String(b.bidId) : null, amount: b.amount, name: b.name, number: b.number, at: b.at, source: "webhook" });
    cur.bids.sort((x, y) => x.amount - y.amount || Date.parse(x.at) - Date.parse(y.at));
    cur.updatedAt = new Date().toISOString();
    return cur;
  });
  const who = b.name || (b.number ? "#" + b.number : "anonymous");
  const leader = outcome === "recorded" ? ` — ${who} $${b.amount}` : "";
  return { result: outcome, itemId: item.id, detail: `${item.number ? "#" + item.number + " " : ""}${item.name}${leader}` };
}

async function handleBidRemoval(s, body) {
  const b = extractBid(body);
  const item = matchItem(await listItems(s), b.item);
  if (!item) return { result: "unmatched", detail: "Couldn't find the item for this bid removal." };
  let removed = 0;
  await updateJSON(s, `items/${item.id}`, (cur) => {
    const before = cur.bids.length;
    cur.bids = cur.bids.filter((x) => !(b.bidId != null ? x.extId === String(b.bidId) : x.amount === b.amount && norm(x.name) === norm(b.name)));
    removed = before - cur.bids.length;
    return cur;
  });
  return { result: removed ? "removed" : "ignored", itemId: item.id, detail: `${item.name}: removed ${removed} bid(s)` };
}

async function handleItemClosed(s, body) {
  const b = extractBid(body);
  const item = matchItem(await listItems(s), b.item);
  if (!item) return { result: "unmatched", detail: "Couldn't find the item to close." };
  await updateJSON(s, `items/${item.id}`, (cur) => ({ ...cur, status: cur.status === "sold" ? "sold" : "closed", updatedAt: new Date().toISOString() }));
  return { result: "closed", itemId: item.id, detail: item.name };
}

async function handleCampaignUpdated(s, body, settings) {
  const c = body.data || {};
  if (!settings.campaignId || String(c.id) !== String(settings.campaignId)) return { result: "ignored", detail: `Campaign ${c.id} isn't the one shown on the display.` };
  const cached = (await s.get("cache/givebutter", { type: "json" })) || {};
  const prev = cached.data || {};
  await s.setJSON("cache/givebutter", {
    campaignId: settings.campaignId,
    fetchedAt: Date.now(),
    data: { ...prev, title: c.title ?? prev.title, raised: Number(c.raised ?? prev.raised) || 0, goal: c.goal != null ? Number(c.goal) : prev.goal ?? null, donors: Number(c.donors ?? prev.donors) || 0, url: c.url ?? prev.url, recent: prev.recent || [] },
  });
  return { result: "updated", detail: `Campaign total now $${Number(c.raised || 0).toLocaleString()}` };
}

async function handleTransaction(s, body, settings) {
  const t = body.data || {};
  if (settings.campaignId && t.campaign_id != null && String(t.campaign_id) !== String(settings.campaignId))
    return { result: "ignored", detail: "Transaction is for a different campaign." };
  const buyer = personName(t);
  const items = await listItems(s);
  const touched = [];
  for (const li of t.line_items || []) {
    const isAuction = /auction|item|buy.?now/i.test(`${li.type} ${li.subtype}`);
    const item = matchItem(items, { name: li.description });
    if (!item || (!isAuction && norm(li.description) !== norm(item.name))) continue;
    await updateJSON(s, `items/${item.id}`, (cur) => {
      cur.paidAt = toIso(t.transacted_at || t.created_at);
      cur.paidAmount = toAmount(li.total ?? li.price);
      // No bids + paid = a Buy Now purchase.
      if (!highBid(cur)) { cur.status = "sold"; cur.soldPrice = cur.paidAmount; cur.soldTo = buyer; }
      cur.updatedAt = new Date().toISOString();
      return cur;
    });
    touched.push(item.name);
  }
  // Refresh campaign totals on the next display poll.
  await s.delete("cache/givebutter");
  return touched.length ? { result: "paid", detail: `Paid: ${touched.join(", ")}` } : { result: "ignored", detail: "No line items matched auction items." };
}

/* ---------- entry point ---------- */
export async function processWebhook(s, body) {
  const settings = await getSettings(s);
  const ev = norm(first(body.event, body.type, body.topic, body.event_type, body.action) || "bid.created");
  if (ev === "givebutter.feed") {
    const feed = body.data || {};
    if (!Array.isArray(feed.items)) return { result: "error", detail: "Feed payload needs data.items." };
    const r = await applyRelayedFeed(s, feed);
    return { result: "synced", detail: `Relay: ${r.items} items, ${r.withBids} with bids` };
  }
  if (ev === "campaign.updated" || ev === "campaign.created") return handleCampaignUpdated(s, body, settings);
  if (ev === "transaction.succeeded") return handleTransaction(s, body, settings);
  if (/bid/.test(ev) && /retract|delete|cancel|void|remov/.test(ev)) return handleBidRemoval(s, body);
  if (/item|lot|auction/.test(ev) && /clos|won|winner|end/.test(ev)) return handleItemClosed(s, body);
  if (/bid/.test(ev)) return handleBid(s, body, settings);
  return { result: "ignored", detail: `Event "${ev}" isn't used by the display.` };
}

export async function logDelivery(s, entry) {
  try {
    await updateJSON(s, LOG_KEY, (cur) => [entry, ...(cur || [])].slice(0, LOG_MAX));
  } catch (e) {
    console.error("webhook log failed", e.message);
  }
}

export async function readLog(s) {
  return (await s.get(LOG_KEY, { type: "json" })) || [];
}
