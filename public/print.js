/* Print station: the laptop with the USB Star TSP100 keeps this page open. It checks the print queue
 * every 1.5 seconds and prints each slip that phones (or other Sell pages) send. */
(() => {
  const $ = (id) => document.getElementById(id);
  const { esc } = SRSSlip;
  const ss = {
    get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
    del: (k) => { try { sessionStorage.removeItem(k); } catch {} },
  };
  const pref = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };
  const printer = {
    id: pref.get("printStationId", "") || (() => { const v = "pr-" + Math.random().toString(36).slice(2, 8); pref.set("printStationId", v); return v; })(),
    name: pref.get("printStationName", "Laptop printer"),
  };

  let password = ss.get("auctionPw") || "";
  let paused = false, printing = false, okSince = Date.now(), lastError = "";
  let count = Number(pref.get("printStationCount", "0")) || 0;
  let meta = { title: "Raffle", prefix: "2026", cfg: {} };

  async function api(action, params = {}) {
    const res = await fetch("/api/admin", { method: "POST", headers: { "content-type": "application/json", "x-admin-password": password }, body: JSON.stringify({ action, ...params }) });
    const body = await res.json().catch(() => ({ error: "Unexpected server response." }));
    if (res.status === 401) { signOut(); throw new Error(body.error); }
    if (!res.ok) throw new Error(body.error || "Request failed");
    return body;
  }

  function signOut() { password = ""; ss.del("auctionPw"); $("appView").hidden = true; $("loginView").hidden = false; }
  $("loginForm").onsubmit = async (e) => {
    e.preventDefault();
    password = $("pw").value;
    try { await api("login"); ss.set("auctionPw", password); start(); }
    catch (err) { $("loginMsg").innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
  };

  function status() {
    const el = $("status");
    const offline = lastError && Date.now() - okSince > 5000;
    el.className = "status" + (paused ? " paused" : offline ? " off" : "");
    $("sBig").textContent = paused ? "Paused" : offline ? "Can't reach the website" : printing ? "Printing…" : "Ready to print";
    $("sSub").textContent = paused ? "Slips wait in the queue until you resume." : offline ? lastError + " (retrying)" : "Slips from phones and other Sell pages print here.";
    $("sCount").textContent = count;
    $("pause").textContent = paused ? "Resume printing" : "Pause printing";
    $("warn").innerHTML = document.hidden ? `<div class="msg warn">This window is hidden or minimized. Chrome slows hidden pages down, so slips may be late. Bring it to the front.</div>` : "";
  }
  document.addEventListener("visibilitychange", status);

  async function loop() {
    if (!password) return;
    if (!paused && !printing) {
      try {
        const r = await api("printPoll", { printer });
        meta = { title: r.title || meta.title, prefix: r.numbering?.prefix || meta.prefix, cfg: r.salesConfig || {} };
        okSince = Date.now(); lastError = "";
        if (r.jobs.length) {
          printing = true; status();
          for (const j of r.jobs) {
            try {
              if (j.kind === "test") await SRSSlip.print(SRSSlip.testHTML(meta.title));
              else if (j.sale) await SRSSlip.printSale(j.sale, meta);
              await api("printDone", { ids: [j.id], printer });
              count++; pref.set("printStationCount", String(count));
            } catch (e) { lastError = e.message; }
          }
          printing = false;
          loadJobs();
        }
      } catch (e) { lastError = e.message; printing = false; }
    }
    status();
    setTimeout(loop, 1500);
  }

  async function loadJobs() {
    try {
      const r = await api("printJobs");
      $("jobs").innerHTML = r.jobs.map((j) => `<li>
          <span class="nm">${j.kind === "test" ? "Test print" : esc(j.name || "(sale)") + (j.count ? ` · ${j.count} ticket${j.count === 1 ? "" : "s"}` : "")}${j.reprint ? ' <span class="dim">reprint</span>' : ""}</span>
          <span class="dim">${esc(j.from || "")}</span>
          <span class="dim">${new Date(j.printedAt || j.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
          <span class="pill ${j.status}">${j.status}</span></li>`).join("") || `<li class="muted">Nothing yet.</li>`;
    } catch {}
  }

  $("pause").onclick = () => { paused = !paused; status(); };
  $("testLocal").onclick = () => SRSSlip.print(SRSSlip.testHTML(meta.title));
  $("testQueue").onclick = async () => { try { await api("printTest", { from: printer.name }); } catch (e) { alert(e.message); } };
  $("pname").value = printer.name;
  $("pname").onchange = (e) => { printer.name = e.target.value.trim() || "Laptop printer"; pref.set("printStationName", printer.name); };
  $("cmd").textContent = `open -na "Google Chrome" --args --kiosk-printing --user-data-dir="$HOME/srs-print-station" ${location.origin}/print`;

  function start() {
    $("loginView").hidden = true; $("appView").hidden = false;
    loop(); loadJobs();
    setInterval(loadJobs, 10000);
  }
  if (password) api("login").then(start).catch(() => signOut()); else signOut();
})();
