/* Live silent auction display. Polls /api/state and renders pages that rotate. */
(() => {
  const POLL_MS = 5000;
  const params = new URLSearchParams(location.search);
  const MODE = params.get("mode") || "rotate"; // rotate | grid | board
  const $ = (id) => document.getElementById(id);

  let data = null;
  let clockOffset = 0; // server time - local time
  let prevCounts = null; // itemId -> bidCount from last poll
  const flashUntil = new Map(); // itemId -> timestamp
  let screenIndex = 0;
  let screenTimer = null;
  let lastOk = 0;
  let wasClosed = null;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt$ = (n) => (n == null ? "—" : "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }));
  const now = () => Date.now() + clockOffset;
  const ago = (iso) => {
    const s = Math.max(0, Math.round((now() - Date.parse(iso)) / 1000));
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  };
  const STATUS = { nobids: "Open", leading: "Leading", hot: "Hot", closing: "Closing soon", won: "Won", sold: "Sold", unsold: "Unsold" };
  const isMobile = () => matchMedia("(max-width: 860px)").matches;
  const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

  /* ---------------- Data ---------------- */
  async function poll() {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      const next = await res.json();
      clockOffset = Date.parse(next.serverTime) - Date.now();
      detectNewBids(next);
      data = next;
      lastOk = Date.now();
      renderAll();
    } catch (e) {
      setLive(false);
    }
  }

  function detectNewBids(next) {
    const counts = new Map(next.items.map((i) => [i.id, i.bidCount]));
    if (prevCounts) {
      const fresh = next.items.filter((i) => i.bidCount > (prevCounts.get(i.id) || 0) && i.currentBid != null);
      for (const it of fresh) {
        flashUntil.set(it.id, Date.now() + 2600);
        toast(`New bid! ${it.number ? "#" + it.number + " " : ""}${it.name} — ${fmt$(it.currentBid)} by ${it.leader}`);
      }
    }
    prevCounts = counts;
  }

  /* ---------------- Toasts ---------------- */
  const toastQueue = [];
  let toastBusy = false;
  function toast(msg) {
    toastQueue.push(msg);
    if (toastQueue.length > 4) toastQueue.splice(0, toastQueue.length - 4);
    if (!toastBusy) nextToast();
  }
  function nextToast() {
    const msg = toastQueue.shift();
    const el = $("toast");
    if (!msg) { toastBusy = false; return; }
    toastBusy = true;
    el.textContent = msg;
    el.classList.add("show");
    setTimeout(() => { el.classList.remove("show"); setTimeout(nextToast, 500); }, 3600);
  }

  /* ---------------- Rendering ---------------- */
  function setLive(ok) {
    $("liveDot").classList.toggle("off", !ok);
    const u = $("updated");
    if (ok) {
      u.classList.remove("err");
      u.textContent = "Live · updated " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    } else {
      u.classList.add("err");
      u.textContent = lastOk ? "Reconnecting… (showing data from " + Math.round((Date.now() - lastOk) / 1000) + "s ago)" : "Connecting…";
    }
  }

  function renderAll() {
    const { settings } = data;
    document.title = settings.title + " — Live";
    $("title").textContent = settings.title;
    $("subtitle").textContent = settings.subtitle || "";
    $("subtitle").hidden = !settings.subtitle;
    $("bidUrl").innerHTML = settings.bidUrl ? `Bid now at <b>${esc(settings.bidUrl.replace(/^https?:\/\//, ""))}</b>` : "";
    renderStats();
    renderFeed();
    renderWanted();
    renderGivebutter();
    renderScreen();
    setLive(true);
    tick();
  }

  function renderStats() {
    const s = data.summary;
    const gb = data.givebutter;
    const pctItems = s.itemCount ? Math.round((s.itemsWithBids / s.itemCount) * 100) : 0;
    const tiles = [
      `<div class="stat hero"><div class="k">Total high bids</div><div class="v">${fmt$(s.totalHighBids)}</div><div class="s">across ${s.itemsWithBids} item${s.itemsWithBids === 1 ? "" : "s"}</div></div>`,
      `<div class="stat"><div class="k">Items with bids</div><div class="v">${s.itemsWithBids}<small> / ${s.itemCount}</small></div><div class="bar"><i style="width:${pctItems}%"></i></div></div>`,
      `<div class="stat"><div class="k">Bids placed</div><div class="v">${s.totalBids.toLocaleString()}</div><div class="s">${s.topItem ? "Top: " + fmt$(s.topItem.amount) + " · " + esc(s.topItem.name) : "Waiting for the first bid"}</div></div>`,
    ];
    if (s.percentOfValue != null)
      tiles.push(`<div class="stat"><div class="k">Bids vs. value</div><div class="v">${s.percentOfValue}%</div><div class="s">of retail value on items with bids</div></div>`);
    if (gb) {
      const pct = gb.goal ? Math.min(100, Math.round((gb.raised / gb.goal) * 100)) : null;
      tiles.push(`<div class="stat"><div class="k">Campaign raised</div><div class="v" style="color:var(--green)">${fmt$(gb.raised)}</div>${
        pct != null ? `<div class="bar"><i style="width:${pct}%;background:var(--green)"></i></div><div class="s">${pct}% of ${fmt$(gb.goal)} goal · ${gb.donors} supporters</div>` : `<div class="s">${gb.donors} supporters</div>`
      }</div>`);
    }
    $("stats").innerHTML = tiles.join("");
  }

  function renderFeed() {
    const list = data.recentBids;
    $("feed").innerHTML = list.length
      ? list.map((b) => `<li><span class="who">${esc(b.leader)}</span><span class="amt">${fmt$(b.amount)}</span><span class="what">${b.itemNumber ? "#" + esc(b.itemNumber) + " · " : ""}${esc(b.itemName)}</span><span class="when">${ago(b.at)}</span></li>`).join("")
      : `<li class="empty">No bids yet — be the first!</li>`;
  }

  function renderWanted() {
    const list = data.summary.mostWanted;
    $("wanted").innerHTML = list.length
      ? list.map((w, i) => `<li><span class="rank">${i + 1}</span><span class="nm">${esc(w.name)}</span><span class="ct">${w.bidCount} bid${w.bidCount === 1 ? "" : "s"} · ${fmt$(w.currentBid)}</span></li>`).join("")
      : `<li class="empty">Bidding activity will appear here.</li>`;
  }

  function renderGivebutter() {
    const gb = data.givebutter;
    const recent = gb && gb.recent ? gb.recent.slice(0, 3) : [];
    $("gbPanel").hidden = !recent.length;
    if (!recent.length) return;
    $("gbBody").innerHTML = `<ol class="feed">${recent
      .map((t) => `<li><span class="who">${esc(t.name)}</span><span class="amt" style="color:var(--green)">${fmt$(t.amount)}</span><span class="what">${esc(t.items.join(", ") || "Contribution")}</span><span class="when">${t.at ? ago(t.at) : ""}</span></li>`)
      .join("")}</ol>`;
  }

  /* Screens = grid pages (+ board pages). Each screen rotates on a timer. */
  function layout() {
    const view = $("stageView");
    const W = view.clientWidth, H = view.clientHeight, r = rem(), gap = r;
    const cols = Math.max(1, Math.floor((W + gap) / (20 * r + gap)));
    const rows = Math.max(1, Math.floor((H + gap) / (10 * r + gap)));
    const rowH = 2.9 * r;
    const rowsPerCol = Math.max(1, Math.floor(H / rowH));
    const boardCols = W > 100 * r ? 3 : W > 52 * r ? 2 : 1;
    return { cols, rows, gridSize: cols * rows, rowH, rowsPerCol, boardCols, boardSize: rowsPerCol * boardCols };
  }

  function buildScreens() {
    const items = data.items;
    if (isMobile()) return [{ type: MODE === "board" ? "board" : "grid", items, all: true }];
    const L = layout();
    const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out.length ? out : [[]]; };
    const closed = auctionClosed();
    const screens = [];
    if (MODE !== "board" && !(closed && MODE === "rotate"))
      chunk(items, L.gridSize).forEach((p) => screens.push({ type: "grid", items: p, L }));
    if (MODE !== "grid")
      chunk(items, L.boardSize).forEach((p) => {
        // Use only as many columns as this page needs, so names get room.
        const cols = Math.min(L.boardCols, Math.ceil(p.length / L.rowsPerCol)) || 1;
        screens.push({ type: "board", items: p, L: { ...L, boardCols: cols } });
      });
    return screens;
  }

  function renderScreen() {
    if (!data) return;
    const screens = buildScreens();
    if (screenIndex >= screens.length) screenIndex = 0;
    const sc = screens[screenIndex];
    const view = $("stageView");
    const closed = auctionClosed();

    // Pager
    $("pager").innerHTML = screens.length > 1 ? screens.map((_, i) => `<i class="${i === screenIndex ? "on" : ""}"></i>`).join("") : "";
    const gridPages = screens.filter((s) => s.type === "grid").length;
    $("stageTitle").textContent =
      sc.type === "board" ? (closed ? "Final results" : "All items — current standings") : gridPages > 1 ? `Auction items · page ${screenIndex + 1} of ${gridPages}` : "Auction items";

    if (!data.items.length) {
      view.innerHTML = `<div class="notice">No auction items yet.<br>Add them on the staff page at /admin.</div>`;
      return;
    }
    const key = screenIndex + ":" + screens.length + ":" + sc.type;
    const animate = view.dataset.key !== key;
    view.dataset.key = key;
    view.innerHTML = sc.type === "grid" ? gridHTML(sc) : boardHTML(sc);
    if (!animate) view.firstElementChild.style.animation = "none";
  }

  let sc_rows = 1; // descriptions only fit when cards are tall
  function flashing(id) { return (flashUntil.get(id) || 0) > Date.now(); }

  function gridHTML(sc) {
    const style = sc.all ? "" : `grid-template-columns:repeat(${sc.L.cols},minmax(0,1fr));grid-template-rows:repeat(${sc.L.rows},minmax(0,1fr))`;
    sc_rows = sc.all ? 1 : sc.L.rows;
    return `<div class="grid" style="${style}">${sc.items.map(cardHTML).join("")}</div>`;
  }

  function cardHTML(it) {
    const done = ["won", "sold", "unsold"].includes(it.status);
    const has = it.currentBid != null;
    if (it.buyNowOnly && it.status !== "sold" && !has) return buyNowCardHTML(it);
    const lbl = it.status === "sold" && !has ? "Sold for" : it.status === "won" || it.status === "sold" ? "Winning bid" : has ? "Current bid" : done ? "Final" : "Opening bid";
    const meta = [it.value ? "Value " + fmt$(it.value) : "", it.buyNow ? "Buy now " + fmt$(it.buyNow) : ""].filter(Boolean).join(" · ");
    const leaderLine = has
      ? `<b>${esc(it.leader)}</b><span>${it.status === "won" || it.status === "sold" ? "Winner" : `${it.bidCount} bid${it.bidCount === 1 ? "" : "s"} · next ${fmt$(it.nextMinimum)}+`}</span>`
      : `<b>${it.status === "sold" ? esc(it.soldTo || "Sold") : done ? "No bids" : "Be the first!"}</b><span>${done ? "" : "No bids yet"}</span>`;
    return `<article class="card ${it.status}${flashing(it.id) ? " flash" : ""}">
      <div class="card-top">${it.number ? `<span class="num">#${esc(it.number)}</span>` : ""}<span class="cat">${[esc(it.category), meta].filter(Boolean).join(" · ")}</span><span class="chip ${it.status}">${STATUS[it.status]}</span></div>
      <div class="card-main">
        ${it.image ? `<img class="thumb" src="${esc(it.image)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
        <div style="min-width:0"><div class="card-name">${esc(it.name)}</div>${it.description && sc_rows <= 2 ? `<div class="card-desc">${esc(it.description)}</div>` : ""}</div>
      </div>
      <div class="card-bid">
        <div><div class="bid-lbl">${lbl}</div><div class="bid-amt ${has ? "" : "none"}">${has ? fmt$(it.currentBid) : it.status === "sold" ? fmt$(it.soldPrice ?? it.buyNow) : done ? "—" : fmt$(it.startingBid)}</div></div>
        <div class="leader">${leaderLine}</div>
      </div>
    </article>`;
  }

  function buyNowCardHTML(it) {
    const left = it.remaining != null ? `${it.remaining} available` : "Limited availability";
    return `<article class="card leading${flashing(it.id) ? " flash" : ""}">
      <div class="card-top">${it.number ? `<span class="num">#${esc(it.number)}</span>` : ""}<span class="cat">${[esc(it.category), it.value ? "Value " + fmt$(it.value) : ""].filter(Boolean).join(" · ")}</span><span class="chip leading">Buy now</span></div>
      <div class="card-main">
        ${it.image ? `<img class="thumb" src="${esc(it.image)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
        <div style="min-width:0"><div class="card-name">${esc(it.name)}</div></div>
      </div>
      <div class="card-bid">
        <div><div class="bid-lbl">Buy now price</div><div class="bid-amt">${fmt$(it.buyNow)}</div></div>
        <div class="leader"><b>${esc(left)}</b><span>No bidding · purchase online</span></div>
      </div>
    </article>`;
  }

  function boardHTML(sc) {
    const style = sc.all ? "" : `grid-template-columns:repeat(${sc.L.boardCols},minmax(0,1fr));grid-template-rows:repeat(${sc.L.rowsPerCol},${sc.L.rowH}px)`;
    return `<div class="board" style="${style}">${sc.items
      .map((it) => {
        const has = it.currentBid != null;
        const who = it.buyNowOnly && !has && it.status !== "sold" ? "Buy now " + fmt$(it.buyNow) : has ? (it.status === "won" || it.status === "sold" ? "Won by " : "") + it.leader : it.status === "sold" ? "Sold" : it.status === "unsold" ? "No bids" : "Opening " + fmt$(it.startingBid);
        return `<div class="row ${has ? it.status : "none"}${flashing(it.id) ? " flash" : ""}"><span class="n">${it.number ? "#" + esc(it.number) : ""}</span><span class="nm">${esc(it.name)}</span><span class="amt">${has ? fmt$(it.currentBid) : "—"}</span><span class="ld">${esc(who)}</span></div>`;
      })
      .join("")}</div>`;
  }

  function startRotation() {
    clearTimeout(screenTimer);
    const secs = Math.max(5, (data && data.settings.rotateSeconds) || 15);
    screenTimer = setTimeout(() => {
      screenIndex++;
      renderScreen();
      startRotation();
    }, secs * 1000);
  }

  /* ---------------- Countdown ---------------- */
  function auctionClosed() {
    return !!(data && data.settings.endsAt && now() >= Date.parse(data.settings.endsAt));
  }

  function tick() {
    if (!data) return;
    const clock = $("clock"), digits = $("clockDigits"), label = $("clockLabel"), sub = $("clockSub");
    const end = data.settings.endsAt ? Date.parse(data.settings.endsAt) : null;
    clock.className = "clock";
    if (!end) {
      label.textContent = "Bidding is open";
      digits.innerHTML = `<span style="font-size:2.4rem">Live now</span>`;
      sub.textContent = "Closing time to be announced";
      return;
    }
    const ms = end - now();
    sub.textContent = (ms <= 0 ? "Closed " : "Closes ") + new Date(end).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const closed = ms <= 0;
    if (closed) {
      clock.classList.add("over");
      label.textContent = "Auction status";
      digits.textContent = "Bidding closed";
    } else {
      const t = Math.floor(ms / 1000);
      const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
      const p = (n) => String(n).padStart(2, "0");
      label.textContent = "Bidding closes in";
      digits.innerHTML = d > 0
        ? `${d}<span class="u">d</span>${p(h)}<span class="u">h</span>${p(m)}<span class="u">m</span>`
        : `${h ? h + '<span class="u">h</span>' : ""}${p(m)}<span class="u">m</span>${p(s)}<span class="u">s</span>`;
      const soon = (data.settings.closingSoonMinutes || 15) * 60000;
      if (ms < 5 * 60000) clock.classList.add("final");
      else if (ms < soon) clock.classList.add("soon");
    }
    const banner = $("closedBanner");
    banner.hidden = !closed;
    banner.textContent = data.settings.closedMessage || "Bidding is closed";
    if (wasClosed === false && closed) { screenIndex = 0; poll(); }
    wasClosed = closed;
  }

  /* ---------------- Chrome: full screen + idle cursor ---------------- */
  function toggleFs() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  }
  $("fsBtn").addEventListener("click", toggleFs);
  addEventListener("keydown", (e) => {
    if (e.key === "f" || e.key === "F") toggleFs();
    if (e.key === "ArrowRight") { screenIndex++; renderScreen(); startRotation(); }
    if (e.key === "ArrowLeft") { screenIndex = Math.max(0, screenIndex - 1); renderScreen(); startRotation(); }
  });
  let idleT;
  const wake = () => { document.body.classList.remove("idle"); clearTimeout(idleT); idleT = setTimeout(() => document.body.classList.add("idle"), 3000); };
  addEventListener("mousemove", wake);
  wake();
  let resizeT;
  addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(renderScreen, 200); });

  /* ---------------- Start ---------------- */
  poll().then(startRotation);
  setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
  setInterval(tick, 250);
  setInterval(() => { if (data) { renderFeed(); renderGivebutter(); } }, 30000);
})();
