# Silent Auction Live Display

A big-screen display for a silent auction. It shows a countdown clock, every item's current bid and lead bidder, and a summary of the whole auction. Your Givebutter campaign total appears alongside. It runs on Netlify and deploys from Git.

| Page | Who uses it | What it does |
|---|---|---|
| `/` | Guests, on TVs or projectors | Countdown, item cards (current bid, leader, # of bids, next minimum, status), auction totals, latest bids, most-wanted items, Givebutter campaign total. Pages rotate automatically. |
| `/admin` | Staff and volunteers (password) | Givebutter live-sync status, manual bid entry as a backup, items, settings, webhook log. |
| `/raffle` | Guests, on the same TVs | The raffle drawing: prize up next, a slot-machine reel that lands on the winner, and the list of prizes and winners. |
| `/api/webhook` | Optional | Receives bid events from other tools, Givebutter events, and the fallback relay. |

## How bids get onto the screen

**Live sync from your Givebutter auction (primary).** The site reads the same JSON feed your public Givebutter auction page uses:

```
GET https://givebutter.com/campaign-api/auctions/61023/items?page=1&perPage=100
GET https://givebutter.com/campaign-api/auctions/61023/categories
```

One request returns every item with its **current top bid, the bidder's public name** (Givebutter already shortens it to "Leslie H." or "Anonymous"), bidder number, bid count, next minimum bid, end time (including any time added by Givebutter's automatic extensions), photos and category. You don't need to visit each item page.

- Items, photos, categories, values and closing time are all imported automatically. You don't need to enter anything.
- While a screen is open, the feed is pulled **every 10 seconds**, which matches the refresh rate Givebutter suggests. The pull happens at most once per interval, no matter how many screens are open. A scheduled function also syncs once a minute when nothing is open.
- Bids that are retracted on Givebutter disappear. Ended items show the winner. Buy Now–only items show their price and how many are left.
- Use **/admin › Settings › Live bids from Givebutter** to set the auction ID (`61023` for the Sarah Ramsey Strong 5K), check the last sync time, or click **Save & sync now**.

> **Two caveats.** (1) This feed is undocumented. Givebutter could change it without notice, so test it the week of the event. (2) Givebutter sits behind Cloudflare, which might block requests from Netlify's servers. If **Sync now** reports *"Givebutter blocked the server request"*, run the relay below.

**Fallback relay (only if the server is blocked).** On any laptop at the event with Node 20+:

```bash
SITE=https://YOUR-SITE.netlify.app WEBHOOK_SECRET=your-secret AUCTION_ID=61023 node scripts/gb-relay.mjs
```

It pulls the feed every 10 s from the laptop and pushes it to the site. Admin › Settings then shows "via relay". If the laptop stops, the server automatically starts trying again within a minute.

**Webhooks (optional).** `/api/webhook` also accepts bid events from other tools (see below) and Givebutter's own `campaign.updated` / `transaction.succeeded` events.

**Givebutter events the endpoint also uses** (subscribe to these in Givebutter › Settings › Integrations › Webhooks):
- `campaign.updated` refreshes the "Campaign raised" total instantly.
- `transaction.succeeded` marks auction items paid. If an item had no bids, it's marked **Sold** (Buy Now) with the buyer's name and price.

**Manual entry (backup).** Volunteers can still record or remove bids on `/admin › Record bids`.

**Givebutter API** supplies the campaign's total raised, goal and supporter count, plus recent transactions. These refresh once per minute.

### Webhook security
Set `WEBHOOK_SECRET` in Netlify. Every request must carry it in one of these places:
- a `Signature` header. Givebutter sends its webhook's signing secret this way, so copy that secret into `WEBHOOK_SECRET`.
- an `X-Webhook-Secret` header, or
- `?secret=...` on the URL, for tools that can't set headers.

Requests without the right secret get a `401` and are logged as **rejected**.

### Webhook payload
JSON, either a single event or an array of events. The event name comes from `event` (or `type`). Any name containing **bid** counts as a new bid. The endpoint accepts Givebutter-style nested payloads and flat ones:

```json
{
  "event": "bid.created",
  "data": {
    "id": "bid_123",
    "amount": 850,
    "created_at": "2026-10-17T20:15:00Z",
    "bidder": { "first_name": "Sarah", "last_name": "Ramsey", "bidder_number": "42" },
    "item":   { "id": "gb_item_9", "number": "12", "name": "Weekend at the Lake House" }
  }
}
```
```json
{ "type": "new_bid", "bid_id": "z-1", "item_number": "12", "amount": 850, "bidder_name": "Sarah Ramsey", "bidder_number": "42" }
```

