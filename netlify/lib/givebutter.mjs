// Givebutter public API (https://docs.givebutter.com). The API key stays
// server-side in the GIVEBUTTER_API_KEY environment variable.
//
// Note: Givebutter's public API has no auction/bid endpoints. We use it for
// campaign totals (raised, goal, supporters) and recent paid transactions
// (which include Buy Now purchases and auction items once winners pay).
import { HttpError } from "./store.mjs";

const BASE = "https://api.givebutter.com/v1";
const CACHE_KEY = "cache/givebutter";
const CACHE_MS = 60_000;

export async function gb(path) {
  const key = process.env.GIVEBUTTER_API_KEY;
  if (!key) throw new HttpError(500, "GIVEBUTTER_API_KEY is not set in Netlify environment variables.");
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(502, `Givebutter API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function listCampaigns() {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const r = await gb(`/campaigns?page=${page}`);
    for (const c of r.data || []) out.push({ id: String(c.id), title: c.title, type: c.type, status: c.status, raised: c.raised, goal: c.goal, url: c.url });
    if (!r.meta || r.meta.current_page >= r.meta.last_page) break;
  }
  return out;
}

async function fetchSummary(campaignId) {
  const c = (await gb(`/campaigns/${encodeURIComponent(campaignId)}`)).data || {};
  let recent = [];
  try {
    const t = await gb(`/transactions?sortByDesc=transacted_at`);
    recent = (t.data || [])
      .filter((x) => String(x.campaign_id) === String(campaignId) || (c.code && x.campaign_code === c.code))
      .filter((x) => !x.status || x.status === "succeeded")
      .slice(0, 10)
      .map((x) => ({
        name: x.first_name ? `${x.first_name} ${x.last_name ? x.last_name[0] + "." : ""}`.trim() : "A supporter",
        amount: x.amount,
        at: x.transacted_at || x.created_at,
        items: (x.line_items || []).map((li) => li.description).filter(Boolean).slice(0, 2),
      }));
  } catch {
    // Transactions are a nice-to-have; ignore failures.
  }
  return {
    title: c.title || "",
    raised: Number(c.raised) || 0,
    goal: c.goal ? Number(c.goal) : null,
    donors: Number(c.donors) || 0,
    url: c.url || "",
    recent,
  };
}

// Cached so many screens polling every few seconds make at most one
// Givebutter call per minute.
export async function givebutterSummary(s, settings) {
  if (!settings.showGivebutter || !settings.campaignId || !process.env.GIVEBUTTER_API_KEY) return null;
  const cached = await s.get(CACHE_KEY, { type: "json" });
  if (cached && cached.campaignId === settings.campaignId && Date.now() - cached.fetchedAt < CACHE_MS) return cached.data;
  try {
    const data = await fetchSummary(settings.campaignId);
    await s.setJSON(CACHE_KEY, { campaignId: settings.campaignId, fetchedAt: Date.now(), data });
    return data;
  } catch (e) {
    console.error("Givebutter fetch failed:", e.message);
    if (cached && cached.campaignId === settings.campaignId) {
      // Serve stale data and back off for a minute.
      await s.setJSON(CACHE_KEY, { ...cached, fetchedAt: Date.now() });
      return cached.data ? { ...cached.data, stale: true } : null;
    }
    await s.setJSON(CACHE_KEY, { campaignId: settings.campaignId, fetchedAt: Date.now(), data: null });
    return null;
  }
}
