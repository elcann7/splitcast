(() => {
  "use strict";

  // Set this once the repository exists. Every GitHub link on the page follows it.
  const REPO = "elcann7/splitcast";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const repoUrl = `https://github.com/${REPO}`;
  $$("[data-repo]").forEach((a) => (a.href = repoUrl));
  $$("[data-repo-url]").forEach((s) => (s.textContent = repoUrl));
  $$("[data-release]").forEach((a) => (a.href = `${repoUrl}/releases/latest`));

  /* headline: split into words that blur in one after another */
  const head = $("#headline");
  if (head) {
    let i = 0;
    head.innerHTML = head.innerHTML
      .split(/(<br\s*\/?>)/i)
      .map((part) =>
        /^<br/i.test(part)
          ? part
          : part.split(" ").filter(Boolean).map((w) => `<span class="w" style="--i:${i++}">${w}</span>`).join(" "),
      )
      .join("");
  }

  /* nav gets a background once you scroll */
  const nav = $("#nav");
  const onScroll = () => nav.classList.toggle("solid", scrollY > 24);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* shared pointer position (page coordinates) for the canvas effects */
  const pointer = { x: -9999, y: -9999 };
  addEventListener("pointermove", (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true });

  /* ---------- dot grid (hero): dots are pushed away from the cursor and warm up near it ---------- */
  function dotGrid(canvas) {
    const ctx = canvas.getContext("2d");
    const GAP = 28, R = 1.4, RADIUS = 150, PUSH = 26;
    let w = 0, h = 0, dpr = 1, dots = [], running = false, raf = 0;
    const base = [58, 58, 62], hot = [233, 162, 59];
    const resize = () => {
      dpr = Math.min(devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      w = r.width; h = r.height;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dots = [];
      for (let y = GAP / 2; y < h; y += GAP) for (let x = GAP / 2; x < w; x += GAP) dots.push({ x, y, ox: 0, oy: 0, vx: 0, vy: 0 });
      if (reduce) draw();
    };
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      const r = canvas.getBoundingClientRect();
      const px = pointer.x - r.left, py = pointer.y - r.top;
      for (const d of dots) {
        const dx = d.x + d.ox - px, dy = d.y + d.oy - py;
        const dist = Math.hypot(dx, dy);
        let t = 0;
        if (!reduce && dist < RADIUS) {
          t = 1 - dist / RADIUS;
          const f = t * PUSH / (dist || 1);
          d.vx += dx * f * 0.02; d.vy += dy * f * 0.02;
        }
        d.vx += -d.ox * 0.06; d.vy += -d.oy * 0.06;
        d.vx *= 0.82; d.vy *= 0.82;
        d.ox += d.vx; d.oy += d.vy;
        const c = base.map((b, i) => Math.round(b + (hot[i] - b) * t));
        ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
        ctx.beginPath();
        ctx.arc(d.x + d.ox, d.y + d.oy, R + t * 1.4, 0, 6.2832);
        ctx.fill();
      }
    };
    const loop = () => { draw(); raf = requestAnimationFrame(loop); };
    new ResizeObserver(resize).observe(canvas);
    new IntersectionObserver(([e]) => {
      if (reduce) return;
      if (e.isIntersecting && !running) { running = true; loop(); }
      else if (!e.isIntersecting && running) { running = false; cancelAnimationFrame(raf); }
    }).observe(canvas);
    resize();
  }

  /* ---------- squares (closing section): a grid where cells light up under the cursor and fade out ---------- */
  function squares(canvas) {
    const ctx = canvas.getContext("2d");
    const S = 44;
    let w = 0, h = 0, dpr = 1, cols = 0, rows = 0, lit = new Map(), running = false, raf = 0;
    const resize = () => {
      dpr = Math.min(devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      w = r.width; h = r.height; cols = Math.ceil(w / S); rows = Math.ceil(h / S);
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      const r = canvas.getBoundingClientRect();
      const cx = Math.floor((pointer.x - r.left) / S), cy = Math.floor((pointer.y - r.top) / S);
      if (cx >= 0 && cy >= 0 && cx < cols && cy < rows) lit.set(cy * cols + cx, 1);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#232326";
      for (let x = 0; x <= cols; x++) { ctx.beginPath(); ctx.moveTo(x * S + .5, 0); ctx.lineTo(x * S + .5, h); ctx.stroke(); }
      for (let y = 0; y <= rows; y++) { ctx.beginPath(); ctx.moveTo(0, y * S + .5); ctx.lineTo(w, y * S + .5); ctx.stroke(); }
      for (const [k, a] of lit) {
        ctx.fillStyle = `rgba(233,162,59,${a * 0.22})`;
        ctx.fillRect((k % cols) * S + 1, Math.floor(k / cols) * S + 1, S - 1, S - 1);
        const n = a - 0.018;
        if (n <= 0) lit.delete(k); else lit.set(k, n);
      }
    };
    const loop = () => { draw(); raf = requestAnimationFrame(loop); };
    new ResizeObserver(() => { resize(); if (reduce) draw(); }).observe(canvas);
    new IntersectionObserver(([e]) => {
      if (reduce) return;
      if (e.isIntersecting && !running) { running = true; loop(); }
      else if (!e.isIntersecting && running) { running = false; cancelAnimationFrame(raf); }
    }).observe(canvas);
    resize();
    if (reduce) draw();
  }
  dotGrid($("#dots"));
  squares($("#squares"));

  /* ---------- reveal on scroll ---------- */
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      io.unobserve(e.target);
    }
  }, { threshold: 0.15, rootMargin: "0px 0px -6% 0px" });
  $$(".reveal").forEach((el) => io.observe(el));

  /* ---------- small scroll-triggered effects ---------- */
  const once = (el, fn, threshold = 0.4) => {
    if (!el) return;
    new IntersectionObserver(([e], o) => { if (e.isIntersecting) { fn(); o.disconnect(); } }, { threshold }).observe(el);
  };
  const eps = $("#eps");
  $$("#eps .bar i").forEach((el, i) => el.style.setProperty("--k", i));
  once(eps, () => eps.classList.add("lit"));
  once($("#speed"), () => $$("#speed i").forEach((i) => (i.style.width = i.dataset.w + "%")));
  const log = $("#log");
  $$("#log span").forEach((el, i) => el.style.setProperty("--k", i));
  once(log, () => log.classList.add("in"));

  const fmt = (n) => String(Math.round(n));
  $$(".count").forEach((el) => {
    const to = +el.dataset.to, suf = el.dataset.suffix || "";
    once(el, () => {
      if (reduce || to === 0) { el.textContent = fmt(to) + suf; return; }
      const t0 = performance.now(), dur = 1400;
      const step = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        el.textContent = fmt(to * (1 - Math.pow(1 - p, 3))) + suf;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }, 0.6);
  });

  /* spotlight cards follow the pointer */
  $$(".spot").forEach((c) => c.addEventListener("pointermove", (e) => {
    const r = c.getBoundingClientRect();
    c.style.setProperty("--mx", e.clientX - r.left + "px");
    c.style.setProperty("--my", e.clientY - r.top + "px");
  }));

  /* ---------- hero window: tilt + character switcher ---------- */
  const stage = $("#stage"), win = $("#win");
  if (stage && !reduce && matchMedia("(hover: hover)").matches) {
    stage.addEventListener("pointermove", (e) => {
      const r = stage.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      win.style.transform = `rotateY(${x * 5}deg) rotateX(${-y * 4}deg)`;
    });
    stage.addEventListener("pointerleave", () => (win.style.transform = ""));
  }

  const imgs = [$("#shotA"), $("#shotB")];
  const srcs = [1, 2, 3, 4].map((n) => `shots/char-${n}.webp`);
  srcs.forEach((s) => { const i = new Image(); i.src = s; });
  let front = 0, current = 1, userTouched = false;
  const show = (n) => {
    if (n === current) return;
    const next = imgs[1 - front], prev = imgs[front];
    next.src = srcs[n - 1];
    const go = () => { next.classList.add("on"); prev.classList.remove("on"); front = 1 - front; current = n; };
    next.complete ? go() : (next.onload = go);
  };
  $$(".hot").forEach((b) => b.addEventListener("click", () => {
    userTouched = true;
    $("#hint").classList.add("gone");
    show(+b.dataset.shot);
  }));

  // a gentle demo cycle until the visitor takes over
  let cycle = 0;
  once($("#win"), () => {
    if (reduce) return;
    const t = setInterval(() => {
      if (userTouched) return clearInterval(t);
      cycle = cycle % 4 + 1;
      show(cycle === current ? cycle % 4 + 1 : cycle);
    }, 2800);
  }, 0.5);


  /* ---------- languages card: flags light up one by one; hover shows the name ---------- */
  const flags = $$("#flags .flag"), flagName = $("#flagName");
  if (flags.length) {
    let i = 0, hovering = false;
    const light = (n) => { flags.forEach((f, k) => f.classList.toggle("on", k === n)); flagName.textContent = flags[n].dataset.name; };
    flags.forEach((f, k) => {
      f.addEventListener("pointerenter", () => { hovering = true; i = k; light(k); });
      f.addEventListener("pointerleave", () => (hovering = false));
      f.addEventListener("focus", () => light(k));
    });
    light(0);
    if (!reduce) setInterval(() => { if (!hovering) { i = (i + 1) % flags.length; light(i); } }, 1500);
  }
  /* ---------- copy button ---------- */
  const copy = $("#copy");
  copy?.addEventListener("click", async () => {
    const text = $("#code pre").innerText.replace(/^\s*#.*$/gm, "").replace(/\n{2,}/g, "\n").trim();
    try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked: leave the text selectable */ }
    copy.textContent = "copied";
    copy.classList.add("done");
    setTimeout(() => { copy.textContent = "copy"; copy.classList.remove("done"); }, 1600);
  });
})();



