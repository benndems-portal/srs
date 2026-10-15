// GET /api/state — public, read-only snapshot used by the big-screen display.
// Bidder names are masked here ("Sarah R.") so full names never reach the screen.
import { store, getSettings, listItems, json } from "../lib/store.mjs";
import { publicItem, summarize, recentBids } from "../lib/auction.mjs";
import { givebutterSummary } from "../lib/givebutter.mjs";
import { syncIfStale } from "../lib/gbsync.mjs";

export default async () => {
  try {
    const s = store();
    const settings = await getSettings(s);
    // Pull fresh bids from Givebutter at most every ~10 s (shared across all screens).
    const sync = await syncIfStale(s, settings).catch((e) => ({ error: e.message }));
    if (!settings.endsAt && sync?.auctionEnd) settings.endsAt = sync.auctionEnd;
    const items = await listItems(s);
    const now = Date.now();
    const pub = items.map((i) => publicItem(i, settings, now));
    const givebutter = await givebutterSummary(s, settings);
    return json({
      serverTime: new Date(now).toISOString(),
      settings: {
        title: settings.title,
        subtitle: settings.subtitle,
        endsAt: settings.endsAt,
        bidUrl: settings.bidUrl,
        rotateSeconds: settings.rotateSeconds,
        closedMessage: settings.closedMessage,
        closingSoonMinutes: settings.closingSoonMinutes,
      },
      items: pub,
      summary: summarize(pub),
      recentBids: recentBids(items),
      givebutter,
      sync: sync ? { lastSuccess: sync.lastSuccess || null, ok: !sync.error } : null,
    });
  } catch (e) {
    console.error(e);
    return json({ error: "Could not load auction state." }, 500);
  }
};

export const config = { path: "/api/state" };
