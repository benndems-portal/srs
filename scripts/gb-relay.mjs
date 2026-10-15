// Fallback relay — only needed if Givebutter blocks requests from Netlify's
// servers (the /admin "Sync now" button will say so). Run it on any laptop at
// the event; it reads the public auction feed every 10 s and pushes it to the site.
//
//   SITE=https://your-site.netlify.app WEBHOOK_SECRET=... AUCTION_ID=61023 node scripts/gb-relay.mjs
//
// Needs Node 20+. No npm install required.
import { fetchFeed } from "../netlify/lib/gbsync.mjs";

const { SITE, WEBHOOK_SECRET, AUCTION_ID } = process.env;
const EVERY = Number(process.env.EVERY_SECONDS || 10) * 1000;
if (!SITE || !WEBHOOK_SECRET || !AUCTION_ID) {
  console.error("Set SITE, WEBHOOK_SECRET and AUCTION_ID. Example:\n  SITE=https://your-site.netlify.app WEBHOOK_SECRET=xxx AUCTION_ID=61023 node scripts/gb-relay.mjs");
  process.exit(1);
}

async function once() {
  const t = new Date().toLocaleTimeString();
  try {
    const feed = await fetchFeed(AUCTION_ID);
    const res = await fetch(new URL("/api/webhook", SITE), {
      method: "POST",
      headers: { "content-type": "application/json", Signature: WEBHOOK_SECRET },
      body: JSON.stringify({ event: "givebutter.feed", data: feed }),
    });
    const body = await res.json().catch(() => ({}));
    console.log(t, res.status, body.results?.[0]?.detail || body.error || "");
  } catch (e) {
    console.error(t, "error:", e.message);
  }
}

await once();
setInterval(once, EVERY);
