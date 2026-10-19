/* Builds and prints the raffle slip. Used by /sell (print on this computer) and /print (print station).
 * Needs <div id="slip"></div> on the page and /slip.css. */
window.SRSSlip = (() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt$ = (n) => "$" + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const payLabel = (x) => x.payment === "check" ? `check${x.checkNo ? " #" + x.checkNo : ""}` : x.payment === "card" && x.stripe?.last4 ? `${x.stripe.brand ? x.stripe.brand[0].toUpperCase() + x.stripe.brand.slice(1) : "card"} …${x.stripe.last4}` : x.payment;
  // 20260427 -> 2026<b>0427</b> so the part that matters stands out.
  const numHTML = (n, prefix) => (n.length === prefix.length + 4 && n.startsWith(prefix) ? `${esc(prefix)}<b>${esc(n.slice(prefix.length))}</b>` : esc(n));

  function html(sale, { title = "Raffle", prefix = "2026", cfg = {} } = {}) {
    const when = new Date(sale.at);
    const one = sale.numbers.length === 1;
    return `
      <div class="ev">${esc(title)}</div>
      <div class="banner">RAFFLE TICKET${one ? "" : "S"}</div>
      <div class="meta"><span>${when.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</span><span>${when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></div>
      <div class="name">${esc(sale.name)}</div>
      <div class="count">${sale.count} ticket${one ? "" : "s"} · ${fmt$(sale.amount)} ${esc(payLabel(sale))}</div>
      <div class="nums${one ? " one" : ""}">${sale.numbers.map((n) => `<span>${numHTML(n, prefix)}</span>`).join("")}</div>
      ${cfg.drawingInfo ? `<div class="info">${esc(cfg.drawingInfo)}</div>` : ""}
      ${cfg.slipFooter ? `<div class="foot">${esc(cfg.slipFooter)}</div>` : ""}
      ${sale.phone && sale.sms?.status === "sent" ? `<div class="ref">Numbers also texted to ${esc(sale.phonePretty)}</div>` : ""}
      <div class="ref">Raffle ticket purchase · not tax-deductible</div>
      <div class="cut">✂ - - - - - - - - - - - - - - -</div>`;
  }

  function testHTML(title) {
    return `<div class="ev">${esc(title || "Raffle")}</div><div class="banner">TEST PRINT</div>
      <div class="name" style="text-align:center">The print station works.</div>
      <div class="nums one"><span>2026<b>0000</b></span></div>
      <div class="ref">${esc(new Date().toLocaleString())}</div><div class="cut">✂ - - - - - - - - - - - - - - -</div>`;
  }

  // The page Chrome sends to the printer: 72 mm wide (what Star's driver calls "72mm x ..." paper).
  // It must always be taller than wide, or Chrome and macOS treat it as landscape and print it sideways.
  const PAGE_W = 72, MIN_H = 110;

  // Puts the slip on the page, sizes the paper to it (so the receipt printer doesn't feed lots of blank
  // paper), and opens the print. In Chrome window.print() blocks until the job is handed to the printer.
  function print(inner) {
    const slip = document.getElementById("slip");
    slip.innerHTML = inner;
    let st = document.getElementById("slipPage");
    if (!st) { st = document.createElement("style"); st.id = "slipPage"; document.head.appendChild(st); }
    slip.style.cssText = "display:block;position:absolute;left:-9999px;width:72mm";
    const mm = Math.max(MIN_H, Math.ceil(slip.getBoundingClientRect().height / (96 / 25.4)) + 12);
    slip.style.cssText = "";
    // margin: 0 also leaves Chrome no room for its date/title/URL headers and footers.
    st.textContent = `@media print { @page { size: ${PAGE_W}mm ${mm}mm; margin: 0; } html, body { width: ${PAGE_W}mm; margin: 0 !important; padding: 0 !important; } }`;
    return new Promise((resolve) => setTimeout(() => { window.print(); resolve(); }, 50));
  }

  return { PAGE_W, MIN_H, html, testHTML, print, payLabel, numHTML, esc, fmt$ };
})();
