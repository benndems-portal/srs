// POST /api/admin — staff-only actions, protected by the ADMIN_PASSWORD env var.
// Body: { action: "...", ...params }   Header: x-admin-password
import { timingSafeEqual, randomUUID } from "node:crypto";
import { store, getSettings, listItems, updateJSON, HttpError, json, DEFAULT_SETTINGS } from "../lib/store.mjs";
import { money, highBid, nextMinimum, publicItem, summarize } from "../lib/auction.mjs";
import { listCampaigns, givebutterSummary } from "../lib/givebutter.mjs";
import { processWebhook, logDelivery, readLog } from "../lib/webhook.mjs";
import { syncIfStale, readSyncMeta } from "../lib/gbsync.mjs";

function checkPassword(req) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) throw new HttpError(503, "ADMIN_PASSWORD is not set in Netlify environment variables.");
  const given = req.headers.get("x-admin-password") || "";
  const a = Buffer.from(given), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, "Incorrect password.");
}

const str = (v, max = 500) => String(v ?? "").trim().slice(0, max);
const num = (v) => {
  if (v === "" || v == null) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? money(n) : null;
};
const iso = (v) => {
  if (!v) return null;
  const t = Date.parse(v);
  if (isNaN(t)) throw new HttpError(400, `Invalid date: ${v}`);
  return new Date(t).toISOString();
};

function cleanItem(input, existing = {}) {
  const name = str(input.name ?? existing.name, 200);
  if (!name) throw new HttpError(400, "Item name is required.");
  return {
    ...existing,
    id: existing.id || randomUUID(),
    number: str(input.number ?? existing.number, 20),
    externalId: str(input.externalId ?? existing.externalId, 100),
    name,
    description: str(input.description ?? existing.description, 1000),
    category: str(input.category ?? existing.category, 80),
    image: str(input.image ?? existing.image, 1000),
    value: num(input.value ?? existing.value),
    startingBid: num(input.startingBid ?? existing.startingBid) ?? 0,
    minIncrement: num(input.minIncrement ?? existing.minIncrement) ?? 0,
    buyNow: num(input.buyNow ?? existing.buyNow),
    closesAt: "closesAt" in input ? iso(input.closesAt) : existing.closesAt || null,
    status: ["open", "closed", "sold"].includes(input.status) ? input.status : existing.status || "open",
    bids: existing.bids || [],
    updatedAt: new Date().toISOString(),
  };
}

