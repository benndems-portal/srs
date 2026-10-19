# SRS Card Terminal (iPhone + Stripe Reader M2)

An iPhone app for running a raffle table from a phone: the **Sell** page, the **Staff** page and a Stripe Reader M2 for cards, in one app. Slips print on the laptop with the USB receipt printer, which keeps the website's **/print** page open (the print station).

A laptop can still ring up sales and send cards to this phone, as before: the app picks up the charge within a second, the buyer taps, inserts or swipes, and Stripe approves it.

The app only ever talks to your website (`/api/terminal`, with the staff password) and to Stripe through Stripe's own SDK. Card details never touch the website.

## One-time setup in Stripe

1. In the Stripe Dashboard, open **Terminal › Locations** and add a location with the race address. (If you skip this, the website creates a placeholder location the first time the app connects.)
2. Copy your **secret key** (Developers › API keys). Put the **test** key (`sk_test_…`) in Netlify as `STRIPE_SECRET_KEY` first, redeploy, and practice. Swap in the **live** key (`sk_live_…`) and redeploy before race day.

## Build it and put it on TestFlight

You need: a Mac with Node 20 or newer, your Apple Developer account, and a free Expo account (expo.dev). The build runs on Expo's servers, so you don't need Xcode.

```bash
cd terminal-app
npm install
npx eas-cli@latest login                     # your Expo account
npx eas-cli@latest init                      # links the project to your Expo account (answer yes)
npx eas-cli@latest build --platform ios --profile production
```

The build asks you to sign in to your Apple account and offers to create the bundle ID, certificate and provisioning profile. Say yes to each. It takes about 15 to 25 minutes. Then upload it to App Store Connect:

```bash
npx eas-cli@latest submit --platform ios --latest
```

The first time, it offers to create the app in App Store Connect. If it says the bundle identifier `com.legalconversioncenter.srscardterminal` is taken, change `ios.bundleIdentifier` in `app.json` to something else of yours and build again.

After Apple finishes processing (usually 10 to 30 minutes, you get an email):

1. In App Store Connect, open the app › **TestFlight**.
2. Under **Internal Testing**, create a group and add yourself and anyone else who will run a table. Internal testers must be users on your App Store Connect team (**Users and Access**); up to 100, and no App Review is needed.
3. On each iPhone, install Apple's **TestFlight** app, accept the invite, and install **SRS Card Terminal**.

TestFlight builds expire after 90 days, which is plenty for the race. For a new version, run the `build` and `submit` commands again (the build number goes up on its own). Version 1.1 added the Sell and Staff tabs and the `react-native-webview` package, so run `npm install` first.

## Using it

1. Charge the M2 the night before. The first connection to a new reader can install a software update that takes several minutes.
2. Open **SRS Card Terminal**. Enter the website address (e.g. `https://your-site.netlify.app`), the staff password, and a name such as "Table 1". Tap **Test connection**, then **Save**.
3. Allow Bluetooth and location when asked (Stripe requires location for card readers).
4. Press the M2's button until its lights blink. Tap it in the list to connect. Next time the app reconnects to the same reader on its own.
5. The bar at the top turns green (**● Card reader**). Leave the app open (it keeps the screen awake).
6. Sell on the **Sell** tab: type the phone number or last name, pick the quantity, then **Cash**, **Check** or **Card**. Card shows the amount full screen and lights up the M2; hand the reader to the buyer. If a card is declined, the phone offers **Try another card**, or **Cancel payment**.
7. The slip prints at the print station (/print on the laptop) and the buyer gets a text. The Sell page shows "Slip sent to Laptop printer".
8. The **Staff** tab is the full staff page (bids, raffle draw, settings). Pull down on either page to reload it.

Cash and check sales work even when the reader isn't connected.

**Practice without a reader:** with the test key in Netlify, turn on **Simulated reader** in the app's settings. It connects to a pretend M2 and approves charges with a test card.

**With two tables:** give each phone its own name, and on each laptop pick that phone under **Cards go to**.

## If something goes wrong

- **"Incorrect staff password"**: the password in the app must match `ADMIN_PASSWORD` in Netlify.
- **"Card payments aren't set up"**: `STRIPE_SECRET_KEY` is missing in Netlify, or the site wasn't redeployed after adding it.
- **The reader won't show up**: make sure Bluetooth is on, the M2 is charged and blinking, and it isn't still connected to another phone. Restart the reader by holding the button.
- **The phone lost signal mid-payment**: the laptop checks with Stripe on its own and finishes the sale if the card went through. Nothing is charged twice; each sale has exactly one Stripe payment.
- **Backup plan**: take the card with Tap to Pay in the Stripe Dashboard app on any iPhone, then use **Card charged another way…** on the Sell page.

## Files

- `App.tsx`: the whole app (settings, reader connection, polling the website, collecting payments)
- `app.json`: name, bundle ID, Bluetooth/location permission text, Stripe Terminal plugin
- `eas.json`: build and submit profiles for EAS
