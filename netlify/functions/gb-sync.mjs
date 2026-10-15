// Scheduled: pulls the Givebutter auction feed once a minute even when no
// screen is open, so /admin and the display are never stale on first load.
// (While screens are open, /api/state syncs every ~10 s on its own.)
import { store, getSettings } from "../lib/store.mjs";
import { syncIfStale } from "../lib/gbsync.mjs";

export default async () => {
  const s = store();
  const r = await syncIfStale(s, await getSettings(s));
  console.log("gb-sync", r ? (r.error || `${r.items} items, ${r.withBids} with bids`) : "no auction configured");
};

export const config = { schedule: "* * * * *" };
