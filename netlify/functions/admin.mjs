// POST /api/admin — staff-only actions, protected by the ADMIN_PASSWORD env var.
// Body: { action: "...", ...params }   Header: x-admin-password
import { timingSafeEqual, randomUUID } from "node:crypto";
import { store, getSettings, listItems, updateJSON, HttpError, json, DEFAULT_SETTINGS } from "../lib/store.mjs";
import { money, highBid, nextMinimum, publicItem, summarize } from "../lib/auction.mjs";
import { listCampaigns, givebutterSummary, gbWrite } from "../lib/givebutter.mjs";
import { processWebhook, logDelivery, readLog } from "../lib/webhook.mjs";
import { syncIfStale, readSyncMeta } from "../lib/gbsync.mjs";
import * as R from "../lib/raffle.mjs";
import { smsConfigured, normalizePhone, prettyPhone, sendSms, renderTemplate } from "../lib/sms.mjs";
import { saleDraft, completeSale, sendSaleText, applySmsResult, textSale, recordSaleInGb } from "../lib/sales.mjs";
import * as S from "../lib/stripe.mjs";
import { settleRequest, cancelRequest } from "../lib/cards.mjs";
import { pullContactsPage, getLookup } from "../lib/lookup.mjs";
import * as P from "../lib/printq.mjs";

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

  /* ---------------- Raffle ---------------- */
  async raffleState({ s }) {
    return raffleView(await R.getRaffle(s));
  },

  async raffleEntries({ s }) {
    const doc = await R.getRaffle(s);
    const used = new Map(doc.draws.map((d) => [d.number, d]));
    return { entries: R.buildEntries(doc).map((e) => ({ ...e, drawn: used.get(e.number)?.status || "" })) };
  },

  async rafflePullGivebutter({ s }) {
    const settings = await getSettings(s);
    const { tickets, sample } = await R.pullGivebutterTickets(settings.campaignId);
    if (!tickets.length) throw new HttpError(404, "Givebutter returned no tickets for this API key. If tickets were just sold, try again in a minute, or upload the Tickets export CSV instead.");
    const doc = await R.updateRaffle(s, (d) => setGbTickets(d, tickets, "api"));
    return { ...raffleView(doc), pulled: tickets.length, sample };
  },

  async raffleImportTickets({ s, body }) {
    const rows = Array.isArray(body.tickets) ? body.tickets.slice(0, 20000) : [];
    const tickets = R.dedupe(rows.map((r) => R.mapGbTicket({ ...r, number: str(r.number, 40), name: str(r.name, 120), email: str(r.email, 200), phone: str(r.phone, 40), title: str(r.type, 120) })).filter((t) => t.number));
    if (!tickets.length) throw new HttpError(400, "No ticket numbers found in that file.");
    const doc = await R.updateRaffle(s, (d) => setGbTickets(d, tickets, "csv"));
    return { ...raffleView(doc), pulled: tickets.length };
  },

  async raffleSetTypes({ s, body }) {
    const doc = await R.updateRaffle(s, (d) => {
      for (const [type, n] of Object.entries(body.typeEntries || {})) if (type in d.typeEntries) d.typeEntries[type] = Math.max(0, Math.min(20, Math.floor(Number(n) || 0)));
    });
    return raffleView(doc);
  },

  async raffleLoadParticipants({ s, body }) {
    const rows = Array.isArray(body.participants) ? body.participants.slice(0, 10000) : [];
    const list = rows.map((r) => ({ name: str(r.name, 120), email: str(r.email, 200), phone: str(r.phone, 40), bib: str(r.bib, 20) })).filter((p) => p.name);
    if (!list.length && !body.clear) throw new HttpError(400, "No names found in that file.");
    const each = Math.max(0, Math.min(20, Math.floor(Number(body.each ?? 2))));
    const doc = await R.updateRaffle(s, (d) => {
      if (d.draws.some((x) => x.source === "participant") && !body.force)
        throw new HttpError(409, "A race participant has already been drawn. Reloading would renumber their entries — tick “Reload anyway” if you're sure.");
      d.participants = body.clear ? [] : list;
      d.participantsEach = each;
      d.participantsLoadedAt = new Date().toISOString();
    });
    return raffleView(doc);
  },

  async raffleAddManual({ s, body }) {
    const name = str(body.name, 120);
    const count = Math.floor(Number(body.count) || 0);
    if (!name) throw new HttpError(400, "Enter a name.");
    if (count < 1 || count > 500) throw new HttpError(400, "Enter how many entries (1–500).");
    const doc = await R.updateRaffle(s, (d) => { d.manual.push({ id: randomUUID(), name, email: str(body.email, 200), count, at: new Date().toISOString() }); });
    return raffleView(doc);
  },

  async raffleRemoveManual({ s, body }) {
    const doc = await R.updateRaffle(s, (d) => {
      if (d.draws.some((x) => x.source === "manual")) throw new HttpError(409, "Entries added by hand can't be removed after one of them has been drawn (it would renumber them).");
      d.manual = d.manual.filter((m) => m.id !== body.id);
    });
    return raffleView(doc);
  },

  async raffleSavePrizes({ s, body }) {
    const input = Array.isArray(body.prizes) ? body.prizes.slice(0, 200) : [];
    const doc = await R.updateRaffle(s, (d) => {
      const byId = new Map(d.prizes.map((p) => [p.id, p]));
      const next = input.map((p) => ({ id: byId.has(p.id) ? p.id : randomUUID(), name: str(p.name, 160), detail: str(p.detail, 300), image: str(p.image, 1000) })).filter((p) => p.name);
      const keep = new Set(next.map((p) => p.id));
      const orphan = d.draws.find((x) => x.status === "won" && x.prizeId && !keep.has(x.prizeId));
      if (orphan) throw new HttpError(409, `“${orphan.prizeName}” already has a winner, so it can't be removed. Undo that draw first.`);
      d.prizes = next;
      if ("title" in body) d.title = str(body.title, 120) || R.EMPTY.title;
      if ("awardMode" in body) d.awardMode = body.awardMode === "choice" ? "choice" : "prize";
    });
    return raffleView(doc);
  },

  async raffleAwardMode({ s, body }) {
    const doc = await R.updateRaffle(s, (d) => { d.awardMode = body.awardMode === "choice" ? "choice" : "prize"; });
    return raffleView(doc);
  },

  async raffleAssign({ s, body }) {
    let assigned;
    const doc = await R.updateRaffle(s, (d) => { assigned = R.assignPrize(d, str(body.drawId, 60), str(body.prizeId, 60)); d.current = assigned.id; });
    return { ...raffleView(doc), assigned };
  },

  async raffleLive({ s, body }) {
    const doc = await R.updateRaffle(s, (d) => { d.live = !!body.live; if (!d.live) d.current = null; });
    return raffleView(doc);
  },

  async raffleDraw({ s, body }) {
    let drawn;
    const doc = await R.updateRaffle(s, (d) => { drawn = R.draw(d, str(body.prizeId, 60) || null); d.live = true; });
    return { ...raffleView(doc), drawn };
  },

  // Winner isn't here: their entry stays out of the pool and the same prize is drawn again.
  async raffleRedraw({ s, body }) {
    let drawn;
    const doc = await R.updateRaffle(s, (d) => {
      const prev = d.draws.find((x) => x.id === body.drawId);
      if (!prev || prev.status !== "won") throw new HttpError(404, "That draw isn't a current winner.");
      prev.status = "forfeit";
      prev.forfeitAt = new Date().toISOString();
      drawn = R.draw(d, prev.choice ? "choice" : prev.prizeId);
      d.live = true;
    });
    return { ...raffleView(doc), drawn };
  },

  // Mistake (e.g. wrong prize selected): delete the draw and return the entry to the pool.
  async raffleUndo({ s, body }) {
    const doc = await R.updateRaffle(s, (d) => {
      d.draws = d.draws.filter((x) => x.id !== body.drawId);
      if (d.current === body.drawId) d.current = null;
    });
    return raffleView(doc);
  },

  async raffleShowIdle({ s }) {
    const doc = await R.updateRaffle(s, (d) => { d.current = null; });
    return raffleView(doc);
  },

  // Wipes every sale (practice runs) so race-day numbers start again at 2026 0001.
  async raffleClearSales({ s, body }) {
    if (body.confirm !== "RESET") throw new HttpError(400, "Type RESET to confirm.");
    const cur = await R.getRaffle(s);
    const live = cur.sales.filter((x) => x.stripe?.livemode && !x.stripe?.refunded);
    if (live.length) throw new HttpError(409, `${live.length} sale(s) were charged on a real card (${live.map((x) => x.name).join(", ")}). Void them on the Sell page first so the money is refunded, then clear.`);
    const doc = await R.updateRaffle(s, (d) => {
      const nums = new Set(d.sales.flatMap((x) => x.numbers));
      for (const n of nums) delete d.texted[n];
      d.sales = []; d.saleSeq = 0;
      d.draws = d.draws.filter((x) => !nums.has(x.number));
    });
    return { cleared: cur.sales.length, ...raffleView(doc) };
  },

  async raffleReset({ s, body }) {
    if (body.confirm !== "RESET") throw new HttpError(400, "Type RESET to confirm.");
    const doc = await R.updateRaffle(s, (d) => {
      d.draws = []; d.current = null; d.live = false;
      if (body.everything) { d.gbTickets = []; d.typeEntries = {}; d.gbPulledAt = null; d.gbSource = null; d.participants = []; d.participantsLoadedAt = null; d.manual = []; }
    });
    return raffleView(doc);
  },

  /* ---------------- Raffle: event sales + texting ---------------- */
  async raffleSaveSalesConfig({ s, body }) {
    const c = body.config || {};
    const doc = await R.updateRaffle(s, (d) => {
      const cur = d.salesConfig || {};
      const price = num(c.price ?? cur.price);
      const bundles = (Array.isArray(c.bundles) ? c.bundles : cur.bundles || [])
        .map((b) => ({ count: Math.floor(Number(b.count) || 0), price: num(b.price) }))
        .filter((b) => b.count > 1 && b.count <= 500 && b.price != null)
        .sort((a, b) => a.count - b.count)
        .slice(0, 8);
      d.salesConfig = { ...cur, price: price ?? 0, bundles, slipFooter: str(c.slipFooter ?? cur.slipFooter, 200), drawingInfo: str(c.drawingInfo ?? cur.drawingInfo, 120) };
      if ("smsTemplate" in body) {
        const t = str(body.smsTemplate, 600);
        if (t && !t.includes("{numbers}")) throw new HttpError(400, "The text message must include {numbers}.");
        d.smsTemplate = t || R.EMPTY.smsTemplate;
      }
    });
    return raffleView(doc);
  },

  // Cash, check, or a card already charged some other way (e.g. Tap to Pay in the Stripe app).
  async raffleSell({ s, body }) {
    const cur = await R.getRaffle(s);
    const draft = saleDraft(body, cur.salesConfig);
    const { doc, sale } = await completeSale(s, draft);
    return { ...raffleView(doc), sale: saleView(sale) };
  },

  /* ---------------- Card payments on the iPhone terminal (Stripe Reader M2) ---------------- */
  async cardStart({ s, body }) {
    const doc = await R.getRaffle(s);
    const draft = { ...saleDraft({ ...body, payment: "card" }, doc.salesConfig), payment: "card" };
    const req = await S.createCardRequest(s, { draft, title: doc.title, terminal: S.cleanTerminalId(body.terminal) });
    return { request: S.publicRequest(req), terminals: S.liveTerminals(await S.getQueue(s)) };
  },

  async cardStatus({ s, body }) {
    const id = String(body.id || "");
    let r = (await S.getQueue(s)).requests.find((x) => x.id === id);
    if (!r) throw new HttpError(404, "That card payment wasn't found.");
    // While a phone has the charge, ask Stripe directly now and then, in case the phone lost signal after the tap.
    const since = Date.now() - Date.parse(r.claimedAt || r.createdAt);
    if (r.status === "processing" && since > 4000 && body.check) r = await settleRequest(s, id);
    let sale = null;
    if (r.status === "succeeded") {
      const doc = await R.getRaffle(s);
      sale = doc.sales.find((x) => x.id === (r.saleId || r.id)) || null;
    }
    const q = await S.getQueue(s);
    return { request: S.publicRequest(q.requests.find((x) => x.id === id) || r), sale: sale && saleView(sale), terminals: S.liveTerminals(q) };
  },

  async cardCancel({ s, body }) {
    const r = await cancelRequest(s, String(body.id || ""), "laptop");
    let sale = null;
    if (r.status === "succeeded") sale = (await R.getRaffle(s)).sales.find((x) => x.id === (r.saleId || r.id)) || null;
    return { request: S.publicRequest(r), sale: sale && saleView(sale) };
  },

  async cardTerminals({ s }) {
    return { terminals: S.liveTerminals(await S.getQueue(s)), configured: S.stripeConfigured(), mode: S.stripeMode() };
  },

  /* ---------------- Buyer lookup (Givebutter contacts) ---------------- */
  async lookupPull({ s, body }) {
    return pullContactsPage(s, Math.max(1, Math.floor(Number(body.fromPage) || 1)));
  },

  async lookupIndex({ s }) {
    return getLookup(s);
  },

  async raffleSaveNumbering({ s, body }) {
    const c = body.numbering || {};
    const doc = await R.updateRaffle(s, (d) => {
      const cur = R.numbering(d);
      const prefix = str(c.prefix ?? cur.prefix, 8).replace(/\D/g, "");
      if (!prefix) throw new HttpError(400, "The prefix must be digits, e.g. 2026.");
      const block = (v, dflt) => { const n = Math.floor(Number(v)); if (!(n >= 0 && n <= 9999)) throw new HttpError(400, "Block starts must be between 0 and 9999."); return n; };
      const next = { prefix, saleStart: block(c.saleStart ?? cur.saleStart), participantStart: block(c.participantStart ?? cur.participantStart), manualStart: block(c.manualStart ?? cur.manualStart) };
      if ((d.sales || []).length && (next.prefix !== cur.prefix || next.saleStart !== cur.saleStart)) throw new HttpError(409, "Tickets have already been sold, so the prefix and sold-ticket start can't change now (sold numbers never change). Reset sales first.");
      d.numbering = next;
    });
    return raffleView(doc);
  },

  async raffleSaveGbRecord({ s, body }) {
    const doc = await R.updateRaffle(s, (d) => {
      const cur = { ...R.EMPTY.gbRecord, ...(d.gbRecord || {}) };
      const c = body.gbRecord || {};
      d.gbRecord = {
        ...cur,
        enabled: "enabled" in c ? !!c.enabled : cur.enabled,
        auto: "auto" in c ? !!c.auto : cur.auto,
        recordCard: "recordCard" in c ? !!c.recordCard : cur.recordCard,
        campaignCode: "campaignCode" in c ? str(c.campaignCode, 60) : cur.campaignCode,
        timezone: "timezone" in c ? str(c.timezone, 60) || cur.timezone : cur.timezone,
        fallbackEmail: "fallbackEmail" in c ? str(c.fallbackEmail, 200) : cur.fallbackEmail || "",
      };
    });
    return raffleView(doc);
  },

  // Record any sales that aren't in Givebutter yet (e.g. after a network hiccup), 10 at a time.
  async raffleRecordPending({ s }) {
    let doc = await R.getRaffle(s);
    const todo = doc.sales.filter((x) => R.shouldRecord(doc, x));
    const batch = todo.slice(0, 10);
    const results = await Promise.all(batch.map((x) => recordSaleInGb(doc, x)));
    doc = await R.updateRaffle(s, (d) => { batch.forEach((x, i) => { d.sales.find((y) => y.id === x.id).gb = results[i]; }); });
    return { recorded: results.filter((r) => r.status === "recorded").length, failed: results.filter((r) => r.status !== "recorded").map((r, i) => ({ name: batch[i].name, error: r.error })), remaining: todo.length - batch.length, ...raffleView(doc) };
  },

  // Creates one real $1.00 cash transaction marked TEST so you can see where sales land in Givebutter.
  async raffleTestGbRecord({ s }) {
    const doc = await R.getRaffle(s);
    const fake = { id: "test-" + randomUUID().slice(0, 8), name: "Raffle Test", amount: 1, payment: "cash", at: new Date().toISOString(), numbers: ["20269999"], count: 1, email: "", phone: "" };
    const body = R.gbTransactionBody(doc, fake);
    body.internal_note = "TEST from the raffle Sell page. Delete this transaction. " + body.internal_note;
    const tx = await gbWrite("POST", "/transactions", body);
    return { ok: true, id: tx.id ?? tx.tid ?? null, campaign: body.campaign_code || "(no campaign)", sent: body };
  },

  /* ---------------- Print station (laptop + USB receipt printer, running /print) ---------------- */
  async printSend({ s, body }) {
    const id = str(body.saleId, 80);
    const doc = await R.getRaffle(s);
    if (!doc.sales.some((x) => x.id === id)) throw new HttpError(404, "That sale wasn't found.");
    const job = await P.addJob(s, { saleId: id, from: str(body.from, 60), reprint: !!body.reprint });
    const q = await P.getPrintQueue(s);
    return { job, printers: P.livePrinters(q), waiting: P.waitingCount(q) };
  },

  async printTest({ s, body }) {
    const job = await P.addJob(s, { kind: "test", from: str(body.from, 60) });
    return { job };
  },

  async printPoll({ s, body }) {
    const jobs = await P.claimJobs(s, body.printer || {});
    let doc = null;
    if (jobs.some((j) => j.kind === "slip")) doc = await R.getRaffle(s);
    const out = jobs.map((j) => {
      const sale = j.kind === "slip" ? doc.sales.find((x) => x.id === j.saleId) : null;
      return { ...j, sale: sale ? saleView(sale) : null };
    });
    const meta = doc || (await R.getRaffle(s));
    return { jobs: out, title: meta.title, salesConfig: meta.salesConfig, numbering: R.numbering(meta) };
  },

  async printDone({ s, body }) {
    await P.finishJobs(s, body.ids, str(body.printer?.id ?? body.printerId, 60), str(body.error, 200));
    return { ok: true };
  },

  async printJobs({ s }) {
    const q = await P.getPrintQueue(s);
    const doc = await R.getRaffle(s);
    const names = new Map(doc.sales.map((x) => [x.id, x]));
    return {
      printers: P.livePrinters(q),
      jobs: q.jobs.slice(-40).reverse().map((j) => { const x = names.get(j.saleId); return { ...j, name: x?.name || "", count: x?.count || 0 }; }),
    };
  },

  async raffleSales({ s }) {
    const doc = await R.getRaffle(s);
    const gbRecord = { ...R.EMPTY.gbRecord, ...(doc.gbRecord || {}) };
    const [q, pq] = await Promise.all([S.getQueue(s), P.getPrintQueue(s)]);
    return { sales: doc.sales.slice().reverse().map(saleView), summary: R.salesSummary(doc), salesConfig: doc.salesConfig, title: doc.title, smsConfigured: smsConfigured(), gbRecording: gbRecord.enabled && !!process.env.GIVEBUTTER_API_KEY, gbAuto: gbRecord.auto, numbering: R.numbering(doc), stripe: { configured: S.stripeConfigured(), mode: S.stripeMode() }, terminals: S.liveTerminals(q), printers: P.livePrinters(pq), printWaiting: P.waitingCount(pq) };
  },

  async raffleVoidSale({ s, body }) {
    let doc = await R.updateRaffle(s, (d) => {
      const sale = d.sales.find((x) => x.id === body.id);
      if (!sale) throw new HttpError(404, "Sale not found.");
      const drawn = d.draws.find((x) => sale.numbers.includes(x.number));
      if (drawn) throw new HttpError(409, `Ticket ${drawn.number} from this sale has already been drawn, so the sale can't be voided. Undo that draw first.`);
      if (body.restore && sale.stripe?.refunded) throw new HttpError(409, "This card sale was refunded, so it can't be restored. Make a new sale instead.");
      sale.voided = !body.restore;
      sale.voidedAt = sale.voided ? new Date().toISOString() : null;
    });
    let sale = doc.sales.find((x) => x.id === body.id);
    // Card sales taken through Stripe can be refunded right here.
    let refund = null;
    if (sale.voided && body.refund && sale.stripe?.pi && !sale.stripe.refunded) {
      try {
        const rf = await S.refundPi(sale.stripe.pi);
        refund = { ok: true, id: rf.id };
        doc = await R.updateRaffle(s, (d) => { const x = d.sales.find((y) => y.id === sale.id); x.stripe = { ...x.stripe, refunded: rf.id, refundedAt: new Date().toISOString() }; });
        sale = doc.sales.find((x) => x.id === body.id);
      } catch (e) { refund = { ok: false, error: e.message }; }
    }
    // Givebutter's API can't delete or change the amount of a transaction, so flag it in the note.
    let gbNote = null;
    if (sale.gb?.status === "recorded" && sale.gb.id) {
      const base = R.gbTransactionBody(doc, sale).internal_note;
      try {
        await gbWrite("PUT", `/transactions/${encodeURIComponent(sale.gb.id)}`, { internal_note: sale.voided ? `VOIDED ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })}: refund or delete this transaction in Givebutter. ${base}` : base });
        gbNote = sale.voided ? "flagged" : "restored";
      } catch (e) { gbNote = "error: " + e.message; }
      const doc2 = await R.updateRaffle(s, (d) => { const x = d.sales.find((y) => y.id === sale.id); x.gb = { ...x.gb, voidFlag: gbNote }; });
      return { ...raffleView(doc2), gbNote, refund };
    }
    return { ...raffleView(doc), gbNote, refund };
  },

  async raffleResendSale({ s, body }) {
    let doc = await R.getRaffle(s);
    const sale = doc.sales.find((x) => x.id === body.id);
    if (!sale) throw new HttpError(404, "Sale not found.");
    if (body.phone) {
      const phone = normalizePhone(body.phone);
      if (!phone) throw new HttpError(400, "That phone number doesn't look right.");
      doc = await R.updateRaffle(s, (d) => { d.sales.find((x) => x.id === sale.id).phone = phone; });
    }
    doc = await textSale(s, doc, sale.id);
    return { ...raffleView(doc), sale: saleView(doc.sales.find((x) => x.id === sale.id)) };
  },

  async raffleTestSms({ s, body }) {
    const to = normalizePhone(body.phone);
    if (!to) throw new HttpError(400, "Enter a phone number to send the test to.");
    const doc = await R.getRaffle(s);
    const text = renderTemplate(doc.smsTemplate, R.smsBody(doc, { name: "Test Buyer", numbers: [R.numbering(doc).prefix + "0001", R.numbering(doc).prefix + "0002"] }));
    const r = await sendSms(to, text);
    return { ok: true, text, sid: r.sid };
  },

  // Texts entry numbers to everyone with a phone who hasn't been texted yet,
  // in batches (the page calls this repeatedly until nothing is left).
  async raffleTextPending({ s, body }) {
    let doc = await R.getRaffle(s);
    const { groups, noPhone } = R.textQueue(doc, normalizePhone);
    const sources = Array.isArray(body.sources) && body.sources.length ? body.sources : ["givebutter", "participant", "sale"];
    const todo = groups.filter((g) => g.sources.some((x) => sources.includes(x)));
    if (body.dryRun) return { pending: todo.length, pendingNumbers: todo.reduce((t, g) => t + g.numbers.length, 0), noPhone, preview: todo.slice(0, 5).map((g) => ({ to: prettyPhone(g.to), name: g.name, numbers: g.numbers })), smsConfigured: smsConfigured() };
    if (!smsConfigured()) throw new HttpError(503, "Texting isn't set up in Netlify yet (Twilio environment variables).");
    const batch = todo.slice(0, 15);
    const results = await Promise.all(batch.map(async (g) => {
      try { await sendSms(g.to, renderTemplate(doc.smsTemplate, R.smsBody(doc, g))); return { ...g, ok: true }; }
      catch (e) { return { ...g, ok: false, error: e.message }; }
    }));
    doc = await R.updateRaffle(s, (d) => {
      const now = new Date().toISOString();
      for (const r of results) {
        // Failed numbers are marked too, so one bad phone can't block the queue; resend from the log.
        for (const n of r.numbers) d.texted[n] = r.ok ? now : "failed:" + now;
        R.logSms(d, { to: r.to, name: r.name, numbers: r.numbers, ok: r.ok, error: r.error || "", kind: "bulk" });
        for (const sale of d.sales) if (sale.numbers.some((n) => r.numbers.includes(n))) sale.sms = r.ok ? { status: "sent", at: now } : { status: "failed", at: now, error: r.error };
      }
    });
    return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => ({ to: prettyPhone(r.to), name: r.name, error: r.error })), remaining: Math.max(0, todo.length - batch.length), ...raffleView(doc) };
  },

  async raffleSmsLog({ s }) {
    const doc = await R.getRaffle(s);
    return { log: (doc.smsLog || []).map((l) => ({ ...l, to: prettyPhone(l.to) })) };
  },

  // Let failed or skipped numbers be texted again by the bulk sender.
  async raffleRetryFailedTexts({ s }) {
    let n = 0;
    const doc = await R.updateRaffle(s, (d) => { for (const [k, v] of Object.entries(d.texted)) if (String(v).startsWith("failed:")) { delete d.texted[k]; n++; } });
    return { cleared: n, ...raffleView(doc) };
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

function setGbTickets(d, tickets, source) {
  d.gbTickets = tickets;
  d.gbPulledAt = new Date().toISOString();
  d.gbSource = source;
  // Remember staff choices per ticket type; new types get a sensible default.
  for (const t of tickets) if (!(t.type in d.typeEntries)) d.typeEntries[t.type] = R.defaultEntriesFor(t.type);
}

function saleView(x) {
  return { ...x, phonePretty: prettyPhone(x.phone) };
}

function raffleView(doc) {
  const types = {};
  for (const t of doc.gbTickets) types[t.type] = (types[t.type] || 0) + 1;
  return {
    raffle: {
      title: doc.title,
      live: doc.live,
      current: doc.current,
      gb: { count: doc.gbTickets.length, pulledAt: doc.gbPulledAt, source: doc.gbSource, sample: doc.gbTickets.slice(0, 3) },
      types: Object.entries(types).map(([type, count]) => ({ type, count, entries: doc.typeEntries[type] ?? 0 })).sort((a, b) => b.count - a.count),
      participants: { count: doc.participants.length, each: doc.participantsEach, loadedAt: doc.participantsLoadedAt, sample: doc.participants.slice(0, 5) },
      manual: doc.manual,
      prizes: doc.prizes,
      awardMode: doc.awardMode || "prize",
      available: R.availablePrizes(doc).map((p) => p.id),
      choosing: R.choosingDraw(doc),
      next: R.nextPrize(doc),
      draws: doc.draws,
      pool: R.poolSummary(doc),
      salesConfig: doc.salesConfig,
      smsTemplate: doc.smsTemplate,
      smsConfigured: smsConfigured(),
      salesSummary: R.salesSummary(doc),
      gbRecord: { ...R.EMPTY.gbRecord, ...(doc.gbRecord || {}) },
      numbering: R.numbering(doc),
      stripe: { configured: S.stripeConfigured(), mode: S.stripeMode() },
      gbConfigured: !!process.env.GIVEBUTTER_API_KEY,
      gbUnrecorded: doc.sales.filter((x) => R.shouldRecord(doc, x)).length,
      gbVoidedToFix: doc.sales.filter((x) => x.voided && x.gb?.status === "recorded").length,
      textPending: R.textQueue(doc, normalizePhone).groups.length,
    },
  };
}

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
