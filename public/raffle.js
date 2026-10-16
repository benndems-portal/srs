/* Raffle screen. Polls /api/raffle; when staff draw a winner, the reel spins and lands on it. */
(() => {
  const POLL_MS = 1500;
  const SPIN_MS = 8000; // reel spin length
  const FILLER = 56; // rows that fly past before the winner
  const params = new URLSearchParams(location.search);
  const fromDisplay = params.get("from") === "display";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  let data = null;
  let clockOffset = 0;
  let shownDraw = null; // drawId currently on the reel
  let shownPrize = null; // prize shown for that draw (changes when a "choice" winner is assigned one)
  let spinning = false;

  /* ---------------- Data ---------------- */
  async function poll() {
    try {
      const res = await fetch("/api/raffle", { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
      clockOffset = Date.parse(data.serverTime) - Date.now();
      $("liveDot").classList.remove("off");
      // Screens that came from the auction display go back when staff end the raffle.
      if (!data.live && fromDisplay) {
        params.delete("from");
        const q = params.toString();
        location.replace("/" + (q ? "?" + q : ""));
        return;
      }
      render();
    } catch {
      $("liveDot").classList.add("off");
    }
  }

  function render() {
    document.title = data.title + " — Live";
    $("title").textContent = data.title;
    $("entries").textContent = data.eligible.toLocaleString() + " entries";
    $("people").textContent = data.people ? `from ${data.people.toLocaleString()} ${data.people === 1 ? "person" : "people"}` : "";
    $("note").textContent = data.live ? "" : "Preview: staff haven't put the raffle on the screens yet.";
    renderPrizes();

    const cur = data.current;
    if (!cur) {
      if (spinning) return; // let a spin finish before switching away
      shownDraw = null;
      showIdle();
      return;
    }
    if (cur.drawId === shownDraw && !spinning && (cur.prize?.id || null) !== shownPrize) {
      // Staff assigned (or changed) the prize this winner chose.
      land(cur, !!cur.prize);
      return;
    }
    if (cur.drawId !== shownDraw) {
      shownDraw = cur.drawId;
      const elapsed = Date.now() + clockOffset - Date.parse(cur.at);
      // Spin if the draw just happened; a screen opened later shows the result straight away.
      startDraw(cur, elapsed < SPIN_MS - 1500);
    }
  }

  function renderPrizes() {
    const cur = data.current;
    const curPrize = cur?.prize?.id;
    const choiceMode = cur ? cur.choice : data.awardMode === "choice";
    // Choosing: every remaining prize is "available". Prize mode: one prize is "now".
    const nowId = choiceMode ? null : curPrize || data.next?.id;
    const choosingNow = cur && cur.choice && !cur.prize && !spinning;
    $("prizeList").innerHTML = data.prizes.length
      ? data.prizes.map((p, i) => {
          const showWinner = p.winner && !(spinning && p.id === curPrize);
          const avail = choiceMode && !showWinner;
          return `<li class="${showWinner ? "won" : ""}${p.id === nowId && !showWinner ? " now" : ""}${avail ? " avail" : ""}">
            <span class="pi">${showWinner ? "✓" : i + 1}</span>
            <span class="pn">${esc(p.name)}</span>
            <span class="pw">${showWinner ? esc(p.winner.name) + " · " + esc(p.winner.number) : p.id === nowId ? (spinning ? "Drawing now…" : "Up next") : avail && choosingNow ? "Available to choose" : esc(p.detail || "")}</span>
          </li>`;
        }).join("")
      : `<li class="empty dim-note">Prizes will appear here.</li>`;
  }

  function showIdle() {
    $("draw").hidden = true;
    $("idle").hidden = false;
    const choice = data.awardMode === "choice" && data.available > 0;
    $("idle").classList.toggle("choice", choice);
    $("idleAvail").hidden = !choice;
    if (choice) {
      const left = data.prizes.filter((p) => !p.winner);
      document.querySelector(".r-kicker").textContent = "Next ticket drawn picks a prize";
      $("idlePrize").textContent = `${left.length} prize${left.length === 1 ? "" : "s"} still available`;
      $("idleDetail").textContent = "";
      $("idleImg").hidden = true;
      $("idleAvail").innerHTML = left.map((p) => `<div><b>${esc(p.name)}</b>${p.detail ? `<span>${esc(p.detail)}</span>` : ""}</div>`).join("");
      document.querySelector(".r-idle-foot").hidden = false;
      return;
    }
    document.querySelector(".r-kicker").textContent = "Up next";
    const n = data.next;
    $("idlePrize").textContent = n ? n.name : data.prizes.length ? "All prizes have been drawn!" : "Get ready!";
    $("idleDetail").textContent = n ? n.detail || "" : data.prizes.length ? "Congratulations to all of our winners, and thank you!" : "";
    $("idleImg").hidden = !(n && n.image);
    if (n && n.image) $("idleImg").style.backgroundImage = `url("${encodeURI(n.image)}")`;
    document.querySelector(".r-idle-foot").hidden = !n;
  }

  /* ---------------- Reel ---------------- */
  const rowHTML = (e, win) => `<div class="reel-row${win ? " win" : ""}"><span class="n">${esc(e.number)}</span><span class="nm">${esc(e.name)}</span></div>`;

  function startDraw(cur, animate) {
    $("idle").hidden = true;
    $("draw").hidden = false;
    $("winner").hidden = true;
    $("drawKicker").textContent = cur.prize ? "Drawing for" : "Drawing a ticket";
    $("drawPrize").textContent = cur.prize ? cur.prize.name : "The winner picks a prize";
    const reel = $("reel"), strip = $("strip");
    reel.classList.remove("landed");

    // Fillers from the sample (repeat if the pool is small), then the winner, then two more.
    const pool = cur.reel.length ? cur.reel : [{ number: "", name: "" }];
    const pick = (i) => pool[(i * 7 + Math.floor(Math.random() * pool.length)) % pool.length];
    const rows = Array.from({ length: FILLER }, (_, i) => pick(i));
    const winIndex = rows.length;
    rows.push(cur.winner, pick(1), pick(2));
    strip.innerHTML = rows.map((e, i) => rowHTML(e, i === winIndex)).join("");

    const rowH = strip.firstElementChild.getBoundingClientRect().height;
    const target = -(winIndex - 2) * rowH; // winner sits in the middle (3rd) row
    strip.style.transition = "none";
    strip.classList.remove("spinning");

    if (!animate) {
      strip.style.transform = `translateY(${target}px)`;
      land(cur, false);
      return;
    }
    spinning = true;
    renderPrizes();
    strip.style.transform = "translateY(0)";
    strip.getBoundingClientRect(); // commit the start position
    strip.classList.add("spinning");
    strip.style.transition = `transform ${SPIN_MS}ms cubic-bezier(0.12, 0.8, 0.18, 1)`;
    strip.style.transform = `translateY(${target}px)`;
    setTimeout(() => strip.classList.remove("spinning"), SPIN_MS * 0.55);
    tickSound(strip, rowH);
    setTimeout(() => { spinning = false; land(cur, true); }, SPIN_MS + 150);
  }

  function land(cur, celebrate) {
    shownPrize = cur.prize?.id || null;
    $("reel").classList.add("landed");
    $("drawKicker").textContent = !cur.choice ? "Winner of" : cur.prize ? "Winner chose" : "We have a winner";
    $("drawPrize").textContent = cur.prize ? cur.prize.name : `${data.available} prize${data.available === 1 ? "" : "s"} to choose from`;
    $("winnerName").textContent = cur.winner.name;
    $("winnerSub").innerHTML = `Ticket <b>${esc(cur.winner.number)}</b>${cur.winner.source === "participant" ? " · race participant entry" : ""}` +
      (cur.choice ? (cur.prize ? `<span class="chose">🎁 ${esc(cur.prize.name)}</span>` : `<span class="ask">Come up and choose from the prizes on the table</span>`) : "");
    $("winner").hidden = false;
    renderPrizes();
    if (celebrate) { confetti(); fanfare(); }
    // If staff moved on while we were spinning, catch up now.
    if (data && data.current?.drawId !== cur.drawId) render();
  }

  /* ---------------- Sound (plays once someone has clicked or pressed a key on this screen) ---------------- */
  let audio = null;
  let soundOn = true;
  try { soundOn = localStorage.getItem("raffleSound") !== "off"; } catch {}
  const setSoundBtn = () => { $("soundBtn").textContent = soundOn ? "🔊 Sound on" : "🔇 Sound off"; };
  setSoundBtn();
  function ensureAudio() {
    try { audio ??= new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === "suspended") audio.resume(); } catch {}
  }
  addEventListener("pointerdown", ensureAudio);
  addEventListener("keydown", ensureAudio);
  function beep(freq, at, dur, vol = 0.06, type = "square") {
    if (!audio || !soundOn || audio.state !== "running") return;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, at); g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(audio.destination); o.start(at); o.stop(at + dur + 0.02);
  }
  function tickSound(strip, rowH) {
    if (!audio || !soundOn) return;
    let last = 0;
    const t0 = performance.now();
    const step = () => {
      const m = new DOMMatrixReadOnly(getComputedStyle(strip).transform);
      const idx = Math.floor(-m.m42 / rowH);
      if (idx !== last) { last = idx; beep(1400, audio.currentTime, 0.03, 0.035); }
      if (performance.now() - t0 < SPIN_MS) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function fanfare() {
    if (!audio) return;
    const t = audio.currentTime;
    [[523, 0], [659, 0.12], [784, 0.24], [1047, 0.38]].forEach(([f, d]) => beep(f, t + d, 0.5, 0.08, "triangle"));
  }
  $("soundBtn").onclick = () => { soundOn = !soundOn; try { localStorage.setItem("raffleSound", soundOn ? "on" : "off"); } catch {} setSoundBtn(); };

  /* ---------------- Confetti ---------------- */
  function confetti() {
    const cv = $("confetti"), ctx = cv.getContext("2d");
    const W = (cv.width = innerWidth * devicePixelRatio), H = (cv.height = innerHeight * devicePixelRatio);
    const colors = ["#f2c14e", "#ffd987", "#39d98a", "#6fa8ff", "#ff8a3d", "#ff5a6a", "#f4f1ea"];
    const s = devicePixelRatio;
    const parts = Array.from({ length: 220 }, (_, i) => {
      const left = i % 2 === 0;
      return { x: left ? 0 : W, y: H * 0.75, vx: (left ? 1 : -1) * (6 + Math.random() * 12) * s, vy: -(12 + Math.random() * 16) * s, r: (4 + Math.random() * 6) * s, c: colors[i % colors.length], a: Math.random() * 6, va: (Math.random() - 0.5) * 0.4 };
    });
    const t0 = performance.now();
    (function frame(t) {
      ctx.clearRect(0, 0, W, H);
      for (const p of parts) {
        p.vy += 0.42 * s; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.a += p.va;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c; ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); ctx.restore();
      }
      if (t - t0 < 5000) requestAnimationFrame(frame); else ctx.clearRect(0, 0, W, H);
    })(t0);
  }

  /* ---------------- Chrome ---------------- */
  function toggleFs() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  }
  $("fsBtn").addEventListener("click", toggleFs);
  addEventListener("keydown", (e) => {
    if (e.key === "f" || e.key === "F") toggleFs();
    if (e.key === "s" || e.key === "S") $("soundBtn").click();
  });
  let idleT;
  const wake = () => { document.body.classList.remove("idle"); clearTimeout(idleT); idleT = setTimeout(() => document.body.classList.add("idle"), 3000); };
  addEventListener("mousemove", wake);
  wake();

  poll();
  setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
})();