| What | Field names accepted |
|---|---|
| Bid ID (for de-duplication) | `data.id`, `bid.id`, `bid_id`, top-level `id` |
| Amount (dollars) | `amount`, `bid_amount`, `current_bid`, `high_bid`. In cents: `amount_cents`, `amount_in_cents` |
| Time | `created_at`, `placed_at`, `timestamp` (defaults to now) |
| Bidder | `bidder` / `contact` / `supporter` object with `name` or `first_name` + `last_name`. Or `bidder_name`, or top-level `first_name`/`last_name` |
| Bidder # | `bidder_number`, `number`, `paddle_number` |
| Item | `item` / `auction_item` object with `id`, `number`/`item_number`/`lot`, `name`/`title`. Or `item_id`, `item_number`, `item_name` |

Behavior:
- **Item matching**: the endpoint tries the webhook item ID first (set it per item in **Items › Webhook / Givebutter item ID**), then the item number, then the name (case-insensitive). An unknown item is **created automatically**, so no bid is ever dropped.
- **Duplicates** (the same bid ID delivered twice) are ignored. Bids arriving **out of order** are fine, because the highest amount always leads.
- **Other events**: names containing *bid* plus *retract/cancel/delete/void/remove* remove that bid. Names containing *item/lot/auction* plus *closed/won/ended* close that item.
- The endpoint returns `200` for anything it handled or deliberately ignored, so senders don't retry. Every delivery is logged with its raw payload on `/admin › Settings`.

## Deploy (about 10 minutes)

1. **Put the code on GitHub**
   ```bash
   cd silent-auction-display
   git init && git add . && git commit -m "Silent auction display"
   # create an empty repo on github.com, then:
   git remote add origin https://github.com/YOUR-ORG/silent-auction-display.git
   git branch -M main && git push -u origin main
   ```
2. **Connect it to Netlify**: go to app.netlify.com, choose **Add new site › Import an existing project › GitHub**, and pick the repo. The build settings are read from `netlify.toml`, so leave them as they are.
3. **Add environment variables**: open **Site configuration › Environment variables** and add:
   - `GIVEBUTTER_API_KEY`: your Givebutter API key
   - `ADMIN_PASSWORD`: the password staff use on `/admin`
   - `WEBHOOK_SECRET`: the shared secret your bid webhook sends (for Givebutter webhooks, its signing secret)
4. **Redeploy**: go to **Deploys › Trigger deploy**. Environment variables only apply after a deploy.
5. Open `https://YOUR-SITE.netlify.app/admin`, sign in, and work through these steps:
   - **Settings › Live bids from Givebutter**: enter `61023` and click **Save & sync now**. All 13 items appear with their current bids.
   - **Settings › Event**: enter the title and the "Bid at" link. Leave the closing time blank to use Givebutter's. Optionally click **Load campaigns** to show the campaign total, then **Save**.
   - **Bid webhooks** (on Settings): copy the endpoint URL into your webhook source, then click **Send test bid** and watch it appear on the display.
   - **Danger zone**: clear all test bids before doors open.
6. Open `https://YOUR-SITE.netlify.app/` on the TV and press **F** (or click Full screen).

Data is stored in **Netlify Blobs**, which is built in, so there's no database to set up.

## Raffle drawing

Staff run the raffle from **/admin › Raffle**. Entries come from three places, and every entry has its own number:

| Source | Numbers | How to load |
|---|---|---|
| Givebutter raffle tickets | Givebutter's own, e.g. `A1042` | **Pull tickets from Givebutter** (API), or upload the Tickets export CSV (Givebutter › Tickets › filter to this campaign › Export) |
| Race participants | `R0001`, `R0002`, … | Upload a CSV of runners. Each gets **2 entries** (changeable). Columns: Name *or* First name + Last name, optional Email and Bib. A plain list of names also works. |
| Extra entries (cash sales, etc.) | `M0001`, `M0002`, … | Type a name and how many entries |

After pulling tickets, the **ticket type** table sets how many raffle entries each ticket type is worth. Types with "raffle" in the name start at 1 and everything else starts at 0, so race registrations or event admission sold as tickets don't count unless you change them.

