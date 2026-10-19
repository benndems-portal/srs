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
   - `STRIPE_SECRET_KEY`: your Stripe secret key, for raffle card payments on the M2 readers (start with `sk_test_…`, switch to `sk_live_…` for the event)
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`: texting ticket numbers
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
| Race participants | `20265001`, `20265002`, … | Upload a CSV of runners. Each gets **2 entries** (changeable). Columns: Name *or* First name + Last name, optional Email and Bib. A plain list of names also works. |
| Tickets sold at the event (`/sell`) | `20260001`, `20260002`, … | Sold on the Sell page (below) |
| Extra entries (sponsors, volunteers) | `20269001`, `20269002`, … | Type a name and how many entries |

**Ticket numbers** are 8 digits: the year, then 4 digits, with a separate block for each kind of entry so numbers never overlap. Change the prefix or the blocks under **/admin › Raffle › Ticket numbers** (the prefix and the sold-ticket start lock once the first ticket is sold).

After pulling tickets, the **ticket type** table sets how many raffle entries each ticket type is worth. Types with "raffle" in the name start at 1 and everything else starts at 0, so race registrations or event admission sold as tickets don't count unless you change them.

**On draw day**
1. Add the prizes in the order you'll draw them, then click **Save prizes**.
2. Tick **Show the raffle on all display screens**. Every screen showing the auction switches to `/raffle` within a few seconds. You can also open `/raffle` directly on any screen.
3. Click **Draw winner**. The server picks a random entry (Node's `crypto.randomInt`). Every screen then shows the winning number on eight digit drums: **2026** locks in within about 2 seconds, then each of the last four digits spins a little longer than the one before, the last one crawling into place at about 10 seconds. Confetti and an optional sound effect follow (press **S** on the screen, or click it once to allow sound). **Names are never shown on the screen**, only the ticket number; the winner's name is on the staff page.
4. If the winner isn't present, click **Winner not here: redraw this prize**. Their winning entry stays out of the pool and the same prize is drawn again. **Undo** is for mistakes: it deletes the draw and puts the entry back.
5. Untick the checkbox to send the screens back to the auction.

**Winner chooses (prize table).** Set **How prizes are given** to *Draw a ticket, and the winner picks from the remaining prizes*. Each draw is then for a ticket rather than a prize. The screen shows the prizes still available, the reel lands on a winner, and the screen says to come choose. When they've picked, select that prize under **Prize they chose** and click **Assign prize**. The ticket and the prize both leave the list, and the screen shows what they chose. You can't start the next draw until the current winner has a prize, is marked not here, or the draw is undone. You can mix the two modes: pick a specific prize in **What this draw is for**, for example to save the grand prize for a final draw of its own.

### Selling tickets at the event (`/sell`)

The Sell page is for volunteers on a laptop, and it uses the staff password. It is built to be fast and keyboard-driven:

1. **Find the buyer.** Start typing their **phone number** (or their **last name**, or "last first"). Matches come up instantly from your Givebutter contacts and from people who already bought today; **↑/↓** and **Enter** pick one, or **Enter** on "+ New buyer" to fill in what you typed. Name and phone are filled in and can still be edited.
2. **Pick a quantity** (1 or a bundle button, **←/→** to move, or type another number) and check the total.
3. **Take payment:** **Cash (F1)**, **Check (F2)** (type the check number, optional, then Enter) or **Card (F3)**.
   - Card sends the charge to the **SRS Card Terminal** iPhone app paired with a Stripe Reader M2 (see below). The laptop shows "Tap, insert or swipe on Table 1 iPhone", then "Approving…". When Stripe approves it, the sale is created on its own. **Cancel card payment** stops it; if the card had already gone through, the sale is kept.
   - **Card charged another way…** records a card payment taken outside the app (for example Tap to Pay in the Stripe Dashboard app), as a backup.

The sale then gets permanent numbers (**20260001, 20260002, …**) that go straight into the drawing, prints one receipt slip and texts the numbers to the buyer. **Enter** starts the next buyer.

The page also shows running cash/check/card totals and which card terminals are online, plus a search box, **Reprint**, **Text again** (which can fix a mistyped number) and **Void** (removes the numbers from the drawing; a card sale taken through Stripe is refunded automatically, cash and checks you hand back). Set the price, bundles ("3 for 25, 10 for 75"), slip text and the text message under **/admin › Raffle › Selling at the event & texting numbers**. **Download sales CSV** gives you the reconciliation, including check numbers and Stripe payment IDs.

**Buyer lookup.** Under **/admin › Raffle › Buyer lookup**, click **Pull contacts from Givebutter** a day or two before and again on race morning. The Sell page downloads the list once and searches it in the browser, so it stays instant even if Givebutter is slow. Buyers picked from Givebutter keep their contact ID, so the transaction lands on the right person later.

**Card payments (Stripe Reader M2).** The M2 is a Bluetooth reader that only works through a phone app, so the laptop and the iPhone work as a pair through the website:
- Add `STRIPE_SECRET_KEY` in Netlify and redeploy. The server creates a Stripe Terminal location for the race automatically (or set `STRIPE_TERMINAL_LOCATION=tml_…` to use one of yours).
- Install **SRS Card Terminal** on each iPhone from TestFlight (build steps in `terminal-app/README.md`), enter the site address, the staff password and a name like "Table 1", and connect the M2. Keep the app open on the table.
- With two tables, choose **Cards go to** on each laptop so its charges go to its own iPhone. Otherwise the first free terminal takes the charge.
- The website never sees card details, and a sale is only created after the server checks with Stripe that the payment succeeded, so a phone can't fake an approval. If the phone loses signal right after the tap, the laptop asks Stripe itself after a few seconds.
- Practice with a `sk_test_…` key and the app's **Simulated reader** switch, then put the live key in Netlify for the event. Test mode shows on both the Sell page and the app.

**Receipt printer (Star TSP100).** The TSP100 family (TSP143) prints on 80 mm paper, 72 mm wide, which is what the slip is designed for. A USB model (TSP143IIIU, TSP143IIU or TSP143IV) is the simplest to use with a laptop: install Star's macOS (CUPS) driver for that model, set the paper to **80 mm × receipt**, set it as the default printer, and turn on the driver's auto-cut after each page. To print with no dialog, start Chrome with `--kiosk-printing` (Mac: `open -a "Google Chrome" --args --kiosk-printing`). The slip sizes its own page to its contents. When buying used, check the label for the exact model and that it's the 80 mm version, and look up the driver on Star's site before you pay.

**Selling from a phone (everything except printing).** The **SRS Card Terminal** app (version 1.1+) has three tabs: **Sell** (this same Sell page, sized for a phone), **Staff** (the /admin page: bids, raffle draw, settings) and **Card reader**. It signs the pages in with the staff password from its settings. On the phone's Sell tab, **Card** always goes to that phone's own M2; the reader bar at the top shows whether it's connected. Slips print on the laptop:

1. On the laptop with the USB TSP100, open **/print** (the print station) and sign in. Do the one-time **Set up silent printing** steps on that page, so slips print with no dialog.
2. Phones (and any Sell page with **Slips print on: the print station**) send each slip there. The phone shows "Slip sent to Laptop printer", and the Sell page header shows **Printer ●** when the station is open. If the station is closed, slips wait in the queue and print as soon as it opens. **Print again** and **Reprint** work the same way.
3. A laptop running /sell prints on itself by default, as before. Phones and tablets default to the print station.

Keep the /print window open and in front, with the laptop plugged in and sleep turned off.

### Sending sales to Givebutter (after the race)

Nothing goes to Givebutter during the event, so the line never waits on it. Afterwards, open **/admin › Raffle › Send sales to Givebutter**, pick the campaign (**Load campaigns**), and click **Send N sales to Givebutter**. Each sale becomes a transaction through the API's **Create a transaction** (`POST /v1/transactions`): the amount, method (cash, check or card), the sale time, the buyer's name/phone/email (and their Givebutter contact if they were looked up), and an internal note like "Raffle tickets 20260004–20260006 (3). Raffle ticket purchase, not a tax-deductible donation. Check #1042." Card sales note the card and the Stripe payment ID; the money itself settles in your Stripe account, not Givebutter.
- **Create a $1 test transaction** shows exactly where sales land; delete it afterwards.
- Sales that fail stay marked and are retried the next time you click. If Givebutter insists on an email for buyers who gave none, fill in **Email for buyers who don't give one**.
- Voided sales aren't sent. If a sale is voided after it was sent, its Givebutter note is rewritten to "VOIDED" (the API can't delete a transaction); the staff page counts these so you can delete them in Givebutter.
- Tick **Send each sale right away** if you ever want the old behavior.

### Texting ticket numbers (Twilio)

Add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_MESSAGING_SERVICE_SID` in Netlify. Use the Messaging Service attached to your approved 10DLC campaign; `TWILIO_FROM=+1…` works instead. Then redeploy. **Send test text** checks the setup.
- Sales on `/sell` are texted immediately (card sales once Stripe approves them).
- Givebutter buyers and runners are texted from the staff page with **Text ticket numbers now**. It groups every entry by phone number (one text per person, listing all their numbers), uses the phone on the Givebutter ticket or the runners' CSV *Phone/Mobile* column, and texts each number only once. Pull tickets again after more sales and click it again: only the new numbers go out.
- Failed texts (bad number, someone who replied STOP) show in **Show text log**. **Retry failed texts** puts them back in the queue.
- The message template must include `{numbers}`. Keep "Reply STOP to opt out" in it.

