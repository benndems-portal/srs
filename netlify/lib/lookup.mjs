// Buyer lookup for /sell: a copy of the Givebutter contact list (name, phone, email) kept in
// Netlify Blobs, pulled from GET /v1/contacts before the event. The Sell page downloads the
// whole list once and searches it in the browser, so typing a phone number or last name is
// instant and keeps working if Givebutter is slow on race day.
//
// Stored compactly as rows: [id, first, last, phoneDigits, email]
import { gb } from "./givebutter.mjs";

const KEY = "lookup-contacts";
const PAGES_PER_CALL = 16; // keeps each request well inside Netlify's time limit

const digits = (v) => {
  const d = String(v || "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d.length === 10 ? d : "";
};

export function contactRow(c) {
  const phone = digits(c.primary_phone) || digits((c.phones || []).map((p) => p.value).find(digits));
  const email = String(c.primary_email || (c.emails || [])[0]?.value || "").trim().toLowerCase();
  const first = String(c.preferred_name || c.first_name || "").trim();
  const last = String(c.last_name || "").trim();
  if (!first && !last) return null;
  return [String(c.id), first, last, phone, email];
}

// Pulls up to PAGES_PER_CALL pages starting at fromPage. Page 1 starts a fresh list.
export async function pullContactsPage(s, fromPage = 1) {
  const firstRes = await gb(`/contacts?page=${fromPage}&per_page=100`);
  const last = Number(firstRes.meta?.last_page) || fromPage;
  const upTo = Math.min(last, fromPage + PAGES_PER_CALL - 1);
  const rest = [];
  for (let p = fromPage + 1; p <= upTo; p += 8) {
    const batch = [];
    for (let q = p; q < p + 8 && q <= upTo; q++) batch.push(gb(`/contacts?page=${q}&per_page=100`));
    rest.push(...(await Promise.all(batch)));
  }
  const rows = [firstRes, ...rest].flatMap((r) => r.data || []).filter((c) => !c.archived_at).map(contactRow).filter(Boolean);
  const cur = fromPage === 1 ? { rows: [] } : (await s.get(KEY + "-partial", { type: "json" })) || { rows: [] };
  cur.rows.push(...rows);
  const done = upTo >= last;
  if (done) {
    // Same person twice (e.g. duplicates in the CRM): keep one row per id.
    const byId = new Map(cur.rows.map((r) => [r[0], r]));
    await s.setJSON(KEY, { pulledAt: new Date().toISOString(), total: Number(firstRes.meta?.total) || byId.size, rows: [...byId.values()] });
    await s.delete(KEY + "-partial");
  } else {
    await s.setJSON(KEY + "-partial", cur);
  }
  return { done, nextPage: done ? null : upTo + 1, lastPage: last, loaded: cur.rows.length };
}

export async function getLookup(s) {
  return (await s.get(KEY, { type: "json" })) || { pulledAt: null, total: 0, rows: [] };
}