**On draw day**
1. Add the prizes in the order you'll draw them, then click **Save prizes**.
2. Tick **Show the raffle on all display screens**. Every screen showing the auction switches to `/raffle` within a few seconds. You can also open `/raffle` directly on any screen.
3. Click **Draw winner**. The server picks a random entry (Node's `crypto.randomInt`), and every screen spins the reel and lands on it about 8 seconds later, with confetti and an optional sound effect (press **S** on the screen, or click it once to allow sound).
4. If the winner isn't present, click **Winner not here: redraw this prize**. Their winning entry stays out of the pool and the same prize is drawn again. **Undo** is for mistakes: it deletes the draw and puts the entry back.
5. Untick the checkbox to send the screens back to the auction.

**Winner chooses (prize table).** Set **How prizes are given** to *Draw a ticket, and the winner picks from the remaining prizes*. Each draw is then for a ticket rather than a prize. The screen shows the prizes still available, the reel lands on a winner, and the screen says to come choose. When they've picked, select that prize under **Prize they chose** and click **Assign prize**. The ticket and the prize both leave the list, and the screen shows what they chose. You can't start the next draw until the current winner has a prize, is marked not here, or the draw is undone. You can mix the two modes: pick a specific prize in **What this draw is for**, for example to save the grand prize for a final draw of its own.

Rules: a winning entry leaves the pool, but the winner's other entries stay in, so one person can win more than one prize. Names appear in full on the raffle screen, and emails never leave the admin page. **Download results CSV** gives you the winners with emails for follow-up. **Download all entries CSV** lists every entry number, which is handy for posting or for checking the pool.

Practice beforehand, then use **Reset raffle › Clear draws** to wipe the practice winners but keep the tickets and participants.

> Givebutter's API documents a ticket `id` and `id_suffix` but doesn't say which one holds the printed "A1042" number. The import uses whichever looks like a ticket number. After your first pull, check the sample shown under the button against a real ticket. If the numbers don't match, use the CSV export instead.

## Display options

- `/?mode=rotate` (default): item card pages, then the standings board, then an **item spotlight** (one item, very large, easy to read across the room). The spotlight moves to the next item each cycle.
- `/?mode=spotlight`: spotlight only, a new item every page (good for a second TV)
- `/?mode=grid`: item cards only
- `/?mode=board`: compact standings list only (good for a second screen)
- Keyboard: **F** for full screen, **← →** to flip pages manually
- Each page shows for "Seconds per page" (Admin › Settings › Display, default 15 s), including the spotlight
- After the closing time, the screen switches to **Final results** with winners and shows your thank-you banner.
- On phones, the page scrolls instead of rotating, so you can share the link with guests.

Bidder privacy: the public screen only ever receives "First L." (for example, "Sarah R.") or "Bidder #42". Full names stay on the admin page.

## Recording bids (volunteers)

On `/admin › Record bids`, type an item number and press Enter. Enter the amount, bidder name, and/or bidder number, then tap **Record bid**.
- Bids must beat the current high bid. The item's minimum increment is enforced unless you tick **Override**.
- Several volunteers can enter bids at once. Simultaneous entries are handled safely, so no bid gets lost.
- Mistakes: open the item and tap **Remove** next to the bad bid.
- Mark an item **Sold** (Buy Now) or **Closed** from Items › Edit. You can also give an item its own early closing time there.

## Local preview (optional)

```bash
npm install
ADMIN_PASSWORD=test node scripts/local-server.mjs                       # in-memory data; webhook secret "test-secret"
curl -X POST localhost:8888/api/webhook -H 'Signature: test-secret' -H 'content-type: application/json' \
  -d '{"event":"bid.created","data":{"id":"t1","amount":500,"bidder":{"name":"Sarah Ramsey"},"item":{"number":"1","name":"Test Item"}}}'
MOCK_GIVEBUTTER=1 ADMIN_PASSWORD=test node scripts/local-server.mjs     # with fake Givebutter data
MOCK_GB_FEED=./my-fixture.mjs ADMIN_PASSWORD=test node scripts/local-server.mjs  # replay a saved auction feed
```
Then open http://localhost:8888 and http://localhost:8888/admin. For a full Netlify emulation, use `npx netlify dev`.

## Files

```
netlify.toml                  build + routing
netlify/functions/state.mjs   GET /api/state   (public, masked names)
netlify/functions/admin.mjs   POST /api/admin  (password-protected actions)
netlify/functions/webhook.mjs POST /api/webhook (bid + Givebutter events, relay feed)
netlify/functions/gb-sync.mjs scheduled once-a-minute auction sync
scripts/gb-relay.mjs          fallback relay if Givebutter blocks the server
netlify/lib/                  storage, auction logic, webhook mapping, Givebutter client
public/index.html, display.js, styles.css   big-screen display
public/admin.html, admin.js                 staff page (incl. Raffle tab)
public/raffle.html, raffle.js, raffle.css   raffle drawing screen
netlify/functions/raffle.mjs  GET /api/raffle  (public raffle screen data, no emails)
netlify/lib/raffle.mjs        entries, draws, Givebutter ticket import
scripts/local-server.mjs      local preview without Netlify
```

Never commit your API key or webhook secret. It belongs only in Netlify's environment variables (`.env` is git-ignored).
