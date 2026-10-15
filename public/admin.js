/* Staff admin: record bids, manage items, settings. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt$ = (n) => (n == null ? "—" : "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
  const STATUS = { nobids: "Open", leading: "Leading", hot: "Hot", closing: "Closing soon", won: "Won", sold: "Sold", unsold: "Unsold" };
  const ss = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
    del: (k) => { try { sessionStorage.removeItem(k); } catch {} },
  };

  let password = ss.get("auctionPw") || "";
  let state = null;
  let openItemId = null;

  async function api(action, params = {}) {
    const res = await fetch("/api/admin", {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-password": password },
      body: JSON.stringify({ action, ...params }),
    });
    const body = await res.json().catch(() => ({ error: "Unexpected server response." }));
    if (res.status === 401) { signOut(); throw new Error(body.error); }
    if (!res.ok) throw new Error(body.error || "Request failed");
    return body;
  }
  const msg = (el, text, ok = true) => { $(el).innerHTML = text ? `<div class="msg ${ok ? "ok" : "err"}">${esc(text)}</div>` : ""; };
  const toLocalInput = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

  /* ---------- Auth ---------- */
  function signOut() {
    password = "";
    ss.del("auctionPw");
    $("appView").hidden = true;
    $("loginView").hidden = false;
  }
  $("logout").onclick = signOut;
  $("loginForm").onsubmit = async (e) => {
    e.preventDefault();
    password = $("pw").value;
    try {
      await api("login");
      ss.set("auctionPw", password);
      start();
    } catch (err) {
      msg("loginMsg", err.message, false);
    }
  };

  /* ---------- Tabs ---------- */
  $("tabs").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    for (const x of $("tabs").children) x.classList.toggle("on", x === b);
    for (const t of ["bids", "items", "settings"]) $("tab-" + t).hidden = t !== b.dataset.tab;
  };

  /* ---------- Load + render ---------- */
  async function load() {
    state = await api("getState");
    $("hdrTitle").textContent = state.settings.title + " · Staff";
    renderStats();
    renderBidItems();
    renderItemTable();
  }

  function renderStats() {
    const s = state.summary;
    $("stats").innerHTML = [
      ["Total high bids", fmt$(s.totalHighBids)],
      ["Items with bids", `${s.itemsWithBids} / ${s.itemCount}`],
      ["Bids placed", s.totalBids],
      ["Closes", state.effectiveEndsAt ? new Date(state.effectiveEndsAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "Not set"],
    ].map(([k, v]) => `<div class="stat"><span>${k}</span><b>${esc(v)}</b></div>`).join("");
  }

  function renderBidItems() {
    const q = $("search").value.trim().toLowerCase();
    const list = state.items.filter((i) => !q || String(i.number).toLowerCase() === q || i.name.toLowerCase().includes(q) || String(i.number).toLowerCase().startsWith(q));
    $("bidItems").innerHTML = list.length ? list.map(bidItemHTML).join("") : `<div class="card muted">No items found. Add items on the Items tab.</div>`;
    if (openItemId) {
      const f = document.querySelector(`[data-id="${openItemId}"] input[name=amount]`);
      if (f && document.activeElement?.tagName !== "INPUT") f.focus();
    }
  }

  function bidItemHTML(it) {
    const sorted = [...it.bids].sort((a, b) => b.amount - a.amount || Date.parse(a.at) - Date.parse(b.at));
    const hb = sorted[0];
    const open = it.id === openItemId;
    const hist = sorted.slice(0, 15).map((b) =>
      `<li><span>${fmt$(b.amount)}</span><span class="grow">${esc(b.name || "")}${b.number ? ` <span class="dim">#${esc(b.number)}</span>` : ""}${b.source === "webhook" ? ` <span class="pill src">webhook</span>` : ""}</span><span class="dim">${new Date(b.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span><button class="btn danger sm" data-remove="${esc(b.id)}">Remove</button></li>`).join("");
    return `<div class="it ${open ? "open" : ""}" data-id="${it.id}">
      <div class="it-head" data-toggle>
        <div class="it-num">${it.number ? "#" + esc(it.number) : ""}</div>
        <div><div class="it-name">${esc(it.name)} <span class="pill ${it.status}">${STATUS[it.status]}</span></div>
          <div class="it-sub">${hb ? `Leader: <b style="color:var(--text)">${esc(hb.name || "Bidder #" + hb.number)}</b>${hb.number && hb.name ? " #" + esc(hb.number) : ""} · ` : ""}${it.bidCount} bid${it.bidCount === 1 ? "" : "s"} · next ${fmt$(it.nextMinimum)}+</div></div>
        <div class="it-amt">${hb ? fmt$(hb.amount) : "—"}<small>${hb ? "current" : "opens " + fmt$(it.startingBid)}</small></div>
      </div>
      <div class="it-body">
        <form class="bidform" data-bid>
          <div><label>Bid amount ($)</label><input name="amount" inputmode="decimal" required placeholder="${it.nextMinimum}"></div>
          <div><label>Bidder name</label><input name="name" autocomplete="off" placeholder="Sarah Ramsey"></div>
          <div><label>Bidder #</label><input name="number" autocomplete="off" placeholder="42"></div>
          <button class="btn">Record bid</button>
          <label style="grid-column:1/-1;display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" name="force"> Override minimum / closed check</label>
        </form>
        <div class="bidmsg"></div>
        ${hist ? `<ul class="hist">${hist}</ul>` : `<p class="dim">No bids yet.</p>`}
      </div>
    </div>`;
  }

  $("bidItems").addEventListener("click", async (e) => {
    const card = e.target.closest(".it");
    if (!card) return;
    if (e.target.closest("[data-toggle]")) {
      openItemId = openItemId === card.dataset.id ? null : card.dataset.id;
      renderBidItems();
      return;
    }
    const rm = e.target.closest("[data-remove]");
    if (rm) {
      if (!confirm("Remove this bid?")) return;
      try {
        await api("removeBid", { itemId: card.dataset.id, bidId: rm.dataset.remove });
        await load();
      } catch (err) { alert(err.message); }
    }
  });

  $("bidItems").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const card = form.closest(".it");
    const fd = new FormData(form);
    const btn = form.querySelector("button");
    btn.disabled = true;
    try {
      const r = await api("addBid", { itemId: card.dataset.id, amount: fd.get("amount"), name: fd.get("name"), number: fd.get("number"), force: fd.get("force") === "on" });
      await load();
      const m = document.querySelector(`[data-id="${card.dataset.id}"] .bidmsg`);
      if (m) m.innerHTML = `<div class="msg ok">Recorded ${fmt$(r.item.currentBid)} for ${esc(fd.get("name") || "#" + fd.get("number"))}.</div>`;
    } catch (err) {
      card.querySelector(".bidmsg").innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  });

  $("search").addEventListener("input", renderBidItems);
  $("search").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const first = document.querySelector("#bidItems .it");
    if (first) { openItemId = first.dataset.id; renderBidItems(); document.querySelector(`[data-id="${openItemId}"] input[name=amount]`)?.focus(); }
  });
  $("refresh").onclick = () => load().catch((e) => alert(e.message));

  /* ---------- Items tab ---------- */
  function renderItemTable() {
    $("itemTable").innerHTML = `<thead><tr><th>#</th><th>Name</th><th>Category</th><th class="r">Value</th><th class="r">Start</th><th class="r">Current</th><th>Status</th><th></th></tr></thead><tbody>${
      state.items.map((it) => `<tr><td>${esc(it.number)}</td><td>${esc(it.name)}</td><td class="dim">${esc(it.category)}</td><td class="r">${fmt$(it.value)}</td><td class="r">${fmt$(it.startingBid)}</td><td class="r">${fmt$(it.currentBid)}</td><td><span class="pill ${it.status}">${STATUS[it.status]}</span></td>
        <td class="r" style="white-space:nowrap"><button class="btn ghost sm" data-edit="${it.id}">Edit</button> <button class="btn danger sm" data-del="${it.id}">Delete</button></td></tr>`).join("") ||
      `<tr><td colspan="8" class="muted">No items yet.</td></tr>`
    }</tbody>`;
  }

  $("itemTable").addEventListener("click", async (e) => {
    const ed = e.target.closest("[data-edit]");
    const del = e.target.closest("[data-del]");
    if (ed) {
      const it = state.items.find((x) => x.id === ed.dataset.edit);
      const f = $("itemForm");
      for (const k of ["id", "number", "externalId", "name", "category", "value", "startingBid", "minIncrement", "buyNow", "image", "description", "status"]) f.elements[k].value = it[k] ?? "";
      f.elements.status.value = it.storedStatus || "open";
      f.elements.closesAt.value = toLocalInput(it.ownClosesAt);
      $("itemFormTitle").textContent = "Edit item";
      $("itemSave").textContent = "Save changes";
      $("itemCancel").hidden = false;
      f.scrollIntoView({ behavior: "smooth" });
    }
    if (del) {
      const it = state.items.find((x) => x.id === del.dataset.del);
      if (!confirm(`Delete “${it.name}”${it.bidCount ? ` and its ${it.bidCount} bids` : ""}?`)) return;
      await api("deleteItem", { id: it.id }).catch((er) => alert(er.message));
      load();
    }
  });

  function resetItemForm() {
    $("itemForm").reset();
    $("itemForm").elements.id.value = "";
    $("itemFormTitle").textContent = "Add an item";
    $("itemSave").textContent = "Add item";
    $("itemCancel").hidden = true;
  }
  $("itemCancel").onclick = resetItemForm;
  $("itemForm").onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const item = { ...fd, closesAt: fromLocalInput(fd.closesAt) };
    if (!item.id) delete item.id;
    try {
      await api("upsertItem", { item });
      msg("itemMsg", item.id ? "Item updated." : `Added “${item.name}”.`);
      resetItemForm();
      load();
    } catch (err) { msg("itemMsg", err.message, false); }
  };

  /* CSV import */
  let csvRows = [];
  function parseCSV(text) {
    const rows = [];
    let row = [], cell = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim()));
  }
  const COLS = {
    externalId: ["externalid", "givebutterid", "gbid", "webhookid", "id"],
    number: ["#", "number", "itemnumber", "itemno", "no", "lot", "lotnumber", "itemid", "sku"],
    name: ["name", "itemname", "title", "itemtitle", "item"],
    category: ["category", "categories", "itemcategory"],
    description: ["description", "details", "itemdescription"],
    value: ["value", "fairmarketvalue", "fmv", "retailvalue", "estimatedvalue", "marketvalue", "itemvalue"],
    startingBid: ["startingbid", "minimumbid", "openingbid", "startbid", "startingprice", "minbid", "startingamount"],
    minIncrement: ["increment", "bidincrement", "minincrement", "minimumincrement", "minimumbidincrement"],
    buyNow: ["buynow", "buynowprice", "buyitnow", "buyitnowprice"],
    image: ["image", "imageurl", "photo", "photourl", "picture", "images"],
  };
  function mapRows(rows) {
    const [hdr, ...data] = rows;
    const norm = hdr.map((h) => (h.trim() === "#" ? "#" : h.toLowerCase().replace(/[^a-z0-9]/g, "")));
    const idx = {};
    for (const [field, names] of Object.entries(COLS)) {
      const i = names.map((n) => norm.indexOf(n)).find((i) => i >= 0);
      if (i !== undefined) idx[field] = i;
    }
    return {
      found: Object.keys(idx),
      items: data.map((r) => Object.fromEntries(Object.entries(idx).map(([f, i]) => [f, (r[i] || "").trim()]))).filter((x) => x.name),
    };
  }
  $("csvFile").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const { found, items } = mapRows(parseCSV(await file.text()));
    csvRows = items;
    $("csvPreview").textContent = found.includes("name")
      ? `Found ${items.length} items. Columns matched: ${found.join(", ")}.`
      : "Couldn't find a Name column. Make sure the first row has headers like “Name”, “Starting bid”, “Value”.";
    $("csvImport").disabled = !found.includes("name") || !items.length;
  };
  $("csvImport").onclick = async () => {
    const mode = $("csvMode").value;
    if (mode === "replace" && !confirm("Replace ALL existing items (and their bids)?")) return;
    try {
      const r = await api("importItems", { items: csvRows, mode });
      msg("csvMsg", `Imported ${r.created} items.${r.errors.length ? " Skipped: " + r.errors.join("; ") : ""}`);
      load();
    } catch (err) { msg("csvMsg", err.message, false); }
  };

  /* ---------- Settings ---------- */
  function fillSettings() {
    const s = state.settings, f = $("settingsForm");
    for (const k of ["title", "subtitle", "bidUrl", "closedMessage", "rotateSeconds", "hotMinutes", "closingSoonMinutes", "gbAuctionId", "syncSeconds"]) f.elements[k].value = s[k] ?? "";
    f.elements.endsAt.value = toLocalInput(s.endsAt);
    f.elements.showGivebutter.checked = !!s.showGivebutter;
    const sel = $("campaignSel");
    if (s.campaignId && ![...sel.options].some((o) => o.value === s.campaignId)) sel.add(new Option(`Campaign ${s.campaignId}`, s.campaignId));
    sel.value = s.campaignId || "";
    $("gbKeyWarn").hidden = state.givebutterConfigured;
  }
  $("loadCampaigns").onclick = async () => {
    msg("gbMsg", "");
    try {
      const { campaigns } = await api("listCampaigns");
      const sel = $("campaignSel"), cur = sel.value;
      sel.innerHTML = `<option value="">— none —</option>` + campaigns.map((c) => `<option value="${esc(c.id)}">${esc(c.title)} (${esc(c.type || "")}, ${fmt$(c.raised)} raised)</option>`).join("");
      sel.value = cur;
      msg("gbMsg", `Loaded ${campaigns.length} campaigns.`);
    } catch (err) { msg("gbMsg", err.message, false); }
  };
  $("testGb").onclick = async () => {
    try {
      await saveSettings(true);
      const { givebutter: g } = await api("testGivebutter");
      msg("gbMsg", `Connected: “${g.title}” — ${fmt$(g.raised)} raised${g.goal ? " of " + fmt$(g.goal) : ""}, ${g.donors} supporters.`);
    } catch (err) { msg("gbMsg", err.message, false); }
  };
  async function saveSettings(quiet) {
    const f = $("settingsForm");
    const fd = Object.fromEntries(new FormData(f));
    const manual = $("campaignManual").value.trim();
    const settings = { ...fd, campaignId: manual || fd.campaignId || "", endsAt: fromLocalInput(fd.endsAt), showGivebutter: f.elements.showGivebutter.checked };
    await api("saveSettings", { settings });
    $("campaignManual").value = "";
    await load();
    fillSettings();
    if (!quiet) msg("settingsMsg", "Settings saved. The display updates within a few seconds.");
  }
  $("settingsForm").onsubmit = (e) => { e.preventDefault(); saveSettings().catch((err) => msg("settingsMsg", err.message, false)); };
  $("clearBids").onclick = async () => {
    try {
      const r = await api("clearAllBids", { confirm: $("clearConfirm").value.trim() });
      msg("clearMsg", `Cleared bids on ${r.cleared} items.`);
      load();
    } catch (err) { msg("clearMsg", err.message, false); }
  };

  /* ---------- Givebutter live sync ---------- */
  function showSync(m) {
    if (!m || !m.auctionId) { $("syncStatus").textContent = "Not connected yet."; return; }
    const when = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "never");
    $("syncStatus").innerHTML = `Auction ${esc(m.auctionId)} · last successful sync <b>${when(m.lastSuccess)}</b>${m.via ? " via " + esc(m.via) : ""}${m.items != null ? ` · ${m.items} items, ${m.withBids} with bids` : ""}` +
      (m.error ? `<div class="msg err">${esc(m.error)}</div>` : "");
  }
  async function loadSync() { showSync((await api("syncStatus")).sync); }
  $("syncNow").onclick = async () => {
    msg("syncMsg", "");
    try {
      await saveSettings(true);
      const { sync } = await api("syncNow");
      showSync(sync);
      await load();
      msg("syncMsg", `Synced ${sync.items} items from Givebutter (${sync.withBids} with bids).`);
    } catch (e) { msg("syncMsg", e.message, false); loadSync().catch(() => {}); }
  };
  $("tabs").addEventListener("click", (e) => { if (e.target.closest("[data-tab=settings]")) loadSync().catch(() => {}); });

  /* ---------- Webhooks ---------- */
  $("whUrl").value = location.origin + "/api/webhook";
  $("whCopy").onclick = () => { $("whUrl").select(); navigator.clipboard?.writeText($("whUrl").value).catch(() => {}); msg("whMsg", "Copied."); };
  async function loadWebhookLog() {
    const { log, secretConfigured } = await api("webhookLog");
    $("whSecretWarn").hidden = secretConfigured;
    $("whLog").innerHTML = `<thead><tr><th>Time</th><th>Event</th><th>Result</th><th>Detail</th></tr></thead><tbody>${
      log.map((e) => `<tr><td class="dim" style="white-space:nowrap">${new Date(e.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</td><td>${esc(e.event)}</td><td><span class="pill ${esc(e.result)}">${esc(e.result)}</span></td>
        <td>${esc(e.detail || "")}${e.payload ? `<details><summary class="dim">payload</summary><pre>${esc(pretty(e.payload))}</pre></details>` : ""}</td></tr>`).join("") ||
      `<tr><td colspan="4" class="muted">No webhook deliveries yet.</td></tr>`
    }</tbody>`;
  }
  const pretty = (p) => { try { return JSON.stringify(JSON.parse(p), null, 2); } catch { return p; } };
  $("whRefresh").onclick = () => loadWebhookLog().catch((e) => msg("whMsg", e.message, false));
  $("whTest").onclick = async () => {
    try {
      const r = await api("testWebhook");
      msg("whMsg", `Test bid ${r.result}: ${r.detail}. Check the display.`, r.result !== "error");
      await Promise.all([loadWebhookLog(), load()]);
    } catch (e) { msg("whMsg", e.message, false); }
  };
  $("tabs").addEventListener("click", (e) => { if (e.target.closest("[data-tab=settings]")) loadWebhookLog().catch(() => {}); });

  /* ---------- Start ---------- */
  async function start() {
    $("loginView").hidden = true;
    $("appView").hidden = false;
    await load();
    fillSettings();
  }
  // Auto-refresh bids list (skip while someone is typing).
  setInterval(() => {
    if (!password || $("appView").hidden) return;
    const typing = document.activeElement && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);
    const bidsTab = !$("tab-bids").hidden;
    if (bidsTab && !typing && !document.hidden) load().catch(() => {});
  }, 10000);

  if (password) start().catch(() => signOut());
  else signOut();
})();
