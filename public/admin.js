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
    for (const t of ["bids", "items", "raffle", "settings"]) $("tab-" + t).hidden = t !== b.dataset.tab;
    // The top stat row is auction numbers; the Raffle tab has its own row.
    $("stats").hidden = b.dataset.tab === "raffle";
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

  /* ---------- Raffle ---------- */
  let raffle = null;
  let prizeDraft = null; // unsaved edits to the prize list
  let assignPick = ""; // prize picked in the "Prize they chose" box, kept across refreshes
  const normH = (h) => h.toLowerCase().replace(/[^a-z0-9#]/g, "");
  const findCol = (hdr, names) => { const n = hdr.map(normH); for (const x of names) { const i = n.indexOf(x); if (i >= 0) return i; } return -1; };
  const when = (t) => (t ? new Date(t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "");

  async function rApi(action, params, msgEl) {
    try {
      const r = await api(action, params);
      if (r.raffle) { raffle = r.raffle; renderRaffle(); }
      return r;
    } catch (e) {
      if (msgEl) msg(msgEl, e.message, false);
      throw e;
    }
  }
  const loadRaffle = () => rApi("raffleState").catch(() => {});

  function renderRaffle() {
    const r = raffle, p = r.pool;
    renderSalesCard();
    renderNumbering();
    renderGbRecord();
    $("rStats").innerHTML = [
      ["Entries in the pool", `${p.eligible.toLocaleString()}${p.eligible !== p.entries ? ` <small style="font-size:13px;color:var(--muted)">of ${p.entries.toLocaleString()}</small>` : ""}`],
      ["People", p.people.toLocaleString()],
      ["Givebutter entries", p.bySource.givebutter.toLocaleString()],
      ["Participant entries", p.bySource.participant.toLocaleString()],
      ["Sold at event", (p.bySource.sale || 0).toLocaleString()],
      ["Prizes drawn", `${r.draws.filter((d) => d.status === "won").length} / ${r.prizes.length}`],
    ].map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join("") +
      (p.duplicateNumbers.length ? `<div class="msg err" style="grid-column:1/-1">Duplicate entry numbers: ${esc(p.duplicateNumbers.join(", "))}. Check the ticket import.</div>` : "");

    $("rLive").checked = r.live;
    $("rMode").value = r.awardMode;
    // What to draw for: "winner chooses", or a specific prize (next undrawn prize first).
    const won = new Map(r.draws.filter((d) => d.status === "won" && d.prizeId).map((d) => [d.prizeId, d]));
    const sel = $("rPrizeSel"), cur = sel.value;
    const left = r.available.length;
    sel.innerHTML = r.prizes.length
      ? `<option value="choice">🎁 Winner chooses from the remaining prizes (${left} left)</option><optgroup label="Or draw for a specific prize">` +
        r.prizes.map((pz, i) => `<option value="${pz.id}" ${won.has(pz.id) ? "disabled" : ""}>${i + 1}. ${esc(pz.name)}${won.has(pz.id) ? " — " + esc(won.get(pz.id).name) : ""}</option>`).join("") + `</optgroup>`
      : `<option value="">Add prizes below first</option>`;
    const curOk = cur === "choice" ? left > 0 : r.prizes.some((x) => x.id === cur && !won.has(x.id));
    if (curOk && sel.dataset.mode === r.awardMode) sel.value = cur;
    else sel.value = r.awardMode === "choice" && left ? "choice" : r.next?.id || "";
    sel.dataset.mode = r.awardMode;
    $("rDraw").disabled = !r.next || !p.eligible || !!r.choosing;
    $("rDraw").title = r.choosing ? "Assign the current winner's prize first" : "";

    const last = r.draws.find((d) => d.id === r.current) || r.choosing || null;
    const choosing = last && last.status === "won" && last.choice && !last.prizeId;
    const availOpts = (keep) => r.prizes.filter((pz) => r.available.includes(pz.id) || pz.id === keep).map((pz) => `<option value="${pz.id}" ${pz.id === keep ? "selected" : ""}>${esc(pz.name)}</option>`).join("");
    const assignBox = last && last.status === "won" && last.choice
      ? `<div class="assign"><div><label>${choosing ? "Prize they chose" : "Change their prize"}</label><select id="rAssignSel">${choosing ? `<option value="">Pick from ${left} remaining…</option>` : ""}${availOpts(last.prizeId)}</select></div>
         <button class="btn ${choosing ? "" : "ghost"}" data-assign="${last.id}">${choosing ? "Assign prize" : "Change prize"}</button></div>`
      : "";
    $("rLast").innerHTML = last ? `<div class="winner${choosing ? " choosing" : ""}">
        <div class="dim">${choosing ? "<b style=\"color:var(--gold)\">Winner is choosing a prize</b>" : esc(last.prizeName) + (last.choice ? " (their choice)" : "")} · drawn ${new Date(last.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })} from ${last.poolSize} entries</div>
        <div class="wn">${esc(last.name)} <span class="wnum">${esc(last.number)}</span></div>
        <div class="dim">${esc(last.type || "")}${last.email ? " · " + esc(last.email) : ""}${last.phone ? " · " + esc(last.phone) : ""}</div>
        <div class="row" style="margin-top:10px">
          ${last.status === "won" ? `<button class="btn ghost sm" data-redraw="${last.id}">${last.choice ? "Winner not here: draw another ticket" : "Winner not here: redraw this prize"}</button>` : `<span class="pill error">forfeited</span>`}
          <button class="btn danger sm" data-undo="${last.id}">Undo (mistake)</button>
          ${choosing ? "" : `<button class="btn ghost sm" id="rIdle">Back to the waiting screen</button>`}
        </div>${assignBox}</div>` : "";
    if ($("rAssignSel") && assignPick && [...$("rAssignSel").options].some((o) => o.value === assignPick)) $("rAssignSel").value = assignPick;

    // Givebutter tickets
    $("rGbInfo").innerHTML = r.gb.count
      ? `${r.gb.count.toLocaleString()} tickets loaded ${r.gb.source === "csv" ? "from the CSV export" : "from Givebutter"} ${when(r.gb.pulledAt)}. Sample: ${r.gb.sample.map((t) => `<b style="color:var(--text)">${esc(t.number)}</b> ${esc(t.name)}`).join(", ")}`
      : "No Givebutter tickets loaded yet.";
    $("rTypes").innerHTML = r.types.length ? `<thead><tr><th>Ticket type</th><th class="r">Sold</th><th class="r">Raffle entries per ticket</th></tr></thead><tbody>${
      r.types.map((t) => `<tr><td>${esc(t.type)}</td><td class="r">${t.count}</td><td class="r"><input class="n" type="number" min="0" max="20" value="${t.entries}" data-type="${esc(t.type)}"></td></tr>`).join("")
    }</tbody>` : "";

    $("rPartInfo").innerHTML = r.participants.count
      ? `${r.participants.count} runners loaded ${when(r.participants.loadedAt)}, ${r.participants.each} entries each. First few: ${r.participants.sample.map((x) => esc(x.name)).join(", ")}. <a href="#" id="rPartClear" style="color:var(--red)">Remove all</a>`
      : "No participants loaded yet.";

    $("rManual").innerHTML = r.manual.length ? `<thead><tr><th>Name</th><th class="r">Entries</th><th>Added</th><th></th></tr></thead><tbody>${
      r.manual.map((m) => `<tr><td>${esc(m.name)}${m.email ? ` <span class="dim">${esc(m.email)}</span>` : ""}</td><td class="r">${m.count}</td><td class="dim">${when(m.at)}</td><td class="r"><button class="btn danger sm" data-rmman="${m.id}">Remove</button></td></tr>`).join("")
    }</tbody>` : "";

    if (!prizeDraft) { $("rTitle").value = r.title; renderPrizeRows(r.prizes); }

    $("rResults").innerHTML = `<thead><tr><th>Time</th><th>Prize</th><th>Entry</th><th>Name</th><th>Status</th><th></th></tr></thead><tbody>${
      r.draws.slice().reverse().map((d) => `<tr><td class="dim" style="white-space:nowrap">${new Date(d.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</td><td>${d.prizeName ? esc(d.prizeName) + (d.choice ? ' <span class="dim">(chosen)</span>' : "") : `<span class="dim">${d.status === "won" ? "choosing…" : "—"}</span>`}</td><td><b>${esc(d.number)}</b></td><td>${esc(d.name)}${d.email ? `<div class="dim">${esc(d.email)}</div>` : ""}</td><td><span class="pill ${d.status === "won" ? "won" : "error"}">${d.status === "won" ? "Winner" : "Not present"}</span></td><td class="r"><button class="btn danger sm" data-undo="${d.id}">Undo</button></td></tr>`).join("") ||
      `<tr><td colspan="6" class="muted">No draws yet.</td></tr>`
    }</tbody>`;
  }

  /* Prize editor */
  function renderPrizeRows(list) {
    $("rPrizes").innerHTML = list.map((p, i) => `<div class="prow" data-id="${esc(p.id || "")}">
      <div class="pn">${i + 1}</div>
      <input data-f="name" value="${esc(p.name)}" placeholder="Prize name *">
      <input class="opt" data-f="detail" value="${esc(p.detail || "")}" placeholder="Donated by… (optional)">
      <div class="opt pimg">
        <button type="button" class="pthumb" data-upimg="${i}" title="Upload a photo"${p.image ? ` style="background-image:url('${esc(encodeURI(p.image))}')"` : ""}>${p.image ? "" : "📷"}</button>
        <button type="button" class="btn ghost sm" data-upimg="${i}">${p.image ? "Change photo" : "Upload photo"}</button>
        ${p.image ? `<button type="button" class="btn ghost sm" data-noimg="${i}" title="Remove photo">✕</button>` : ""}
        <input type="hidden" data-f="image" value="${esc(p.image || "")}">
      </div>
      <div style="white-space:nowrap"><button class="btn ghost sm" data-up="${i}" title="Move up">↑</button> <button class="btn danger sm" data-rm="${i}" title="Remove">✕</button></div>
    </div>`).join("") || `<p class="dim">No prizes yet.</p>`;
  }
  const readPrizeRows = () => [...document.querySelectorAll("#rPrizes .prow")].map((row) => ({
    id: row.dataset.id || undefined,
    name: row.querySelector("[data-f=name]").value.trim(),
    detail: row.querySelector("[data-f=detail]").value.trim(),
    image: row.querySelector("[data-f=image]").value.trim(),
  }));
  $("rPrizes").addEventListener("input", () => { prizeDraft = true; });

  // Prize photos: pick a file, shrink it in the browser (longest side 1200 px), upload, save the /img/… URL.
  const imgPick = Object.assign(document.createElement("input"), { type: "file", accept: "image/*" });
  let imgRow = -1;
  async function shrinkImage(file) {
    const url = URL.createObjectURL(file);
    try {
      const im = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("decode")); i.src = url; });
      const k = Math.min(1, 1200 / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
      c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
      // PNGs keep transparency (logos); photos become JPEG.
      return file.type === "image/png" ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.85);
    } finally { URL.revokeObjectURL(url); }
  }
  imgPick.onchange = async () => {
    const file = imgPick.files[0]; imgPick.value = "";
    if (!file || imgRow < 0) return;
    const i = imgRow;
    msg("rPrizeMsg", "Uploading photo…");
    let dataUrl;
    try { dataUrl = await shrinkImage(file); }
    catch { return msg("rPrizeMsg", "Couldn't read that image. Use a JPG or PNG (on a Mac, iPhone HEIC photos can be exported as JPG from Photos).", false); }
    try {
      const r = await rApi("raffleUploadImage", { dataUrl }, "rPrizeMsg");
      const rows = readPrizeRows();
      if (!rows[i]) return;
      rows[i].image = r.url; prizeDraft = true; renderPrizeRows(rows);
      msg("rPrizeMsg", "Photo added. Click Save prizes to keep it.");
    } catch {}
  };
  $("rTitle").addEventListener("input", () => { prizeDraft = true; });
  $("rPrizes").addEventListener("click", (e) => {
    const rows = readPrizeRows();
    const up = e.target.closest("[data-up]"), rm = e.target.closest("[data-rm]");
    const pick = e.target.closest("[data-upimg]"), noimg = e.target.closest("[data-noimg]");
    if (pick) { imgRow = +pick.dataset.upimg; imgPick.click(); return; }
    if (noimg) rows[+noimg.dataset.noimg].image = "";
    else if (up) { const i = +up.dataset.up; if (i > 0) [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; }
    else if (rm) rows.splice(+rm.dataset.rm, 1);
    else return;
    prizeDraft = true;
    renderPrizeRows(rows);
  });
  $("rPrizeAdd").onclick = () => { const rows = readPrizeRows(); rows.push({ name: "" }); prizeDraft = true; renderPrizeRows(rows); document.querySelector("#rPrizes .prow:last-child input")?.focus(); };
  $("rPrizeSave").onclick = async () => {
    try {
      await rApi("raffleSavePrizes", { prizes: readPrizeRows().filter((p) => p.name), title: $("rTitle").value }, "rPrizeMsg");
      prizeDraft = null; renderRaffle();
      msg("rPrizeMsg", "Prizes saved.");
    } catch {}
  };

  /* Draw controls */
  $("rLast").addEventListener("change", (e) => { if (e.target.id === "rAssignSel") assignPick = e.target.value; });
  $("rMode").onchange = (e) => rApi("raffleAwardMode", { awardMode: e.target.value }, "rDrawMsg").catch(() => {});
  $("rLive").onchange = (e) => rApi("raffleLive", { live: e.target.checked }, "rDrawMsg").catch(() => {});
  $("rDraw").onclick = async () => {
    msg("rDrawMsg", "");
    if (prizeDraft) return msg("rDrawMsg", "Save your prize changes first.", false);
    $("rDraw").disabled = true;
    try {
      const r = await rApi("raffleDraw", { prizeId: $("rPrizeSel").value }, "rDrawMsg");
      msg("rDrawMsg", `Drawing on screen now… the reel lands on ${r.drawn.number} in about 8 seconds.${r.drawn.choice ? " Then pick the prize they choose below." : ""}`);
    } catch { renderRaffle(); }
  };
  document.getElementById("tab-raffle").addEventListener("click", async (e) => {
    const rd = e.target.closest("[data-redraw]"), un = e.target.closest("[data-undo]"), rm = e.target.closest("[data-rmman]");
    const as = e.target.closest("[data-assign]");
    if (as) {
      const prizeId = $("rAssignSel").value;
      if (!prizeId) return msg("rDrawMsg", "Pick the prize they chose first.", false);
      try { const r = await rApi("raffleAssign", { drawId: as.dataset.assign, prizeId }, "rDrawMsg"); assignPick = ""; msg("rDrawMsg", `${r.assigned.name} gets ${r.assigned.prizeName}. It's off the list.`); } catch {}
      return;
    }
    if (e.target.id === "rIdle") return rApi("raffleShowIdle", {}, "rDrawMsg").catch(() => {});
    if (e.target.id === "rPartClear") {
      e.preventDefault();
      if (confirm("Remove all race participants from the raffle?")) rApi("raffleLoadParticipants", { clear: true, participants: [], force: $("rPartForce").checked }, "rPartMsg").catch(() => {});
      return;
    }
    if (rd) {
      if (!confirm("Mark this winner as not present and draw this prize again? Their winning entry stays out of the pool.")) return;
      try { const r = await rApi("raffleRedraw", { drawId: rd.dataset.redraw }, "rDrawMsg"); msg("rDrawMsg", `Redrawing on screen… lands on ${r.drawn.number}.`); } catch {}
    }
    if (un) {
      if (!confirm("Undo this draw? The entry goes back into the pool and the prize can be drawn again.")) return;
      rApi("raffleUndo", { drawId: un.dataset.undo }, "rDrawMsg").catch(() => {});
    }
    if (rm) rApi("raffleRemoveManual", { id: rm.dataset.rmman }, "rManMsg").catch(() => {});
  });

  /* Givebutter tickets */
  $("rPull").onclick = async () => {
    msg("rTixMsg", "Pulling tickets…");
    $("rPull").disabled = true;
    try {
      const r = await rApi("rafflePullGivebutter", {}, "rTixMsg");
      msg("rTixMsg", `Loaded ${r.pulled.toLocaleString()} tickets from Givebutter. Check the ticket types below.`);
    } catch {} finally { $("rPull").disabled = false; }
  };
  let tixRows = [];
  $("rTixFile").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const rows = parseCSV(await file.text());
    const [hdr, ...data] = rows;
    // The ticket-number column is the one whose values look like A1042.
    let iNum = -1, best = 0;
    hdr.forEach((_, i) => { const hits = data.filter((r) => /^[A-Z]{1,2}\d{3,}$/i.test((r[i] || "").trim())).length; if (hits > best) { best = hits; iNum = i; } });
    if (iNum < 0) iNum = findCol(hdr, ["ticketnumber", "ticketno", "ticket#", "number", "ticketid", "ticketcode", "code", "id"]);
    const iName = findCol(hdr, ["name", "fullname", "attendeename", "attendee", "ticketholder", "holder", "guestname"]);
    const iFirst = findCol(hdr, ["firstname", "attendeefirstname", "first"]);
    const iLast = findCol(hdr, ["lastname", "attendeelastname", "last"]);
    const iEmail = hdr.findIndex((h) => normH(h).includes("email"));
    const iPhone = hdr.findIndex((h) => /phone|mobile|cell/.test(normH(h)));
    const iType = findCol(hdr, ["ticket", "ticketname", "tickettype", "tickettitle", "title", "item", "itemname", "description", "type"]);
    tixRows = iNum < 0 ? [] : data.map((r) => ({
      number: (r[iNum] || "").trim(),
      name: iName >= 0 && r[iName] ? r[iName].trim() : [iFirst >= 0 ? r[iFirst] : "", iLast >= 0 ? r[iLast] : ""].join(" ").trim(),
      email: iEmail >= 0 ? (r[iEmail] || "").trim() : "",
      phone: iPhone >= 0 ? (r[iPhone] || "").trim() : "",
      type: iType >= 0 && r[iType] ? r[iType].trim() : "Ticket",
    })).filter((t) => t.number);
    if (!tixRows.length) { $("rTixPreview").textContent = "Couldn't find a ticket-number column in that file."; return; }
    $("rTixPreview").innerHTML = `Found ${tixRows.length} tickets (number column: “${esc(hdr[iNum])}”). First: <b>${esc(tixRows[0].number)}</b> ${esc(tixRows[0].name)} · ${esc(tixRows[0].type)}. <button class="btn sm" id="rTixImport">Import these tickets</button>`;
  };
  $("rTixPreview").addEventListener("click", async (e) => {
    if (e.target.id !== "rTixImport") return;
    try {
      const r = await rApi("raffleImportTickets", { tickets: tixRows }, "rTixMsg");
      msg("rTixMsg", `Imported ${r.pulled.toLocaleString()} tickets. They replace any tickets pulled earlier.`);
      $("rTixPreview").textContent = "";
    } catch {}
  });
  $("rTypes").addEventListener("change", (e) => {
    const inp = e.target.closest("input[data-type]");
    if (inp) rApi("raffleSetTypes", { typeEntries: { [inp.dataset.type]: inp.value } }, "rTixMsg").catch(() => {});
  });

  /* Participants */
  let partRows = [];
  $("rPartFile").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const rows = parseCSV(await file.text());
    if (!rows.length) return;
    const hdr = rows[0];
    const iName = findCol(hdr, ["name", "fullname", "participant", "participantname", "runner", "runnername", "registrant", "athlete"]);
    const iFirst = findCol(hdr, ["firstname", "first", "fname", "givenname"]);
    const iLast = findCol(hdr, ["lastname", "last", "lname", "surname", "familyname"]);
    const iEmail = hdr.findIndex((h) => normH(h).includes("email"));
    const iPhone = hdr.findIndex((h) => /phone|mobile|cell/.test(normH(h)));
    const iBib = findCol(hdr, ["bib", "bib#", "bibnumber", "bibno", "racenumber"]);
    const hasHeader = iName >= 0 || iFirst >= 0;
    const data = hasHeader ? rows.slice(1) : rows;
    partRows = data.map((r) => ({
      name: (hasHeader ? (iName >= 0 && r[iName] ? r[iName] : [iFirst >= 0 ? r[iFirst] : "", iLast >= 0 ? r[iLast] : ""].join(" ")) : r[0] || "").replace(/\s+/g, " ").trim(),
      email: iEmail >= 0 ? (r[iEmail] || "").trim() : "",
      phone: iPhone >= 0 ? (r[iPhone] || "").trim() : "",
      bib: iBib >= 0 ? (r[iBib] || "").trim() : "",
    })).filter((p) => p.name);
    const seen = new Map();
    for (const p of partRows) { const k = (p.email || p.name).toLowerCase(); seen.set(k, (seen.get(k) || 0) + 1); }
    const dup = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
    $("rPartPreview").innerHTML = partRows.length
      ? `Found <b style="color:var(--text)">${partRows.length}</b> runners${hasHeader ? "" : " (no header row, so the first column is used as the name)"}: ${partRows.slice(0, 5).map((p) => esc(p.name)).join(", ")}${partRows.length > 5 ? "…" : ""}` +
        (dup.length ? `<div class="msg err">Listed more than once: ${esc(dup.slice(0, 8).join(", "))}${dup.length > 8 ? "…" : ""}. Each row gets entries, so remove duplicates first if they're the same person.</div>` : "")
      : "No names found in that file.";
    $("rPartLoad").disabled = !partRows.length;
  };
  $("rPartLoad").onclick = async () => {
    const each = Number($("rEach").value);
    if (raffle.participants.count && !confirm(`Replace the ${raffle.participants.count} runners already loaded?`)) return;
    try {
      await rApi("raffleLoadParticipants", { participants: partRows, each, force: $("rPartForce").checked }, "rPartMsg");
      msg("rPartMsg", `Loaded ${partRows.length} runners with ${each} entries each (${(partRows.length * each).toLocaleString()} entries).`);
      $("rPartPreview").textContent = ""; $("rPartFile").value = ""; $("rPartLoad").disabled = true;
    } catch {}
  };

  /* Manual entries */
  $("rManForm").onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try { await rApi("raffleAddManual", fd, "rManMsg"); msg("rManMsg", `Added ${fd.count} entr${fd.count == 1 ? "y" : "ies"} for ${fd.name}.`); e.target.reset(); } catch {}
  };

  /* Downloads + reset */
  const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  function download(name, rows) {
    const blob = new Blob([rows.map((r) => r.map(csvCell).join(",")).join("\r\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  $("rResultsCsv").onclick = () => download("raffle-results.csv", [["Time", "Prize", "Entry #", "Name", "Email", "Phone", "Source", "Status", "How awarded"],
    ...raffle.draws.map((d) => [new Date(d.at).toLocaleString(), d.prizeName || (d.status === "won" ? "(not chosen yet)" : ""), d.number, d.name, d.email, d.phone || "", d.type || d.source, d.status === "won" ? "Winner" : "Not present", d.choice ? "Winner chose" : "Drawn for prize"])]);
  $("rEntriesCsv").onclick = async () => {
    const { entries } = await api("raffleEntries");
    download("raffle-entries.csv", [["Entry #", "Name", "Email", "Source", "Drawn"], ...entries.map((e) => [e.number, e.name, e.email, e.type, e.drawn])]);
  };
  const reset = (everything) => rApi("raffleReset", { confirm: $("rResetConfirm").value.trim(), everything }, "rResetMsg").then(() => msg("rResetMsg", everything ? "Raffle cleared." : "All draws cleared.")).catch(() => {});
  $("rResetDraws").onclick = () => reset(false);
  $("rResetAll").onclick = () => reset(true);
  $("rClearSales").onclick = () => {
    if (!confirm("Delete every raffle sale? Their ticket numbers leave the drawing and numbering starts over. This can't be undone.")) return;
    rApi("raffleClearSales", { confirm: $("rResetConfirm").value.trim() }, "rResetMsg").then((r) => msg("rResetMsg", `Cleared ${r.cleared} sale${r.cleared === 1 ? "" : "s"}.`)).catch(() => {});
  };

  $("tabs").addEventListener("click", (e) => { if (e.target.closest("[data-tab=raffle]")) loadRaffle(); });
  // Keep the raffle tab fresh while it's open (other staff may be drawing too).
  setInterval(() => {
    if (!password || $("tab-raffle").hidden || document.hidden) return;
    const typing = document.activeElement && ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);
    if (!typing && !prizeDraft) loadRaffle();
  }, 8000);


  /* ---------- Raffle: event sales + texting ---------- */
  let salesFormDirty = false;
  const parseBundles = (t) => [...String(t).matchAll(/(\d+)\s*(?:for|=|@|:)\s*\$?\s*(\d+(?:\.\d+)?)/gi)].map((m) => ({ count: +m[1], price: +m[2] }));
  const bundlesText = (b) => (b || []).map((x) => `${x.count} for ${x.price}`).join(", ");
  function renderSalesCard() {
    const r = raffle, c = r.salesConfig || {}, t = r.salesSummary;
    $("rSalesStats").innerHTML = [["Sold at event", `${t.tickets} tickets`], ["Sales", t.sales], ["Cash", fmt$(t.cash)], ["Check", fmt$(t.check || 0)], ["Card", fmt$(t.card)]].map(([k, v]) => `<div class="stat"><span>${k}</span><b>${esc(v)}</b></div>`).join("");
    if (!salesFormDirty) {
      $("rPrice").value = c.price ?? "";
      $("rBundles").value = bundlesText(c.bundles);
      $("rDrawInfo").value = c.drawingInfo || "";
      $("rFooter").value = c.slipFooter || "";
      $("rSmsTpl").value = r.smsTemplate || "";
      smsLen();
    }
    $("rTwilio").innerHTML = r.smsConfigured ? `<span class="pill won">Connected</span> Twilio settings found in Netlify.` : `<span class="pill error">Not set up</span> Add <code>TWILIO_ACCOUNT_SID</code>, <code>TWILIO_AUTH_TOKEN</code> and <code>TWILIO_MESSAGING_SERVICE_SID</code> in Netlify, then redeploy.`;
  }
  function smsLen() {
    const sample = $("rSmsTpl").value.replace(/\{first\}/g, "Sarah").replace(/\{name\}/g, "Sarah Ramsey").replace(/\{numbers\}/g, [1, 2, 3].map((i) => (raffle?.numbering?.prefix || "2026") + String(i).padStart(4, "0")).join(", ")).replace(/\{count\}/g, "3").replace(/\{event\}/g, raffle?.title || "");
    $("rSmsLen").textContent = `${sample.length} characters with 3 numbers${sample.length > 160 ? " (sends as more than one text segment)" : ""}. Preview: ${sample}`;
  }
  for (const id of ["rPrice", "rBundles", "rDrawInfo", "rFooter", "rSmsTpl"]) $(id).addEventListener("input", () => { salesFormDirty = true; if (id === "rSmsTpl") smsLen(); });
  $("rSalesSave").onclick = async () => {
    const bundles = parseBundles($("rBundles").value);
    if ($("rBundles").value.trim() && !bundles.length) return msg("rSalesMsg", "Write bundles like “3 for 10, 7 for 20”.", false);
    try {
      await rApi("raffleSaveSalesConfig", { config: { price: $("rPrice").value, bundles, drawingInfo: $("rDrawInfo").value, slipFooter: $("rFooter").value }, smsTemplate: $("rSmsTpl").value }, "rSalesMsg");
      salesFormDirty = false; renderSalesCard();
      msg("rSalesMsg", "Saved. The Sell page picks this up within 20 seconds (or on refresh).");
    } catch {}
  };
  $("rTestSms").onclick = async () => {
    try { const r = await api("raffleTestSms", { phone: $("rTestPhone").value }); msg("rTestMsg", `Sent: “${r.text}”`); } catch (e) { msg("rTestMsg", e.message, false); }
  };
  async function loadPending() {
    try {
      const p = await api("raffleTextPending", { dryRun: true });
      $("rPendingInfo").innerHTML = p.pending
        ? `<b>${p.pending}</b> ${p.pending === 1 ? "person has" : "people have"} <b>${p.pendingNumbers}</b> ticket numbers that haven't been texted yet.${p.noPhone ? ` <span class="dim">${p.noPhone} entries have no phone number and can't be texted.</span>` : ""}`
        : `Everyone with a phone number has been texted.${p.noPhone ? ` <span class="dim">${p.noPhone} entries have no phone number.</span>` : ""}`;
      $("rPendingPreview").innerHTML = p.preview.map((g) => `${esc(g.name)} ${esc(g.to)}: ${esc(g.numbers.join(", "))}`).join("<br>");
      $("rTextNow").disabled = !p.pending || !p.smsConfigured;
    } catch (e) { $("rPendingInfo").textContent = e.message; }
  }
  $("rTextNow").onclick = async () => {
    if (!confirm("Text everyone their ticket numbers now? Each number is only ever texted once.")) return;
    $("rTextNow").disabled = true;
    let sent = 0; const failed = [];
    try {
      for (let i = 0; i < 100; i++) {
        const r = await api("raffleTextPending", {});
        sent += r.sent; failed.push(...r.failed);
        if (r.raffle) { raffle = r.raffle; renderRaffle(); }
        msg("rTextMsg", `Sent ${sent} texts… ${r.remaining} left`);
        if (!r.remaining) break;
      }
      msg("rTextMsg", `Done: ${sent} texts sent.${failed.length ? ` ${failed.length} failed: ` + failed.slice(0, 5).map((f) => `${f.name} ${f.to} (${f.error})`).join("; ") : ""}`, !failed.length);
    } catch (e) { msg("rTextMsg", e.message, false); }
    loadPending(); if (!$("rSmsLog").hidden && $("rSmsLog").innerHTML) loadSmsLog();
  };
  $("rRetryFailed").onclick = async () => {
    try { const r = await rApi("raffleRetryFailedTexts", {}, "rTextMsg"); msg("rTextMsg", r.cleared ? `${r.cleared} failed numbers are back in the queue. Fix the phone numbers if needed, then text again.` : "No failed texts."); loadPending(); } catch {}
  };
  async function loadSmsLog() {
    const { log } = await api("raffleSmsLog");
    $("rSmsLog").innerHTML = `<thead><tr><th>Time</th><th>To</th><th>Numbers</th><th>Result</th></tr></thead><tbody>${
      log.map((l) => `<tr><td class="dim" style="white-space:nowrap">${new Date(l.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</td><td>${esc(l.name)}<div class="dim" style="white-space:nowrap">${esc(l.to)}</div></td><td>${esc((l.numbers || []).join(", "))}</td><td><span class="pill ${l.ok ? "won" : "error"}">${l.ok ? "sent" : "failed"}</span>${l.error ? `<div class="dim">${esc(l.error)}</div>` : ""}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No texts yet.</td></tr>`
    }</tbody>`;
  }
  $("rSmsLogBtn").onclick = () => loadSmsLog().catch((e) => msg("rTextMsg", e.message, false));
  $("rSalesCsv").onclick = async () => {
    const { sales } = await api("raffleSales");
    download("raffle-sales.csv", [["Time", "Name", "Phone", "Email", "Tickets", "Numbers", "Payment", "Check #", "Card", "Stripe payment", "Amount", "Text", "Givebutter", "Voided", "Refunded"],
      ...sales.slice().reverse().map((x) => [new Date(x.at).toLocaleString(), x.name, x.phonePretty, x.email, x.count, x.numbers.join(" "), x.payment, x.checkNo || "", x.stripe ? `${x.stripe.brand || ""} ${x.stripe.last4 || ""}`.trim() : "", x.stripe?.pi || "", x.amount, x.sms?.status || "", x.gb?.status || "", x.voided ? "yes" : "", x.stripe?.refunded ? "yes" : ""])]);
  };
  $("tabs").addEventListener("click", (e) => { if (e.target.closest("[data-tab=raffle]")) loadPending(); });

  /* Ticket numbering */
  let numDirty = false;
  const fmtNum = (n, start) => `${n.prefix} ${String(start).padStart(4, "0")}`;
  function renderNumbering() {
    const n = raffle.numbering;
    if (!n) return;
    if (!numDirty) { $("rNumPrefix").value = n.prefix; $("rNumSale").value = n.saleStart; $("rNumPart").value = n.participantStart; $("rNumMan").value = n.manualStart; }
    document.querySelectorAll(".numSale").forEach((e) => (e.textContent = fmtNum(n, n.saleStart)));
    document.querySelectorAll(".numPart").forEach((e) => (e.textContent = fmtNum(n, n.participantStart)));
    document.querySelectorAll(".numMan").forEach((e) => (e.textContent = fmtNum(n, n.manualStart)));
    const room = Math.min(...[n.participantStart, n.manualStart].filter((b) => b > n.saleStart), 10000) - n.saleStart;
    $("rNumInfo").textContent = `Room for ${room.toLocaleString()} sold tickets.`;
    const st = raffle.stripe || {};
    $("rStripeInfo").innerHTML = st.configured ? `<span class="pill won">Connected</span> Stripe key found (<b>${st.mode === "live" ? "LIVE" : "TEST"} mode</b>). Card sales on the Sell page are sent to the SRS Card Terminal app on an iPhone paired with a Stripe Reader M2.` : `<span class="pill error">Not set up</span> Add <code>STRIPE_SECRET_KEY</code> in Netlify to take cards on the M2 readers. Until then, use “Card charged another way…” on the Sell page.`;
  }
  for (const id of ["rNumPrefix", "rNumSale", "rNumPart", "rNumMan"]) $(id).addEventListener("input", () => { numDirty = true; });
  $("rNumSave").onclick = async () => {
    try {
      await rApi("raffleSaveNumbering", { numbering: { prefix: $("rNumPrefix").value.trim(), saleStart: $("rNumSale").value, participantStart: $("rNumPart").value, manualStart: $("rNumMan").value } }, "rNumMsg");
      numDirty = false; renderNumbering(); msg("rNumMsg", "Saved.");
    } catch {}
  };
  async function loadTerminals() {
    try {
      const r = await api("cardTerminals");
      $("rTermList").innerHTML = r.terminals.length ? "Open right now: " + r.terminals.map((t) => `<b>${esc(t.name)}</b>${t.reader ? ` (${esc(t.reader)}${t.battery != null ? `, battery ${Math.round(t.battery * 100)}%` : ""})` : " (no reader connected)"}${t.busy ? " · taking a payment" : ""}`).join(", ") : "No card terminal app is open right now.";
    } catch (e) { $("rTermList").textContent = e.message; }
  }
  $("rTermRefresh").onclick = loadTerminals;

  /* Buyer lookup */
  async function lookupInfo() {
    try { const r = await api("lookupIndex"); $("rLookupInfo").textContent = r.pulledAt ? `${r.rows.length.toLocaleString()} contacts, pulled ${new Date(r.pulledAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "Not pulled yet."; } catch {}
  }
  $("rLookupPull").onclick = async () => {
    const btn = $("rLookupPull"); btn.disabled = true;
    try {
      let page = 1, r;
      do { r = await api("lookupPull", { fromPage: page }); page = r.nextPage; msg("rLookupMsg", `Loading… ${r.loaded.toLocaleString()} contacts (page ${Math.min(page || r.lastPage, r.lastPage)} of ${r.lastPage})`); } while (!r.done);
      msg("rLookupMsg", `Done: ${r.loaded.toLocaleString()} contacts. Reload the Sell page to use them.`);
      lookupInfo();
    } catch (e) { msg("rLookupMsg", e.message, false); }
    finally { btn.disabled = false; }
  };

  /* Sending sales to Givebutter */
  let gbRecDirty = false;
  function renderGbRecord() {
    const r = raffle, g = r.gbRecord || {};
    $("rGbRecWarn").hidden = r.gbConfigured;
    if (!gbRecDirty) { $("rGbOn").checked = !!g.enabled; $("rGbAuto").checked = !!g.auto; $("rGbCode").value = g.campaignCode || ""; $("rGbFallback").value = g.fallbackEmail || ""; }
    $("rGbPending").hidden = !r.gbUnrecorded;
    $("rGbPending").textContent = `Send ${r.gbUnrecorded} sale${r.gbUnrecorded === 1 ? "" : "s"} to Givebutter`;
    $("rGbInfo2").innerHTML = (!g.enabled ? "Sending to Givebutter is turned off." : r.gbUnrecorded ? `<b>${r.gbUnrecorded}</b> sale${r.gbUnrecorded === 1 ? " is" : "s are"} not in Givebutter yet${g.campaignCode ? ` (campaign <b>${esc(g.campaignCode)}</b>)` : " (no campaign selected)"}.` : "Every sale is in Givebutter.") +
      (r.gbVoidedToFix ? ` <span style="color:var(--red)">${r.gbVoidedToFix} voided sale${r.gbVoidedToFix === 1 ? " is" : "s are"} still in Givebutter. Their note says VOIDED; delete them there.</span>` : "");
  }
  for (const id of ["rGbOn", "rGbAuto", "rGbCode", "rGbFallback"]) $(id).addEventListener("input", () => { gbRecDirty = true; });
  $("rGbCampSel").onchange = (e) => { if (e.target.value) { $("rGbCode").value = e.target.value; gbRecDirty = true; } };
  $("rGbCampLoad").onclick = async () => {
    try {
      const { campaigns } = await api("listCampaigns");
      $("rGbCampSel").innerHTML = `<option value="">— choose a campaign —</option>` + campaigns.filter((c) => c.code).map((c) => `<option value="${esc(c.code)}">${esc(c.title)} (${esc(c.code)})</option>`).join("");
      $("rGbCampSel").value = $("rGbCode").value;
      msg("rGbMsg", `Loaded ${campaigns.length} campaigns.`);
    } catch (e) { msg("rGbMsg", e.message, false); }
  };
  $("rGbSave").onclick = async () => {
    try {
      await rApi("raffleSaveGbRecord", { gbRecord: { enabled: $("rGbOn").checked, auto: $("rGbAuto").checked, campaignCode: $("rGbCode").value.trim(), fallbackEmail: $("rGbFallback").value.trim() } }, "rGbMsg");
      gbRecDirty = false; renderGbRecord(); msg("rGbMsg", "Saved.");
    } catch {}
  };
  $("rGbTest").onclick = async () => {
    if (!confirm("This creates a real $1.00 cash transaction named “Raffle Test” in Givebutter so you can see where sales land. Delete it in Givebutter afterwards. Continue?")) return;
    try { const r = await api("raffleTestGbRecord"); msg("rGbMsg", `Created test transaction${r.id ? " " + r.id : ""} in ${r.campaign}. Find it in Givebutter › Transactions, check it, then delete it.`); }
    catch (e) { msg("rGbMsg", e.message, false); }
  };
  $("rGbPending").onclick = async () => {
    if (!confirm(`Send ${raffle.gbUnrecorded} sales to Givebutter${raffle.gbRecord?.campaignCode ? ` (campaign ${raffle.gbRecord.campaignCode})` : " with no campaign"}?`)) return;
    let ok = 0; const bad = [];
    $("rGbPending").disabled = true;
    try {
      for (let i = 0; i < 100; i++) {
        const r = await rApi("raffleRecordPending", {}, "rGbMsg");
        ok += r.recorded; bad.push(...r.failed);
        msg("rGbMsg", `Sent ${ok}…`);
        if (!r.remaining || !r.recorded) break;
      }
      msg("rGbMsg", `Sent ${ok} sale${ok === 1 ? "" : "s"} to Givebutter.${bad.length ? ` ${bad.length} failed: ${bad.slice(0, 3).map((b) => `${b.name} (${b.error})`).join("; ")}` : ""}`, !bad.length);
    } catch {}
    finally { $("rGbPending").disabled = false; }
  };
  $("tabs").addEventListener("click", (e) => { if (e.target.closest("[data-tab=raffle]")) { loadTerminals(); lookupInfo(); } });

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
