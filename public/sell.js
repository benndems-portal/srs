/* Raffle sales at the event. Built for speed:
 *   1. type a phone number (or a last name) -> pick the person (Givebutter contacts + earlier buyers)
 *   2. pick a quantity -> Cash (F1), Check (F2) or Card (F3)
 *   Card sends the charge to the "SRS Card Terminal" iPhone app paired to a Stripe Reader M2;
 *   when Stripe approves it, the slip prints and the numbers are texted automatically.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt$ = (n) => "$" + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const digitsOf = (v) => { const d = String(v || "").replace(/\D/g, ""); return d.length === 11 && d[0] === "1" ? d.slice(1) : d; };
  const prettyPh = (d) => (d && d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d || "");
  const store = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
    del: (k) => { try { sessionStorage.removeItem(k); } catch {} },
  };
  const pref = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };
  // Identifies this laptop, so a new card charge replaces only this laptop's previous one.
  const station = pref.get("sellStation", "") || (() => { const v = "st-" + Math.random().toString(36).slice(2, 8); pref.set("sellStation", v); return v; })();

  let password = store.get("auctionPw") || "";
  let cfg = { price: 10, bundles: [] };
  let title = "Raffle";
  let prefix = "2026";
  let sales = [];
  let contacts = []; // { id, first, last, phone, email, key }
  let count = 1, amountTouched = false;
  let buyer = null; // { contactId, from }
  let lastSale = null;
  let busy = false;
  let card = null; // { id, timer, startedAt }
  let terminals = [];
  let stripeOn = false;

  async function api(action, params = {}) {
    const res = await fetch("/api/admin", { method: "POST", headers: { "content-type": "application/json", "x-admin-password": password }, body: JSON.stringify({ action, ...params }) });
    const body = await res.json().catch(() => ({ error: "Unexpected server response." }));
    if (res.status === 401) { signOut(); throw new Error(body.error); }
    if (!res.ok) throw new Error(body.error || "Request failed");
    return body;
  }
  const msg = (el, text, kind = "ok") => { $(el).innerHTML = text ? `<div class="msg ${kind}">${esc(text)}</div>` : ""; };

  /* ---------- Auth ---------- */
  function signOut() { password = ""; store.del("auctionPw"); $("appView").hidden = true; $("loginView").hidden = false; }
  $("loginForm").onsubmit = async (e) => {
    e.preventDefault();
    password = $("pw").value;
    try { await api("login"); store.set("auctionPw", password); start(); } catch (err) { msg("loginMsg", err.message, "err"); }
  };

  /* ---------- Load ---------- */
  async function load() {
    const r = await api("raffleSales");
    cfg = r.salesConfig || cfg;
    title = r.title || title;
    prefix = r.numbering?.prefix || prefix;
    sales = r.sales;
    stripeOn = !!r.stripe?.configured;
    $("hdr").textContent = `Sell raffle tickets · ${title}`;
    $("smsWarn").hidden = r.smsConfigured;
    const s = r.summary;
    $("totals").innerHTML = `<span><b>${s.tickets}</b> tickets</span><span><b>${s.sales}</b> sales</span><span>Cash <b>${fmt$(s.cash)}</b></span><span>Check <b>${fmt$(s.check || 0)}</b></span><span>Card <b>${fmt$(s.card)}</b></span>`;
    setTerminals(r.terminals || []);
    if (r.stripe?.configured && r.stripe.mode === "test") $("hdr").textContent += " · STRIPE TEST MODE";
    renderQty();
    renderSales();
  }

  async function loadContacts() {
    try {
      const r = await api("lookupIndex");
      contacts = r.rows.map(([id, first, last, phone, email]) => ({ id, first, last, phone, email, key: (last + " " + first).toLowerCase() }));
      $("lookupInfo").textContent = r.pulledAt ? `${contacts.length.toLocaleString()} Givebutter contacts` : "Givebutter contacts not loaded yet (staff page › Raffle)";
    } catch (e) { $("lookupInfo").textContent = "Couldn't load contacts: " + e.message; }
  }

  function setTerminals(list) {
    terminals = list;
    const el = $("termState");
    el.classList.toggle("none", !list.length);
    el.innerHTML = !stripeOn ? "" : list.length
      ? `Card: <b>●</b> ${list.map((t) => esc(t.name) + (t.battery != null ? ` ${Math.round(t.battery * 100)}%` : "") + (t.busy ? " (busy)" : "")).join(", ")}`
      : `Card: <b>●</b> no terminal app open`;
    const sel = $("optTerminal"), want = pref.get("sellTerminal", "");
    const ids = new Set(list.map((t) => t.id));
    sel.innerHTML = `<option value="">any card terminal</option>` + list.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("") + (want && !ids.has(want) ? `<option value="${esc(want)}">(saved terminal, offline)</option>` : "");
    sel.value = want;
  }
  $("optTerminal").onchange = (e) => pref.set("sellTerminal", e.target.value);

  /* ---------- Step 1: lookup ---------- */
  // Earlier buyers today, newest first, one per phone (or name if no phone).
  function earlierBuyers() {
    const seen = new Map();
    for (const x of sales) {
      if (x.voided) continue;
      const key = digitsOf(x.phone) || x.name.toLowerCase();
      if (!seen.has(key)) seen.set(key, { from: "sale", name: x.name, phone: digitsOf(x.phone), email: x.email || "", contactId: x.contactId || "", tickets: 0 });
      seen.get(key).tickets += x.count;
    }
    return [...seen.values()];
  }

  let results = [], sel = 0;
  function search() {
    const raw = $("q").value.trim();
    const q = raw.toLowerCase();
    const d = raw.replace(/\D/g, "");
    const isPhone = d.length >= 3 && /^[\d\s().+-]+$/.test(raw);
    let out = [];
    if (isPhone) {
      const dd = d.length === 11 && d[0] === "1" ? d.slice(1) : d;
      const hit = (ph) => ph && (ph.startsWith(dd) || (dd.length >= 4 && dd.length <= 7 && ph.endsWith(dd)));
      out = [...earlierBuyers().filter((b) => hit(b.phone)), ...contacts.filter((c) => hit(c.phone)).map(fromContact)];
    } else if (q.length >= 2) {
      const [a, b] = q.split(/[\s,]+/);
      const m = (c) => (b ? (c.last.toLowerCase().startsWith(a) && c.first.toLowerCase().startsWith(b)) || (c.first.toLowerCase().startsWith(a) && c.last.toLowerCase().startsWith(b)) : c.last.toLowerCase().startsWith(a));
      const eb = earlierBuyers().filter((x) => { const [f, ...l] = x.name.split(/\s+/); return m({ first: f || "", last: l.join(" ") }); });
      const cs = contacts.filter(m).sort((x, y) => x.key.localeCompare(y.key)).map(fromContact);
      out = [...eb, ...cs];
      // Nothing by last name? try first names too.
      if (!out.length && !b) out = contacts.filter((c) => c.first.toLowerCase().startsWith(a)).map(fromContact);
    }
    // Same person from a sale and from Givebutter: keep the sale row.
    const seen = new Set();
    results = out.filter((r) => { const k = (r.phone || "") + "|" + r.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 7);
    sel = 0;
    renderResults(raw, isPhone ? d : "");
  }
  const fromContact = (c) => ({ from: "gb", name: `${c.first} ${c.last}`.trim(), phone: c.phone, email: c.email, contactId: c.id });

  function renderResults(raw, phoneDigits) {
    if (!raw) { $("results").innerHTML = ""; return; }
    const newLabel = phoneDigits ? `New buyer with ${prettyPh(phoneDigits) || phoneDigits}` : `New buyer “${raw}”`;
    $("results").innerHTML = results.map((r, i) => `<li data-i="${i}" class="${i === sel ? "on" : ""}" role="option">
        <span class="rn">${esc(r.name)}</span>
        <span class="rp">${esc(prettyPh(r.phone))}</span>
        ${r.from === "sale" ? `<span class="rt">bought ${r.tickets} today</span>` : `<span class="rt gb">Givebutter</span>`}
      </li>`).join("") + `<li data-i="new" class="new${results.length === sel ? " on" : ""}"><span class="rn">+ ${esc(newLabel)}</span><span class="rp">Enter</span></li>`;
  }

  $("q").addEventListener("input", search);
  $("q").addEventListener("keydown", (e) => {
    const max = results.length; // index `max` = "new buyer"
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(max, sel + 1); renderResults($("q").value.trim(), digitsOf($("q").value)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); renderResults($("q").value.trim(), digitsOf($("q").value)); }
    else if (e.key === "Enter") { e.preventDefault(); if ($("q").value.trim()) choose(sel < max ? results[sel] : null); }
  });
  $("results").onclick = (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) choose(li.dataset.i === "new" ? null : results[+li.dataset.i]);
  };

  // r = a result row, or null for a new buyer (pre-filled from what was typed).
  function choose(r) {
    const raw = $("q").value.trim();
    const d = raw.replace(/\D/g, "");
    if (r) {
      buyer = { contactId: r.contactId || "", from: r.from };
      $("fName").value = r.name;
      $("fPhone").value = prettyPh(r.phone);
      $("fEmail").value = r.email || "";
      $("buyerFrom").textContent = r.from === "sale" ? `Bought ${r.tickets} earlier today` : r.contactId ? "From Givebutter" : "";
    } else {
      buyer = { contactId: "", from: "new" };
      const isPhone = d.length >= 3 && /^[\d\s().+-]+$/.test(raw);
      $("fName").value = isPhone ? "" : raw.replace(/\b\w/g, (c) => c.toUpperCase());
      $("fPhone").value = isPhone ? prettyPh(digitsOf(raw)) || raw : "";
      $("fEmail").value = "";
      $("buyerFrom").textContent = "New buyer";
    }
    $("emailWrap").hidden = !$("fEmail").value; $("addEmail").hidden = !!$("fEmail").value;
    $("q").parentElement.hidden = true;
    $("buyer").hidden = false;
    $("results").innerHTML = "";
    // Next field that still needs typing, else straight to the quantity/payment step.
    if (!$("fName").value) $("fName").focus();
    else if (!$("fPhone").value && !r) $("fPhone").focus();
    else focusPay();
  }
  function focusPay() { const b = $("qty").querySelector(".on") || $("qty").firstElementChild; b?.focus(); }
  function clearBuyer() {
    buyer = null;
    $("buyer").hidden = true;
    $("q").parentElement.hidden = false;
    $("q").value = ""; $("results").innerHTML = "";
    $("fName").value = $("fPhone").value = $("fEmail").value = "";
    $("q").focus();
  }
  $("changeBuyer").onclick = (e) => { e.preventDefault(); clearBuyer(); };
  $("addEmail").onclick = (e) => { e.preventDefault(); $("emailWrap").hidden = false; $("addEmail").hidden = true; $("fEmail").focus(); };
  for (const id of ["fName", "fPhone", "fEmail"]) $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); focusPay(); } });

  /* ---------- Step 2: quantity + price ---------- */
  const priceFor = (n) => {
    const b = (cfg.bundles || []).find((x) => x.count === n);
    return b ? b.price : Math.round(n * (Number(cfg.price) || 0) * 100) / 100;
  };
  function renderQty() {
    const opts = [1, ...(cfg.bundles || []).map((b) => b.count)].filter((v, i, a) => a.indexOf(v) === i);
    const focused = document.activeElement?.dataset?.n;
    $("qty").innerHTML = opts.map((n) => `<button type="button" data-n="${n}" class="${n === count ? "on" : ""}"><b>${n}</b><small>${fmt$(priceFor(n))}</small></button>`).join("");
    if (focused) $("qty").querySelector(`[data-n="${focused}"]`)?.focus();
    if (!amountTouched) $("fAmount").value = priceFor(count);
  }
  function setCount(n) { count = Math.max(1, Math.min(500, Math.floor(n) || 1)); amountTouched = false; renderQty(); }
  $("qty").onclick = (e) => { const b = e.target.closest("[data-n]"); if (b) { $("fCount").value = ""; setCount(+b.dataset.n); b.focus(); } };
  $("qty").addEventListener("keydown", (e) => {
    const bs = [...$("qty").children], i = bs.indexOf(document.activeElement);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); const j = Math.max(0, Math.min(bs.length - 1, i + (e.key === "ArrowRight" ? 1 : -1))); bs[j].click(); }
  });
  $("fCount").oninput = (e) => { if (e.target.value) setCount(+e.target.value); };
  $("fAmount").oninput = () => { amountTouched = true; };

  /* ---------- Payment ---------- */
  function draft(payment) {
    return { name: $("fName").value.trim(), phone: $("fPhone").value, email: $("fEmail").value, count, amount: $("fAmount").value, payment, contactId: buyer?.contactId || "", station };
  }
  function ready() {
    if (!buyer && !$("fName").value.trim()) {
      // Allow typing a name straight into the search box and paying.
      if ($("q").value.trim()) choose(null);
      msg("saleMsg", "Pick the buyer first (type their phone or last name).", "err");
      $("q").parentElement.hidden ? $("fName").focus() : $("q").focus();
      return false;
    }
    if (!$("fName").value.trim()) { msg("saleMsg", "Enter the buyer's name.", "err"); $("fName").focus(); return false; }
    return true;
  }

  $("pay").onclick = (e) => {
    const b = e.target.closest("[data-pay]");
    if (b) pay(b.dataset.pay);
  };
  function pay(kind) {
    if (busy || card) return;
    msg("saleMsg", "");
    if (!ready()) return;
    if (kind === "cash") return sell("cash");
    if (kind === "check") { $("checkRow").hidden = false; $("fCheck").value = ""; $("fCheck").focus(); return; }
    if (kind === "card") return startCard();
  }
  $("checkGo").onclick = () => sell("check", { checkNo: $("fCheck").value.trim() });
  $("checkBack").onclick = () => { $("checkRow").hidden = true; focusPay(); };
  $("fCheck").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("checkGo").click(); } if (e.key === "Escape") $("checkBack").click(); });
  $("manualCard").onclick = (e) => {
    e.preventDefault();
    if (!ready()) return;
    if (confirm(`Record a ${fmt$($("fAmount").value)} card payment that was already charged some other way (for example Tap to Pay in the Stripe app)?\n\nOnly do this if the card really was charged.`)) sell("card");
  };

  addEventListener("keydown", (e) => {
    if (!$("appView").hidden && ["F1", "F2", "F3"].includes(e.key)) {
      e.preventDefault();
      if (!$("done").hidden) return;
      pay({ F1: "cash", F2: "check", F3: "card" }[e.key]);
    }
    if (e.key === "Escape" && !card && $("done").hidden && !$("buyer").hidden && document.activeElement !== $("fCheck")) clearBuyer();
  });

  async function sell(payment, extra = {}) {
    busy = true; setPayDisabled(true);
    try {
      const r = await api("raffleSell", { ...draft(payment), ...extra });
      finished(r.sale);
    } catch (err) { msg("saleMsg", err.message, "err"); }
    finally { busy = false; setPayDisabled(false); }
  }
  const setPayDisabled = (v) => { for (const b of $("pay").children) b.disabled = v; $("checkGo").disabled = v; };

  /* ---------- Card on the iPhone terminal ---------- */
  async function startCard() {
    if (!stripeOn) { msg("saleMsg", "Card payments aren't set up yet (STRIPE_SECRET_KEY in Netlify). Use “Card charged another way…” for now.", "err"); return; }
    busy = true; setPayDisabled(true);
    try {
      const r = await api("cardStart", { ...draft("card"), terminal: $("optTerminal").value });
      setTerminals(r.terminals || terminals);
      card = { id: r.request.id, startedAt: Date.now() };
      $("payCard").hidden = true;
      $("cardWait").hidden = false;
      $("cardWait").classList.remove("declined");
      $("wAmount").textContent = fmt$(r.request.amount);
      showCardStage(r.request);
      pollCard();
    } catch (err) { msg("saleMsg", err.message, "err"); }
    finally { busy = false; setPayDisabled(false); }
  }

  function showCardStage(req) {
    const who = req.terminalName || "the card terminal";
    let m = "Waiting for a card terminal to pick it up…", sub = terminals.length ? "" : "No card terminal app is open right now. Open SRS Card Terminal on the iPhone with the reader.";
    if (req.status === "processing") {
      m = req.stage === "processing" ? "Approving…" : req.stage === "declined" ? `Declined: ${req.stageMessage || "try another card"}` : `Tap, insert or swipe on ${who}`;
      sub = req.stage === "declined" ? `${who} is ready for another card, or cancel.` : "";
    }
    $("cardWait").classList.toggle("declined", req.stage === "declined");
    $("wMsg").textContent = m;
    $("wSub").textContent = sub;
  }

  async function pollCard() {
    if (!card) return;
    const id = card.id;
    try {
      const r = await api("cardStatus", { id, check: Date.now() - card.startedAt > 5000 });
      if (!card || card.id !== id) return;
      if (r.terminals) setTerminals(r.terminals);
      const req = r.request;
      if (req.status === "succeeded" && r.sale) { endCard(); finished(r.sale); return; }
      if (["canceled", "failed", "expired"].includes(req.status)) {
        endCard();
        msg("saleMsg", req.status === "expired" ? "No card terminal picked up the charge, so it was dropped. Try again." : `Card payment ${req.status}${req.error ? ": " + req.error : ""}. No sale was made.`, req.status === "canceled" ? "warn" : "err");
        focusPay();
        return;
      }
      showCardStage(req);
    } catch (err) { $("wSub").textContent = "Checking… " + err.message; }
    card && (card.timer = setTimeout(pollCard, 1000));
  }
  function endCard() {
    if (card?.timer) clearTimeout(card.timer);
    card = null;
    $("cardWait").hidden = true;
    $("payCard").hidden = false;
  }
  $("wCancel").onclick = async () => {
    if (!card) return;
    const id = card.id;
    $("wCancel").disabled = true;
    try {
      const r = await api("cardCancel", { id });
      endCard();
      if (r.request.status === "succeeded" && r.sale) { finished(r.sale); alert("That card had already been approved, so the sale went through."); }
      else msg("saleMsg", "Card payment canceled. No sale was made.", "warn");
    } catch (err) { alert(err.message); }
    finally { $("wCancel").disabled = false; }
  };

  /* ---------- Done ---------- */
  function finished(sale) {
    lastSale = sale;
    $("checkRow").hidden = true;
    $("findCard").hidden = true; $("payCard").hidden = true;
    $("done").hidden = false;
    $("dWho").textContent = `${sale.name} · ${sale.count} ticket${sale.count === 1 ? "" : "s"} · ${fmt$(sale.amount)} ${payLabel(sale)}`;
    $("dNums").innerHTML = sale.numbers.map((n) => `<span>${numHTML(n)}</span>`).join("");
    $("dSms").innerHTML = smsLine(sale);
    if ($("optPrint").checked) printSlip(sale);
    $("dNew").focus();
    load().catch(() => {});
  }
  const payLabel = (x) => x.payment === "check" ? `check${x.checkNo ? " #" + x.checkNo : ""}` : x.payment === "card" && x.stripe?.last4 ? `${x.stripe.brand ? x.stripe.brand[0].toUpperCase() + x.stripe.brand.slice(1) : "card"} …${x.stripe.last4}` : x.payment;
  // 20260427 -> 2026<b>0427</b> so the part that matters stands out.
  const numHTML = (n) => (n.length === prefix.length + 4 && n.startsWith(prefix) ? `${esc(prefix)}<b>${esc(n.slice(prefix.length))}</b>` : esc(n));

  function smsLine(sale) {
    const st = sale.sms?.status;
    if (st === "sent") return `<div class="msg ok">Texted to ${esc(sale.phonePretty)}</div>`;
    if (st === "none" || !sale.phone) return `<div class="msg warn">No phone, so no text was sent. Make sure they keep the slip.</div>`;
    if (st === "not-configured") return `<div class="msg warn">Texting isn't set up, so give them the slip.</div>`;
    return `<div class="msg err">Text failed: ${esc(sale.sms?.error || "unknown error")}. Check the number and use “Text again”.</div>`;
  }

  function newSale() {
    $("done").hidden = true;
    $("findCard").hidden = false; $("payCard").hidden = false;
    $("emailWrap").hidden = true; $("addEmail").hidden = false;
    msg("saleMsg", "");
    count = 1; amountTouched = false; $("fCount").value = ""; renderQty();
    clearBuyer();
  }
  $("dNew").onclick = newSale;
  $("dPrint").onclick = () => lastSale && printSlip(lastSale);
  addEventListener("keydown", (e) => { if (e.key === "Enter" && !$("done").hidden && document.activeElement?.tagName !== "INPUT") { e.preventDefault(); newSale(); } });
  $("optPrint").checked = pref.get("sellAutoPrint", "1") === "1";
  $("optPrint").onchange = (e) => pref.set("sellAutoPrint", e.target.checked ? "1" : "0");

  /* ---------- Slip (80 mm paper; Star TSP100 prints 72 mm wide) ---------- */
  function printSlip(sale) {
    const when = new Date(sale.at);
    const one = sale.numbers.length === 1;
    $("slip").innerHTML = `
      <div class="ev">${esc(title)}</div>
      <div class="banner">RAFFLE TICKET${one ? "" : "S"}</div>
      <div class="meta"><span>${when.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</span><span>${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></div>
      <div class="name">${esc(sale.name)}</div>
      <div class="count">${sale.count} ticket${one ? "" : "s"} · ${fmt$(sale.amount)} ${esc(payLabel(sale))}</div>
      <div class="nums${one ? " one" : ""}">${sale.numbers.map((n) => `<span>${numHTML(n)}</span>`).join("")}</div>
      ${cfg.drawingInfo ? `<div class="info">${esc(cfg.drawingInfo)}</div>` : ""}
      ${cfg.slipFooter ? `<div class="foot">${esc(cfg.slipFooter)}</div>` : ""}
      ${sale.phone && sale.sms?.status === "sent" ? `<div class="ref">Numbers also texted to ${esc(sale.phonePretty)}</div>` : ""}
      <div class="ref">Raffle ticket purchase · not tax-deductible</div>
      <div class="cut">✂ - - - - - - - - - - - - - - -</div>`;
    // Size the page to the slip so the receipt printer doesn't feed blank paper.
    let st = document.getElementById("slipPage");
    if (!st) { st = document.createElement("style"); st.id = "slipPage"; document.head.appendChild(st); }
    const slip = $("slip");
    slip.style.cssText = "display:block;position:absolute;left:-9999px;width:72mm";
    const mm = Math.ceil(slip.getBoundingClientRect().height / (96 / 25.4)) + 12;
    slip.style.cssText = "";
    st.textContent = `@media print { @page { size: 80mm ${mm}mm; margin: 0; } }`;
    setTimeout(() => window.print(), 50);
  }

  /* ---------- Recent sales ---------- */
  function renderSales() {
    const q = $("find").value.trim().toLowerCase();
    const digits = q.replace(/\D/g, "");
    const list = sales.filter((x) => !q || x.name.toLowerCase().includes(q) || (digits.length >= 3 && (x.phone || "").includes(digits)) || x.numbers.some((n) => n.toLowerCase() === q || (digits.length === 4 && n.endsWith(digits)))).slice(0, 40);
    $("sales").innerHTML = list.map((x) => `<li class="${x.voided ? "void" : ""}" data-id="${x.id}">
        <div class="top"><span class="nm">${esc(x.name)}</span><span class="pill ${x.payment}">${esc(payLabel(x))}</span><span class="amt">${fmt$(x.amount)}</span></div>
        <div class="nums">${x.numbers.map(numHTML).join(", ")}</div>
        <div class="acts">
          <span class="dim">${new Date(x.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${x.phonePretty ? " · " + esc(x.phonePretty) : ""}</span>
          ${x.voided ? `<span class="pill failed">voided${x.stripe?.refunded ? " · refunded" : ""}</span>` : `<span class="pill ${esc(x.sms?.status || "")}">${x.sms?.status === "sent" ? "texted" : x.sms?.status === "none" ? "no phone" : esc(x.sms?.status || "")}</span>`}
          ${x.gb ? `<span class="pill ${x.gb.status === "recorded" ? "sent" : "failed"}" title="${esc(x.gb.error || "")}">${x.gb.status === "recorded" ? "in GB" : "not in GB"}</span>` : ""}
          <span style="flex:1"></span>
          ${x.voided ? (x.stripe?.refunded ? "" : `<button class="btn ghost sm" data-restore>Restore</button>`) : `<button class="btn ghost sm" data-reprint>Reprint</button><button class="btn ghost sm" data-resend>Text again</button><button class="btn danger sm" data-void>Void</button>`}
        </div></li>`).join("") || `<li class="muted">No sales yet.</li>`;
  }
  $("find").oninput = renderSales;
  $("sales").onclick = async (e) => {
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    const sale = sales.find((x) => x.id === li.dataset.id);
    try {
      if (e.target.closest("[data-reprint]")) printSlip(sale);
      if (e.target.closest("[data-resend]")) {
        const phone = prompt("Text the ticket numbers to:", sale.phonePretty || "");
        if (phone == null) return;
        const r = await api("raffleResendSale", { id: sale.id, phone });
        alert(r.sale.sms?.status === "sent" ? `Texted to ${r.sale.phonePretty}.` : `Text failed: ${r.sale.sms?.error || "unknown error"}`);
        await load();
      }
      if (e.target.closest("[data-void]")) {
        const stripeSale = sale.payment === "card" && sale.stripe?.pi;
        if (!confirm(`Void ${sale.name}'s sale? Tickets ${sale.numbers.join(", ")} will be removed from the drawing.` + (stripeSale ? `\n\nThe ${fmt$(sale.amount)} card payment will be refunded through Stripe.` : `\n\nGive the ${sale.payment} back separately.`))) return;
        const r = await api("raffleVoidSale", { id: sale.id, refund: !!stripeSale });
        if (r.refund && !r.refund.ok) alert("Voided, but the Stripe refund failed: " + r.refund.error + "\nRefund it in the Stripe Dashboard.");
        else if (r.gbNote === "flagged") alert("Voided. The Givebutter transaction is marked VOIDED in its note. Delete it in Givebutter (the API can't delete it).");
        await load();
      }
      if (e.target.closest("[data-restore]")) { await api("raffleVoidSale", { id: sale.id, restore: true }); await load(); }
    } catch (err) { alert(err.message); }
  };

  async function start() {
    $("loginView").hidden = true;
    $("appView").hidden = false;
    await Promise.all([load(), loadContacts()]);
    $("q").focus();
  }
  setInterval(() => { if (password && !document.hidden && !card && $("find") !== document.activeElement) load().catch(() => {}); }, 15000);
  if (password) start().catch(() => signOut()); else signOut();
})();