const actions = {
  async login() {
    return { ok: true };
  },

  async getState({ s }) {
    const [settings, items, sync] = await Promise.all([getSettings(s), listItems(s), readSyncMeta(s)]);
    const now = Date.now();
    return {
      effectiveEndsAt: settings.endsAt || sync.auctionEnd || null,
      settings,
      items: items.map((i) => ({ ...i, ...publicItem(i, settings, now), bids: i.bids, storedStatus: i.status || "open", ownClosesAt: i.closesAt || null })),
      summary: summarize(items.map((i) => publicItem(i, settings, now))),
      givebutterConfigured: !!process.env.GIVEBUTTER_API_KEY,
    };
  },

  async saveSettings({ s, body }) {
    const input = body.settings || {};
    const cur = await getSettings(s);
    const next = { ...cur };
    for (const k of ["title", "subtitle", "bidUrl", "closedMessage", "campaignId"]) if (k in input) next[k] = str(input[k], 300);
    if ("gbAuctionId" in input) {
      // Accept a bare ID or anything containing /auctions/12345
      const v = str(input.gbAuctionId, 300);
      const m = v.match(/auctions\/(\d+)/) || v.match(/^(\d+)$/);
      if (v && !m) throw new HttpError(400, "Auction ID should be a number like 61023.");
      next.gbAuctionId = m ? m[1] : "";
    }
    if ("syncSeconds" in input) next.syncSeconds = Math.max(5, Math.min(120, Number(input.syncSeconds) || 10));
    for (const k of ["hotMinutes", "closingSoonMinutes", "rotateSeconds"]) if (k in input) next[k] = Math.max(1, Math.min(240, Number(input[k]) || DEFAULT_SETTINGS[k]));
    if ("showGivebutter" in input) next.showGivebutter = !!input.showGivebutter;
    if ("endsAt" in input) next.endsAt = iso(input.endsAt);
    await s.setJSON("settings", next);
    await s.delete("cache/givebutter");
    return { settings: next };
  },

  async upsertItem({ s, body }) {
    const input = body.item || {};
    if (input.id) {
      const item = await updateJSON(s, `items/${input.id}`, (cur) => {
        if (!cur) throw new HttpError(404, "Item not found.");
        return cleanItem(input, cur);
      });
      return { item };
    }
    const item = cleanItem(input);
    await s.setJSON(`items/${item.id}`, item);
    return { item };
  },

  async deleteItem({ s, body }) {
    await s.delete(`items/${str(body.id, 60)}`);
    return { ok: true };
  },

  async importItems({ s, body }) {
    const rows = Array.isArray(body.items) ? body.items.slice(0, 1000) : [];
    if (body.mode === "replace") {
      const existing = await s.list({ prefix: "items/" });
      await Promise.all(existing.blobs.map((b) => s.delete(b.key)));
    }
    let created = 0;
    const errors = [];
    for (const [i, row] of rows.entries()) {
      try {
        const item = cleanItem(row);
        await s.setJSON(`items/${item.id}`, item);
        created++;
      } catch (e) {
        errors.push(`Row ${i + 2}: ${e.message}`);
      }
    }
    return { created, errors };
  },

  async addBid({ s, body }) {
    const amount = num(body.amount);
    if (!amount) throw new HttpError(400, "Enter a bid amount.");
    const name = str(body.name, 120);
    const number = str(body.number, 20);
    if (!name && !number) throw new HttpError(400, "Enter the bidder's name or bidder number.");
    const settings = await getSettings(s);
    const item = await updateJSON(s, `items/${str(body.itemId, 60)}`, (cur) => {
      if (!cur) throw new HttpError(404, "Item not found.");
      const status = publicItem(cur, settings).status;
      if (["won", "unsold", "sold"].includes(status) && !body.force)
        throw new HttpError(409, "Bidding on this item is closed. Tick “Override” to record it anyway.");
      const hb = highBid(cur);
      if (hb && amount <= hb.amount) throw new HttpError(409, `Bid must be higher than the current $${hb.amount.toLocaleString()}.`);
      const min = nextMinimum(cur);
      if (amount < min && !body.force)
        throw new HttpError(409, `Minimum next bid is $${min.toLocaleString()}. Tick “Override” to accept it anyway.`);
      cur.bids = [...(cur.bids || []), { amount, name, number, at: new Date().toISOString(), id: randomUUID() }];
      cur.updatedAt = new Date().toISOString();
      return cur;
    });
    return { item: { ...item, ...publicItem(item, settings), bids: item.bids } };
  },

  async removeBid({ s, body }) {
    const settings = await getSettings(s);
    const item = await updateJSON(s, `items/${str(body.itemId, 60)}`, (cur) => {
      if (!cur) throw new HttpError(404, "Item not found.");
      cur.bids = body.bidId ? (cur.bids || []).filter((b) => b.id !== body.bidId) : (cur.bids || []).slice(0, -1);
      cur.updatedAt = new Date().toISOString();
      return cur;
    });
    return { item: { ...item, ...publicItem(item, settings), bids: item.bids } };
  },

  async clearAllBids({ s, body }) {
    if (body.confirm !== "CLEAR") throw new HttpError(400, "Type CLEAR to confirm.");
    const items = await listItems(s);
    await Promise.all(items.map((i) => s.setJSON(`items/${i.id}`, { ...i, bids: [], status: "open" })));
    return { cleared: items.length };
  },

  async syncNow({ s }) {
    const settings = await getSettings(s);
    if (!settings.gbAuctionId) throw new HttpError(400, "Enter the Givebutter auction ID and save first.");
    const r = await syncIfStale(s, settings, { force: true });
    if (r.error) throw new HttpError(502, r.error);
    return { sync: r };
  },

  async syncStatus({ s }) {
    return { sync: await readSyncMeta(s) };
  },

  async webhookLog({ s }) {
    return { log: await readLog(s), secretConfigured: !!process.env.WEBHOOK_SECRET };
  },

  // Runs a sample bid through the exact same code path as a real webhook.
  async testWebhook({ s, body }) {
    const items = await listItems(s);
    const it = items.find((i) => i.id === body.itemId) || items[0];
    if (!it) throw new HttpError(400, "Add an item first.");
    const payload = {
      event: "bid.created",
      data: { id: "test-" + randomUUID().slice(0, 8), amount: nextMinimum(it), created_at: new Date().toISOString(), bidder: { first_name: "Test", last_name: "Bidder", bidder_number: "0" }, item: { id: it.externalId || undefined, number: it.number, name: it.name } },
    };
    const res = await processWebhook(s, payload);
    await logDelivery(s, { at: new Date().toISOString(), event: "bid.created (test)", ...res, payload: JSON.stringify(payload) });
    return res;
  },

  async listCampaigns() {
    return { campaigns: await listCampaigns() };
  },

  async testGivebutter({ s }) {
    const settings = await getSettings(s);
    await s.delete("cache/givebutter");
    const data = await givebutterSummary(s, { ...settings, showGivebutter: true });
    if (!data) throw new HttpError(502, "Couldn't load that campaign from Givebutter. Check the campaign ID and API key.");
    return { givebutter: data };
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

export const config = { path: "/api/admin" };
