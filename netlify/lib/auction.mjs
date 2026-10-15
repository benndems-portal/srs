// Pure helpers: item status, public masking, and the auction summary.

export const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Highest bid wins; on a tie, the earlier bid wins. (Webhooks can arrive out
// of order, so we never assume the last bid in the list is the highest.)
export function highBid(item) {
  let best = null;
  for (const b of item.bids || [])
    if (!best || b.amount > best.amount || (b.amount === best.amount && Date.parse(b.at) < Date.parse(best.at))) best = b;
  return best;
}

export function lastBidTime(item) {
  let t = 0;
  for (const b of item.bids || []) t = Math.max(t, Date.parse(b.at) || 0);
  return t;
}

export function nextMinimum(item) {
  const hb = highBid(item);
  const start = money(item.startingBid);
  const inc = money(item.minIncrement) || 0;
  if (item.gbMinimumBid) return money(item.gbMinimumBid); // Givebutter's own figure
  return hb ? money(hb.amount + (inc || 1)) : start;
}

// "Sarah Ramsey" -> "Sarah R."; falls back to bidder number.
export function displayName(bid) {
  if (!bid) return null;
  const parts = String(bid.name || "").trim().split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1] || "";
  if (parts.length >= 2 && /\p{L}/u.test(last[0])) return `${parts[0]} ${last[0].toUpperCase()}.`;
  if (parts.length >= 2) return parts.join(" ");
  if (parts.length === 1) return parts[0];
  if (bid.number) return `Bidder #${bid.number}`;
  return "Anonymous";
}

export function itemCloseTime(item, settings) {
  return item.closesAt || settings.endsAt || null;
}

export function itemStatus(item, settings, now = Date.now()) {
  const hb = highBid(item);
  if (item.status === "sold") return "sold";
  const close = itemCloseTime(item, settings);
  const closed = item.status === "closed" || (close && now >= Date.parse(close));
  if (closed) return hb ? "won" : "unsold";
  if (!hb) return "nobids";
  if (now - lastBidTime(item) < (settings.hotMinutes || 5) * 60000) return "hot";
  if (close && Date.parse(close) - now < (settings.closingSoonMinutes || 15) * 60000) return "closing";
  return "leading";
}

export function publicItem(item, settings, now = Date.now()) {
  const hb = highBid(item);
  return {
    id: item.id,
    number: item.number || "",
    name: item.name,
    description: item.description || "",
    category: item.category || "",
    image: item.image || "",
    value: money(item.value) || null,
    startingBid: money(item.startingBid),
    buyNow: money(item.buyNow) || null,
    buyNowOnly: !!item.buyNowOnly,
    remaining: item.remaining ?? null,
    soldPrice: item.soldPrice != null ? money(item.soldPrice) : null,
    soldTo: item.soldTo ? displayName({ name: item.soldTo }) : null,
    paid: !!item.paidAt,
    currentBid: hb ? money(hb.amount) : null,
    leader: displayName(hb),
    lastBidAt: hb ? hb.at : null,
    bidCount: Math.max(item.gbBidCount || 0, (item.bids || []).length),
    nextMinimum: nextMinimum(item),
    closesAt: itemCloseTime(item, settings),
    status: itemStatus(item, settings, now),
  };
}

export function recentBids(items, limit = 12) {
  const all = [];
  for (const it of items)
    for (const b of it.bids || [])
      all.push({ itemId: it.id, itemNumber: it.number || "", itemName: it.name, amount: money(b.amount), leader: displayName(b), at: b.at });
  return all.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.amount - a.amount).slice(0, limit);
}

export function summarize(pubItems) {
  const withBids = pubItems.filter((i) => i.currentBid != null);
  const totalHigh = money(withBids.reduce((s, i) => s + i.currentBid, 0));
  const totalValue = money(pubItems.reduce((s, i) => s + (i.value || 0), 0));
  const valueOfBidItems = money(withBids.reduce((s, i) => s + (i.value || 0), 0));
  const mostWanted = [...pubItems].filter((i) => i.bidCount > 0).sort((a, b) => b.bidCount - a.bidCount || b.currentBid - a.currentBid).slice(0, 3);
  const top = [...withBids].sort((a, b) => b.currentBid - a.currentBid)[0] || null;
  return {
    itemCount: pubItems.length,
    itemsWithBids: withBids.length,
    itemsWithoutBids: pubItems.length - withBids.length,
    totalBids: pubItems.reduce((s, i) => s + i.bidCount, 0),
    totalHighBids: totalHigh,
    totalValue,
    percentOfValue: valueOfBidItems ? Math.round((totalHigh / valueOfBidItems) * 100) : null,
    topItem: top ? { id: top.id, name: top.name, number: top.number, amount: top.currentBid } : null,
    mostWanted: mostWanted.map((i) => ({ id: i.id, name: i.name, number: i.number, bidCount: i.bidCount, currentBid: i.currentBid })),
  };
}
