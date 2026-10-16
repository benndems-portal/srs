// Quick local preview without the Netlify CLI: in-memory storage, no deploy needed.
//   ADMIN_PASSWORD=test node scripts/local-server.mjs   ->  http://localhost:8888
// (For a full Netlify emulation, use `npx netlify dev` instead.)
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

process.env.LOCAL_MEMORY_STORE = "1";
process.env.ADMIN_PASSWORD ??= "test";
process.env.WEBHOOK_SECRET ??= "test-secret";

if (process.env.MOCK_GIVEBUTTER === "1") {
  process.env.GIVEBUTTER_API_KEY ??= "mock";
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).startsWith("https://api.givebutter.com")) return real(url, opts);
    const u = new URL(url);
    const camp = { id: 4242, code: "GALA26", title: "Spring Gala 2026", type: "event", status: "active", raised: 38450, goal: 50000, donors: 212, url: "https://givebutter.com/gala26" };
    let body;
    if (u.pathname === "/v1/campaigns") body = { data: [camp], meta: { current_page: 1, last_page: 1 } };
    else if (u.pathname.startsWith("/v1/campaigns/")) body = { data: camp };
    else if (u.pathname === "/v1/tickets") {
      // 230 sold tickets across three types, 100 per page.
      const first = ["Sarah", "Leslie", "Marcus", "Dana", "Priya", "Tom", "Keisha", "Luis", "Grace", "Owen", "Mei", "Andre"];
      const last = ["Ramsey", "Hughes", "Hill", "Lopez", "Patel", "Nguyen", "Brooks", "Garcia", "Kim", "Walsh", "Chen", "Ford"];
      const all = Array.from({ length: 230 }, (_, i) => {
        const f = first[i % 12], l = last[(i * 7) % 12];
        const title = i % 10 === 9 ? "5K Registration" : i % 3 ? "Raffle Ticket" : "Raffle Ticket (Bundle of 5)";
        return { id: "tk_" + (9000 + i), id_suffix: "A" + (1001 + i), transaction_id: "tr_" + Math.floor(i / 3), name: f + " " + l, first_name: f, last_name: l, email: `${f}.${l}${i % 5}@example.com`.toLowerCase(), phone: i % 4 === 3 ? "" : `(555) 2${String(i % 40).padStart(2, "0")}-${String(1000 + (i % 40)).slice(-4)}`, title, description: "", price: 10, created_at: new Date().toISOString() };
      });
      const page = Number(u.searchParams.get("page") || 1), per = 100, last_page = Math.ceil(all.length / per);
      body = { data: all.slice((page - 1) * per, page * per), meta: { current_page: page, last_page, per_page: per, total: all.length } };
    }
    else body = { data: [
      { campaign_id: 4242, first_name: "Dana", last_name: "Lopez", amount: 250, status: "succeeded", transacted_at: new Date(Date.now() - 120000).toISOString(), line_items: [{ description: "Gala ticket" }] },
      { campaign_id: 4242, first_name: "Marcus", last_name: "Hill", amount: 1000, status: "succeeded", transacted_at: new Date(Date.now() - 900000).toISOString(), line_items: [{ description: "Paddle raise" }] },
    ] };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
}

// MOCK_TWILIO=1 fakes Twilio: numbers ending in 0000 fail, everything else "sends". GET /__mock/sms lists sent texts.
const mockSms = [];
if (process.env.MOCK_TWILIO === "1") {
  process.env.TWILIO_ACCOUNT_SID ??= "ACmock";
  process.env.TWILIO_AUTH_TOKEN ??= "mock";
  process.env.TWILIO_MESSAGING_SERVICE_SID ??= "MGmock";
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (!String(url).startsWith("https://api.twilio.com/")) return prevFetch(url, opts);
    const f = new URLSearchParams(String(opts.body));
    if (f.get("To").endsWith("0000")) return new Response(JSON.stringify({ code: 21211, message: "The 'To' number is not a valid phone number." }), { status: 400 });
    mockSms.push({ to: f.get("To"), body: f.get("Body") });
    return new Response(JSON.stringify({ sid: "SM" + mockSms.length, status: "queued" }), { status: 201 });
  };
}

// MOCK_GB_FEED=/path/fixture.mjs replays a captured Givebutter auction feed.
// POST /__mock/bid {itemId, amount, name, number} simulates a new Givebutter bid.
let mockFeed = null;
if (process.env.MOCK_GB_FEED) {
  mockFeed = await import(process.env.MOCK_GB_FEED);
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    if (u.host !== "givebutter.com" || !u.pathname.startsWith("/campaign-api/")) return prev(url, opts);
    if (process.env.MOCK_GB_BLOCKED === "1") return new Response("<html>Just a moment...</html>", { status: 403, headers: { "content-type": "text/html" } });
    const body = u.pathname.endsWith("/categories") ? mockFeed.categories : { data: mockFeed.items, meta: { current_page: 1, last_page: 1 } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
}

const { default: state } = await import("../netlify/functions/state.mjs");
const { default: admin } = await import("../netlify/functions/admin.mjs");
const { default: webhook } = await import("../netlify/functions/webhook.mjs");
const { default: raffle } = await import("../netlify/functions/raffle.mjs");
const PUBLIC = new URL("../public/", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
const PORT = Number(process.env.PORT || 8888);

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/__mock/sms") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(mockSms)); }
  if (mockFeed && url.pathname === "/__mock/bid") {
    const chunks = []; for await (const c of req) chunks.push(c);
    const b = JSON.parse(Buffer.concat(chunks).toString());
    const it = mockFeed.items.find((i) => i.id === b.itemId);
    if (b.remove) { it.last_bids = it.last_bids.slice(1); it.last_bid = it.last_bids[0]; it.bid_count--; }
    else {
      const nb = mockFeed.bid(Date.now(), it.id, b.name, String(b.amount), b.number, new Date().toISOString());
      it.last_bids = [nb, ...it.last_bids]; it.last_bid = nb; it.bid_count++; it.minimum_bid = b.amount + it.bid_increment;
    }
    if (b.ended) { it.ended = true; it.winning_bid = it.last_bid; it.winning_bids = it.last_bid ? [it.last_bid] : []; }
    res.writeHead(200); return res.end("ok");
  }
  const fn = url.pathname === "/api/state" ? state : url.pathname === "/api/admin" ? admin : url.pathname === "/api/webhook" ? webhook : url.pathname === "/api/raffle" ? raffle : null;
  if (fn) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await fn(new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  let p = url.pathname === "/" ? "/index.html" : url.pathname === "/admin" ? "/admin.html" : url.pathname === "/raffle" ? "/raffle.html" : url.pathname === "/sell" ? "/sell.html" : url.pathname;
  const file = normalize(join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch { res.writeHead(404); res.end("Not found"); }
}).listen(PORT, () => console.log(`Display: http://localhost:${PORT}   Staff: http://localhost:${PORT}/admin  (password: ${process.env.ADMIN_PASSWORD})  Webhook: POST /api/webhook  (Signature: ${process.env.WEBHOOK_SECRET})`));
