/* Raffle screen. Polls /api/raffle; when staff draw a winner, the winning ticket number appears on
 * digit drums: the year prefix (always the same) locks in quickly, then each of the last four digits
 * spins a little longer than the one before. Names are never shown here, only on the staff page. */
(() => {
  const POLL_MS = 1500;
  // When each drum stops (ms after the draw starts). Prefix digits are quick; the last four build suspense.
  const PREFIX_STOPS = [900, 1150, 1400, 1650];
  const KEY_STOPS = [3400, 5300, 7500, 10400];
  const SPIN_MS = KEY_STOPS[KEY_STOPS.length - 1];
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
            <span class="pw">${showWinner ? "Ticket " + esc(p.winner.number) : p.id === nowId ? (spinning ? "Drawing now…" : "Up next") : avail && choosingNow ? "Available to choose" : esc(p.detail || "")}</span>
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

  /* ---------------- Digit drums ---------------- */
  const DIGITS = "0123456789", LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let drumTimers = [];
  // How many characters at the start are the shared prefix (e.g. "2026" of 20260427).
  const prefixLen = (num) => { const p = data?.prefix || ""; return p && num.startsWith(p) && num.length > p.length ? p.length : Math.max(0, num.length - 4); };

  function buildDrums(num) {
    const pl = prefixLen(num);
    $("drums").innerHTML = [...num].map((ch, i) => `${i === pl && pl ? '<div class="drum-gap"></div>' : ""}<div class="drum${i >= pl ? " key" : " pre"}" data-i="${i}"><div class="drum-strip"></div></div>`).join("");
    return pl;
  }

  // Fill a drum's strip with characters that end on `ch`; `turns` sets how far it travels.
  function stripFor(ch, turns) {
    const set = /\d/.test(ch) ? DIGITS : /[A-Z]/i.test(ch) ? LETTERS : null;
    if (!set) return [ch];
    const start = Math.floor(Math.random() * set.length);
    const out = [];
    for (let k = 0; k < turns * set.length; k++) out.push(set[(start + k) % set.length]);
    // Land exactly on the target (plus one below it, so the strip never shows empty space).
    while (out[out.length - 1] === ch) out.pop();
    let k = set.indexOf(out[out.length - 1]);
    do { k = (k + 1) % set.length; out.push(set[k]); } while (set[k] !== ch.toUpperCase());
    out.push(set[(k + 1) % set.length]);
    return out;
  }

  function startDraw(cur, animate) {
    drumTimers.forEach(clearTimeout); drumTimers = [];
    $("idle").hidden = true;
    $("draw").hidden = false;
    $("winner").hidden = true;
    $("drawKicker").textContent = cur.prize ? "Drawing for" : "Drawing a ticket";
    $("drawPrize").textContent = cur.prize ? cur.prize.name : "The winner picks a prize";
    $("drumLbl").textContent = "Winning ticket number";
    $("drumStage").style.setProperty("--heat", 0);
    const num = String(cur.winner.number || "").toUpperCase();
    const pl = buildDrums(num);
    $("drums").classList.remove("done");
    const drums = [...$("drums").querySelectorAll(".drum")];
    const stops = drums.map((_, i) => (i < pl ? PREFIX_STOPS[i] ?? PREFIX_STOPS[PREFIX_STOPS.length - 1] + 250 * (i - 3) : KEY_STOPS[Math.max(0, KEY_STOPS.length - (num.length - i))] ?? KEY_STOPS[0]));
    const dh = () => drums[0].getBoundingClientRect().height;

    drums.forEach((d, i) => {
      const strip = d.querySelector(".drum-strip");
      // Longer stop = more turns, so every drum keeps a similar, fast speed until it slows down.
      const chars = animate ? stripFor(num[i], Math.max(2, Math.round(stops[i] / 450))) : [num[i], " "];
      strip.innerHTML = chars.map((c) => `<span>${esc(c)}</span>`).join("");
      const target = -(chars.length - 2) * dh();
      if (!animate) { strip.style.transform = `translateY(${target}px)`; d.classList.add("landed"); return; }
      strip.style.transition = "none";
      strip.style.transform = "translateY(0)";
      strip.getBoundingClientRect();
      d.classList.add("spinning");
      // Prefix drums snap in; key drums ease out slowly so the last digits crawl into place.
      const ease = i < pl ? "cubic-bezier(0.2, 0.7, 0.25, 1)" : i === drums.length - 1 ? "cubic-bezier(0.1, 0.62, 0.08, 1)" : "cubic-bezier(0.14, 0.7, 0.16, 1)";
      strip.style.transition = `transform ${stops[i]}ms ${ease}`;
      strip.style.transform = `translateY(${target}px)`;
      drumTimers.push(setTimeout(() => { d.classList.remove("spinning"); d.classList.add("slow"); }, stops[i] * 0.6));
      drumTimers.push(setTimeout(() => {
        d.classList.remove("slow", "spinning", "next");
        d.classList.add("landed");
        const nextKey = drums.find((x) => !x.classList.contains("landed") && x.classList.contains("key"));
        if (i >= pl - 1 && nextKey) nextKey.classList.add("next");
        const landedKeys = drums.filter((x) => x.classList.contains("key") && x.classList.contains("landed")).length;
        $("drumStage").style.setProperty("--heat", (0.08 + 0.07 * landedKeys).toFixed(2));
        clunk(i >= pl, i === drums.length - 1);
      }, stops[i]));
    });

    if (!animate) { land(cur, false); return; }
    spinning = true;
    renderPrizes();
    tickSound(drums, stops, dh());
    drumTimers.push(setTimeout(() => { spinning = false; land(cur, true); }, SPIN_MS + 400));
  }

  function land(cur, celebrate) {
    shownPrize = cur.prize?.id || null;
    $("drums").classList.add("done");
    $("drumStage").style.setProperty("--heat", 0.32);
    $("drawKicker").textContent = !cur.choice ? "Winner of" : cur.prize ? "Winner chose" : "We have a winner";
    $("drawPrize").textContent = cur.prize ? cur.prize.name : `${data.available} prize${data.available === 1 ? "" : "s"} to choose from`;
    $("winnerName").textContent = "Check your tickets!";
    $("winnerSub").innerHTML = (cur.winner.source === "participant" ? "Race participant entry · " : "") + "Bring your slip or text to the raffle table" +
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
  // A tick each time the next drum still spinning passes a digit.
  function tickSound(drums, stops, h) {
    if (!audio || !soundOn) return;
    const t0 = performance.now();
    const last = new Map();
    const step = () => {
      const t = performance.now() - t0;
      const i = stops.findIndex((st, k) => t < st && !drums[k].classList.contains("landed"));
      if (i >= 0) {
        const m = new DOMMatrixReadOnly(getComputedStyle(drums[i].querySelector(".drum-strip")).transform);
        const idx = Math.floor(-m.m42 / h);
        if (idx !== last.get(i)) { last.set(i, idx); beep(1300 + i * 40, audio.currentTime, 0.025, 0.03); }
      }
      if (t < SPIN_MS) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function clunk(key, final) {
    if (!audio) return;
    const t = audio.currentTime;
    beep(key ? (final ? 220 : 330) : 520, t, key ? 0.22 : 0.08, key ? 0.12 : 0.05, "triangle");
    if (key) beep(key && final ? 110 : 165, t, 0.3, 0.08, "sine");
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
