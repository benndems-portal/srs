// GET /api/raffle — public snapshot for the raffle screen (no emails).
import { store, json } from "../lib/store.mjs";
import { getScreen } from "../lib/raffle.mjs";

export default async () => {
  try {
    const screen = await getScreen(store());
    return json({ serverTime: new Date().toISOString(), ...screen });
  } catch (e) {
    console.error(e);
    return json({ error: "Could not load raffle." }, 500);
  }
};

export const config = { path: "/api/raffle" };
