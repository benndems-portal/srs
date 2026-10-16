/* Volunteer raffle sales: one form per sale, prints an 80 mm slip and texts the numbers. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt$ = (n) => "$" + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const store = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
    del: (k) => { try { sessionStorage.removeItem(k); } catch {} },
  };
  const pref = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };

  let password = store.get("auctionPw") || "";
  let cfg = { price: 10, bundles: [] };
  let title = "Raffle";
  let sales = [];
  let count = 1, payment = "cash", amountTouched = false;
  let lastSale = null;

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
    sales = r.sales;
    $("hdr").textContent = `Sell raffle tickets · ${title}`;
    $("smsWarn").hidden = r.smsConfigured;
    const s = r.summary;
    $("totals").innerHTML = `<span><b>${s.tickets}</b> tickets</span><span><b>${s.sales}</b> sales</span><span>Cash <b>${fmt$(s.cash)}</b></span><span>Card <b>${fmt$(s.card)}</b></span>`;
    renderQty();
    renderSales();
  }

  /* ---------- Quantity + price ---------- */
  const priceFor = (n) => {
    const b = (cfg.bundles || []).find((x) => x.count === n);
    return b ? b.price : Math.round(n * (Number(cfg.price) || 0) * 100) / 100;
  };
  function renderQty() {
    const opts = [1, ...(cfg.bundles || []).map((b) => b.count)].filter((v, i, a) => a.indexOf(v) === i);
    $("qty").innerHTML = opts.map((n) => `<button type="button" data-n="${n}" class="${n === count ? "on" : ""}"><b>${n}</b><small>${fmt$(priceFor(n))}</small></button>`).join("");
    if (!amountTouched) $("fAmount").value = priceFor(count);
  }
  function setCount(n) {
    count = Math.max(1, Math.min(500, Math.floor(n) || 1));
    amountTouched = false;
    renderQty();
  }
  $("qty").onclick = (e) => { const b = e.target.closest("[data-n]"); if (b) { $("fCount").value = ""; setCount(+b.dataset.n); } };
  $("fCount").oninput = (e) => { if (e.target.value) setCount(+e.target.value); };
  $("fAmount").oninput = () => { amountTouched = true; };
  $("pay").onclick = (e) => {
    const b = e.target.closest("[data-pay]");
    if (!b) return;
    payment = b.dataset.pay;
    for (const x of $("pay").children) x.classList.toggle("on", x === b);
    $("cardNote").hidden = payment !== "card";
  };
  $("addEmail").onclick = (e) => { e.preventDefault(); $("emailWrap").hidden = false; $("addEmail").hidden = true; $("fEmail").focus(); };
  $("optPrint").checked = pref.get("sellAutoPrint", "1") === "1";
  $("optPrint").onchange = (e) => pref.set("sellAutoPrint", e.target.checked ? "1" : "0");

  /* ---------- Sell ---------- */
  $("saleForm").onsubmit = async (e) => {
    e.preventDefault();
    msg("saleMsg", "");
    const btn = $("sellBtn");
    btn.disabled = true;
    btn.textContent = "Selling…";
    try {
      const r = await api("raffleSell", { name: $("fName").value, phone: $("fPhone").value, email: $("fEmail").value, count, payment, amount: $("fAmount").value });
      lastSale = r.sale;
      showDone(r.sale);
      if ($("optPrint").checked) printSlip(r.sale);
      load().catch(() => {});
    } catch (err) {
      msg("saleMsg", err.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Sell & print";
    }
  };

  function smsLine(sale) {
    const st = sale.sms?.status;
    if (st === "sent") return `<div class="msg ok">Texted to ${esc(sale.phonePretty)}</div>`;
    if (st === "none" || !sale.phone) return `<div class="msg warn">No phone, so no text was sent. Make sure they keep the slip.</div>`;
    if (st === "not-configured") return `<div class="msg warn">Texting isn't set up, so give them the slip.</div>`;
    return `<div class="msg err">Text failed: ${esc(sale.sms?.error || "unknown error")}. Check the number and use “Text again”.</div>`;
  }

  function showDone(sale) {
    $("saleForm").hidden = true;
    $("done").hidden = false;
    $("dWho").textContent = `${sale.name} · ${sale.count} ticket${sale.count === 1 ? "" : "s"} · ${fmt$(sale.amount)} ${sale.payment}`;
    $("dNums").innerHTML = sale.numbers.map((n) => `<span>${esc(n)}</span>`).join("");
    $("dSms").innerHTML = smsLine(sale);
    $("dNew").focus();
  }
  function newSale() {
    $("saleForm").reset();
    $("emailWrap").hidden = true; $("addEmail").hidden = false;
    $("optPrint").checked = pref.get("sellAutoPrint", "1") === "1";
    count = 1; amountTouched = false; renderQty();
    $("done").hidden = true; $("saleForm").hidden = false;
    $("fName").focus();
  }
  $("dNew").onclick = newSale;
  $("dPrint").onclick = () => lastSale && printSlip(lastSale);
  addEventListener("keydown", (e) => { if (e.key === "Enter" && !$("done").hidden && document.activeElement?.tagName !== "INPUT") { e.preventDefault(); newSale(); } });

  /* ---------- Slip ---------- */
  function printSlip(sale) {
    const when = new Date(sale.at);
    const one = sale.numbers.length === 1;
    $("slip").innerHTML = `
      <div class="ev">${esc(title)}</div>
      <div class="banner">RAFFLE TICKET${one ? "" : "S"}</div>
      <div class="meta"><span>${when.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</span><span>${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></div>
      <div class="name">${esc(sale.name)}</div>
      <div class="count">${sale.count} ticket${one ? "" : "s"} · ${fmt$(sale.amount)} ${esc(sale.payment)}</div>
      <div class="nums${one ? " one" : ""}">${sale.numbers.map((n) => `<span>${esc(n)}</span>`).join("")}</div>
      ${cfg.drawingInfo ? `<div class="info">${esc(cfg.drawingInfo)}</div>` : ""}
      ${cfg.slipFooter ? `<div class="foot">${esc(cfg.slipFooter)}</div>` : ""}
      ${sale.phone && sale.sms?.status === "sent" ? `<div class="ref">Numbers also texted to ${esc(sale.phonePretty)}</div>` : ""}
      <div class="cut">✂ - - - - - - - - - - - - - - -</div>`;
    // Size the page to the slip so receipt printers don't feed blank paper.
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
    const list = sales.filter((x) => !q || x.name.toLowerCase().includes(q) || (digits.length >= 3 && (x.phone || "").includes(digits)) || x.numbers.some((n) => n.toLowerCase() === q)).slice(0, 40);
    $("sales").innerHTML = list.map((x) => `<li class="${x.voided ? "void" : ""}" data-id="${x.id}">
        <div class="top"><span class="nm">${esc(x.name)}</span><span class="pill ${x.payment}">${x.payment}</span><span class="amt">${fmt$(x.amount)}</span></div>
        <div class="nums">${x.numbers.map(esc).join(", ")}</div>
        <div class="acts">
          <span class="dim">${new Date(x.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${x.phonePretty ? " · " + esc(x.phonePretty) : ""}</span>
          ${x.voided ? `<span class="pill failed">voided</span>` : `<span class="pill ${esc(x.sms?.status || "")}">${x.sms?.status === "sent" ? "texted" : x.sms?.status === "none" ? "no phone" : esc(x.sms?.status || "")}</span>`}
          <span style="flex:1"></span>
          ${x.voided ? `<button class="btn ghost sm" data-restore>Restore</button>` : `<button class="btn ghost sm" data-reprint>Reprint</button><button class="btn ghost sm" data-resend>Text again</button><button class="btn danger sm" data-void>Void</button>`}
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
        if (!confirm(`Void ${sale.name}'s sale? Tickets ${sale.numbers.join(", ")} will be removed from the drawing. Refund the money separately.`)) return;
        await api("raffleVoidSale", { id: sale.id });
        await load();
      }
      if (e.target.closest("[data-restore]")) { await api("raffleVoidSale", { id: sale.id, restore: true }); await load(); }
    } catch (err) { alert(err.message); }
  };

  async function start() {
    $("loginView").hidden = true;
    $("appView").hidden = false;
    await load();
    $("fName").focus();
  }
  setInterval(() => { if (password && !document.hidden && $("find") !== document.activeElement) load().catch(() => {}); }, 20000);
  if (password) start().catch(() => signOut()); else signOut();
})();