Rules: a winning entry leaves the pool, but the winner's other entries stay in, so one person can win more than one prize. Only ticket numbers appear on the raffle screen; names, emails and phones never leave the staff pages. **Download results CSV** gives you the winners with emails for follow-up. **Download all entries CSV** lists every entry number, which is handy for posting or for checking the pool.

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
MOCK_GIVEBUTTER=1 MOCK_TWILIO=1 MOCK_STRIPE=1 node scripts/local-server.mjs     # fake Givebutter, Twilio and Stripe
#   with MOCK_STRIPE, POST /__mock/stripe/approve {"pi":"pi_mock_1"} plays a customer tapping their card
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
public/sell.html, sell.js     volunteer ticket sales + 80 mm receipt slip
netlify/lib/sms.mjs           Twilio texting
netlify/functions/raffle.mjs  GET /api/raffle  (public raffle screen data, no emails)
netlify/lib/raffle.mjs        entries, draws, numbering, Givebutter ticket import
netlify/lib/sales.mjs         creating a sale (numbers, text, Givebutter transaction)
netlify/lib/lookup.mjs        Givebutter contacts copy for the Sell page lookup
netlify/lib/stripe.mjs        Stripe API client + card request queue
netlify/lib/cards.mjs         finishing/canceling card requests (checks Stripe before a sale)
netlify/functions/terminal.mjs POST /api/terminal (the iPhone card terminal app)
terminal-app/                 SRS Card Terminal iPhone app (Expo + Stripe Terminal, Stripe Reader M2)
scripts/local-server.mjs      local preview without Netlify
```

Never commit your API key or webhook secret. It belongs only in Netlify's environment variables (`.env` is git-ignored).
