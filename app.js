(() => {
  'use strict';

  /* ───────────────────────── helpers ───────────────────────── */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const pad2 = (n) => String(n).padStart(2, '0');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const fmtTime = (total) => {
    const s = Math.max(0, Math.round(total));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`;
  };

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage disabled */ }
  }

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < String(str).length; i++) {
      h ^= String(str).charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a += 0x6d2b79f5;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const pick = (list, r) => list[Math.floor(r() * list.length) % list.length];

  function safeUrl(raw) {
    if (!raw) return null;
    const withProtocol = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
    try { return new URL(withProtocol); } catch { return null; }
  }

  function detectSource(raw) {
    const url = safeUrl(raw);
    if (!url) return { label: 'Link', known: false };
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'youtu.be' || /(^|\.)youtube\.com$/.test(host)) return { label: 'YouTube', known: true };
    if (/(^|\.)twitch\.tv$/.test(host)) return { label: 'Twitch', known: true };
    if (/(^|\.)kick\.com$/.test(host)) return { label: 'Kick', known: true };
    return { label: 'Link', known: false };
  }

  const KEY = {
    settings: 'neonclip.settings.v1',
    library: 'neonclip.library.v1',
    watch: 'neonclip.watchlist.v1',
  };

  const DEFAULT_REGION = { x: 0.03, y: 0.62, w: 0.28, h: 0.32 };

  function cleanRegion(region) {
    const reg = region || {};
    const x = clamp(Number(reg.x) || 0, 0, 0.95);
    const y = clamp(Number(reg.y) || 0, 0, 0.95);
    const w = clamp(Number(reg.w) || DEFAULT_REGION.w, 0.05, 1 - x);
    const h = clamp(Number(reg.h) || DEFAULT_REGION.h, 0.05, 1 - y);
    return { x, y, w, h };
  }

  const PRESETS = {
    reels: { label: 'Reels', max: 90, note: 'Up to 90s keeps Reels happy. Guides: 14% top, 22% bottom.' },
    tiktok: { label: 'TikTok', max: 180, note: 'Up to 3 min on web. Guides: 12% top, 18% bottom.' },
    shorts: { label: 'Shorts', max: 60, note: '60s is the safest Shorts length. Guides: 16% top, 24% bottom.' },
    custom: { label: 'Custom', max: 120, note: 'Your own window — no platform guides.' },
  };

  const DEFAULTS = {
    captions: true,
    captionMode: 'burn',
    minLen: 30,
    maxLen: 80,
    count: 3,
    layout: 'auto',
    preset: 'reels',
    captionStyle: 'gta',
    language: 'en',
    autoClip: true,
    sensitivity: 2.5,
    preroll: 24,
    facecam: { ...DEFAULT_REGION },
  };

  const stored = readJSON(KEY.settings, {});

  const state = {
    settings: Object.assign({}, DEFAULTS, stored, {
      facecam: Object.assign({}, DEFAULT_REGION, stored.facecam || {}),
    }),
    library: readJSON(KEY.library, []),
    watch: readJSON(KEY.watch, []),
    clips: [],
    liveClips: [],
    file: null,
    job: null,
    view: 'studio',
    engine: { mode: 'demo', health: null },
    thumb: '',
  };

  const persistSettings = () => writeJSON(KEY.settings, state.settings);
  const persistLibrary = () => writeJSON(KEY.library, state.library);

  /* ───────────────────────── content pools ───────────────────────── */
  const TITLE_POOL = [
    { title: 'He called it 10 seconds before it happened', hook: 'Chat went from joking to screaming in one frame.' },
    { title: 'The clutch nobody saw coming', hook: 'Down to 12 HP with one mag left — and he still took it.' },
    { title: 'This is the clip that broke the stream', hook: 'The reaction is better than the play.' },
    { title: 'Zero hesitation, instant regret', hook: 'A four-second decision that flipped the whole lobby.' },
    { title: 'Chat told him to do it. He did it.', hook: 'They dared him on stream. He committed.' },
    { title: 'The comeback starts right here', hook: 'Three rounds left and one shot at redemption.' },
    { title: 'Nobody expected that ending', hook: 'Perfect setup, perfect execution, silent chat.' },
    { title: 'One tap, whole lobby gone', hook: 'Cleanest flick of the night.' },
    { title: 'He spent 20 minutes setting this up', hook: 'The payoff is worth every single second.' },
    { title: 'The moment the run went sideways', hook: 'It was going so well — then this happened.' },
    { title: 'Chat lost it right here', hook: 'Forty messages in two seconds. Fair.' },
    { title: 'POV: the plan actually works', hook: 'Everything lined up for once.' },
  ];

  const PHRASES = [
    'okay listen, this is the part I was talking about',
    'there is no way that just happened on stream',
    'chat I need you to watch this back twice',
    'he had one shot and he took it perfectly',
    'this is why we do the setup first',
    'every single person in the lobby stopped moving',
    'we were so close to losing the whole run',
    'and that is how you flip a losing game',
    'I told you this was going to work',
    'look at the timer, two seconds left',
  ];

  const CAPTION_STYLES = {
    gta: { font: '"Arial Black", Impact, system-ui, sans-serif', weight: 900, size: 44, color: '#b7ff2e', stroke: '#06120a', strokeWidth: 9, glow: 'rgba(183,255,46,.5)' },
    impact: { font: 'Impact, "Arial Black", system-ui, sans-serif', weight: 700, size: 48, color: '#ffffff', stroke: '#000000', strokeWidth: 9 },
    clean: { font: 'Inter, system-ui, sans-serif', weight: 700, size: 31, color: '#ffffff', box: 'rgba(8,10,16,.74)' },
    hormozi: { font: 'Inter, system-ui, sans-serif', weight: 900, size: 29, color: '#08120a', box: '#c6ff3d' },
    mrbeast: { font: 'Impact, "Arial Black", system-ui, sans-serif', weight: 700, size: 46, color: '#ffe14d', stroke: '#1a0f00', strokeWidth: 9 },
  };

  /* ───────────────────────── notifications ───────────────────────── */
  const notifications = [];
  let notifSeq = 0;

  function renderNotifCount() {
    const bell = $('#notif-bell');
    const count = $('#notif-count');
    if (!bell || !count) return;
    const unread = notifications.filter((note) => !note.read).length;
    count.hidden = unread === 0;
    count.textContent = String(unread > 9 ? '9+' : unread);
    bell.classList.toggle('has-news', unread > 0);
  }

  function renderNotifList() {
    const list = $('#notif-list');
    if (!list) return;
    list.innerHTML = '';
    notifications.slice(0, 30).forEach((note) => {
      const li = document.createElement('li');
      li.dataset.type = note.type;
      const dot = document.createElement('i');
      const body = document.createElement('div');
      const title = document.createElement('b');
      title.textContent = note.title;
      body.appendChild(title);
      if (note.text) {
        const text = document.createElement('p');
        text.textContent = note.text;
        body.appendChild(text);
      }
      const time = document.createElement('small');
      time.textContent = new Date(note.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      body.appendChild(time);
      li.append(dot, body);
      list.appendChild(li);
    });
    const empty = $('#notif-empty');
    if (empty) empty.hidden = notifications.length > 0;
    renderNotifCount();
  }

  function pushToast(note) {
    const box = $('#toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.dataset.type = note.type;
    const body = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = note.title;
    body.appendChild(title);
    if (note.text) {
      const text = document.createElement('span');
      text.textContent = note.text;
      body.appendChild(text);
    }
    el.appendChild(body);
    box.appendChild(el);
    while (box.children.length > 3) box.firstElementChild.remove();
    setTimeout(() => el.remove(), 5200);
  }

  /* One call site for every banner + the bell list. */
  function notify(title, text = '', opts = {}) {
    const note = { id: `n${++notifSeq}`, title, text, type: opts.type || 'info', at: Date.now(), read: false };
    notifications.unshift(note);
    if (notifications.length > 40) notifications.pop();
    if (!opts.quiet) pushToast(note);
    renderNotifList();
    return note;
  }

  const TOAST_TITLES = {
    success: 'Done', error: 'Something went wrong', clip: 'Clip ready',
    approve: 'Needs your OK', info: 'SliceEngine',
  };

  function toast(message, type = 'info') {
    notify(TOAST_TITLES[type] || 'SliceEngine', message, { type });
  }

  function toggleNotifPanel(force) {
    const panel = $('#notif-panel');
    const bell = $('#notif-bell');
    if (!panel || !bell) return;
    const open = typeof force === 'boolean' ? force : panel.hidden;
    panel.hidden = !open;
    bell.setAttribute('aria-expanded', String(open));
    if (open) {
      notifications.forEach((note) => { note.read = true; });
      renderNotifCount();
      renderNotifList();
    }
  }

  /* ───────────────────────── canvas poster ───────────────────────── */
  function roundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  /* The virtual 16:9 source frame. The editor and the poster both paint it, so
     whatever box you drag is exactly what gets cropped into the clip. */
  const SRC_W = 1280;
  const SRC_H = 720;
  const SRC_CAM = { x: 0.035, y: 0.60, w: 0.265, h: 0.33 };

  function paintSource(ctx, W, H, seed) {
    const r = rng((seed || 7) >>> 0);

    const sky = ctx.createLinearGradient(0, 0, W * 0.5, H);
    sky.addColorStop(0, 'hsl(206 46% 24%)');
    sky.addColorStop(0.55, 'hsl(215 44% 15%)');
    sky.addColorStop(1, 'hsl(222 40% 9%)');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(120,190,255,.13)';
    for (let i = 0; i < 7; i++) {
      const bw = W * (0.05 + r() * 0.09);
      const bh = H * (0.08 + r() * 0.22);
      ctx.fillRect(W * r() * 0.93, H * 0.46 - bh, bw, bh);
    }

    const horizon = H * 0.46;
    ctx.strokeStyle = 'rgba(255,255,255,.10)';
    ctx.lineWidth = Math.max(1, W / 900);
    for (let i = -8; i <= 8; i++) {
      ctx.beginPath();
      ctx.moveTo(W / 2 + i * W * 0.02, horizon);
      ctx.lineTo(W / 2 + i * W * 0.16, H);
      ctx.stroke();
    }
    for (let i = 1; i <= 6; i++) {
      const y = horizon + Math.pow(i / 6, 2.6) * (H - horizon) * 0.9;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(6,10,18,.55)';
    roundRect(ctx, W * 0.02, H * 0.05, W * 0.15, H * 0.06, W * 0.008);
    ctx.fill();
    roundRect(ctx, W * 0.78, H * 0.05, W * 0.2, H * 0.06, W * 0.008);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.font = `600 ${Math.max(9, Math.round(H * 0.026))}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('WAVE 3 · 12 LEFT', W * 0.035, H * 0.08);
    ctx.textAlign = 'right';
    ctx.fillText('04:12', W * 0.96, H * 0.08);

    const cx = W * 0.52;
    const cy = H * 0.58;
    ctx.strokeStyle = 'rgba(165,255,62,.45)';
    ctx.lineWidth = Math.max(1, W / 700);
    ctx.beginPath();
    ctx.arc(cx, cy, H * 0.05, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(165,255,62,.85)';
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, H * 0.008), 0, Math.PI * 2);
    ctx.fill();

    // the streamer's webcam, fixed in the bottom-left of the frame
    const camX = SRC_CAM.x * W;
    const camY = SRC_CAM.y * H;
    const camW = SRC_CAM.w * W;
    const camH = SRC_CAM.h * H;
    const camHue = 16 + Math.floor(r() * 40);

    ctx.save();
    roundRect(ctx, camX, camY, camW, camH, W * 0.012);
    ctx.clip();
    const camGrad = ctx.createLinearGradient(camX, camY, camX + camW, camY + camH);
    camGrad.addColorStop(0, `hsl(${camHue} 32% 30%)`);
    camGrad.addColorStop(1, `hsl(${camHue + 18} 26% 12%)`);
    ctx.fillStyle = camGrad;
    ctx.fillRect(camX, camY, camW, camH);
    ctx.fillStyle = 'rgba(0,0,0,.3)';
    ctx.beginPath();
    ctx.arc(camX + camW * 0.5, camY + camH * 0.44, camH * 0.19, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(camX + camW * 0.5, camY + camH * 1.04, camW * 0.34, camH * 0.36, 0, Math.PI, 0);
    ctx.fill();
    const rim = ctx.createLinearGradient(camX, camY, camX + camW, camY + camH);
    rim.addColorStop(0, 'rgba(120,220,255,.24)');
    rim.addColorStop(0.6, 'rgba(0,0,0,0)');
    ctx.fillStyle = rim;
    ctx.fillRect(camX, camY, camW, camH);
    ctx.fillStyle = 'rgba(8,10,16,.72)';
    roundRect(ctx, camX + camW * 0.06, camY + camH * 0.84, camW * 0.26, camH * 0.13, camH * 0.05);
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundRect(ctx, camX, camY, camW, camH, W * 0.012);
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.lineWidth = Math.max(1, W / 640);
    ctx.stroke();
    ctx.restore();
  }

  function drawFacecamRegion(ctx, x, y, w, h, region, seed, radius = 16) {
    const reg = region || state.settings.facecam || DEFAULT_REGION;
    const rx = clamp(Number(reg.x) || 0, 0, 0.9) * SRC_W;
    const ry = clamp(Number(reg.y) || 0, 0, 0.9) * SRC_H;
    const rw = Math.max(40, clamp(Number(reg.w) || 0.28, 0.05, 1) * SRC_W);
    const rh = Math.max(40, clamp(Number(reg.h) || 0.32, 0.05, 1) * SRC_H);
    const scale = Math.max(w / rw, h / rh);

    ctx.save();
    roundRect(ctx, x, y, w, h, radius);
    ctx.clip();
    ctx.translate(x + w / 2, y + h / 2);
    ctx.scale(scale, scale);
    ctx.translate(-(rx + rw / 2), -(ry + rh / 2));
    paintSource(ctx, SRC_W, SRC_H, seed);
    ctx.restore();

    ctx.save();
    roundRect(ctx, x, y, w, h, radius);
    ctx.strokeStyle = 'rgba(255,255,255,.2)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  function drawCaption(ctx, clip, W, H) {
    const st = CAPTION_STYLES[clip.style] || CAPTION_STYLES.gta;
    const text = String((clip.lines && clip.lines[0] && clip.lines[0].text) || clip.title || '');
    if (!text) return;

    const words = text.split(' ');
    const rows = [];
    let row = '';
    for (const word of words) {
      const next = row ? `${row} ${word}` : word;
      if (next.length > 17 && row) { rows.push(row); row = word; } else { row = next; }
    }
    if (row) rows.push(row);
    const shown = rows.slice(0, 2);

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${st.weight} ${st.size}px ${st.font}`;
    const cx = W / 2;
    const lineHeight = st.size * 1.22;
    const baseY = H * 0.715;

    shown.forEach((label, i) => {
      const y = baseY + (i - (shown.length - 1) / 2) * lineHeight;
      const content = label.toUpperCase();
      const width = ctx.measureText(content).width;

      if (st.box) {
        const bw = width + 32;
        const bh = st.size + 20;
        ctx.fillStyle = st.box;
        roundRect(ctx, cx - bw / 2, y - bh / 2, bw, bh, 9);
        ctx.fill();
      }
      if (st.stroke) {
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        ctx.lineWidth = st.strokeWidth;
        ctx.strokeStyle = st.stroke;
        ctx.strokeText(content, cx, y);
      }
      if (st.glow) {
        ctx.shadowColor = st.glow;
        ctx.shadowBlur = 16;
      }
      ctx.fillStyle = st.color;
      ctx.fillText(content, cx, y);
      ctx.shadowBlur = 0;
    });

    ctx.restore();
  }

  function drawPoster(canvas, clip) {
    const W = 540;
    const H = 960;
    if (canvas.width !== W) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const r = rng(clip.seed || hash(clip.id || 'clip'));
    const hue = typeof clip.hue === 'number' ? clip.hue : Math.floor(r() * 360);

    const bg = ctx.createLinearGradient(0, 0, W * 0.6, H);
    bg.addColorStop(0, `hsl(${hue} 52% 17%)`);
    bg.addColorStop(0.55, `hsl(${(hue + 32) % 360} 58% 10%)`);
    bg.addColorStop(1, `hsl(${(hue + 64) % 360} 62% 5%)`);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    for (let i = 0; i < 3; i++) {
      const cx = r() * W;
      const cy = H * (0.1 + r() * 0.55);
      const rad = 130 + r() * 190;
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      glow.addColorStop(0, `hsla(${(hue + 45 + i * 55) % 360}, 95%, 62%, ${0.26 - i * 0.06})`);
      glow.addColorStop(1, 'hsla(0,0%,0%,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.fill();
    }

    // abstract "gameplay" perspective grid
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    ctx.lineWidth = 1;
    const horizon = H * 0.5;
    for (let i = -6; i <= 6; i++) {
      ctx.beginPath();
      ctx.moveTo(W / 2 + i * 16, horizon);
      ctx.lineTo(W / 2 + i * 150, H);
      ctx.stroke();
    }
    for (let i = 1; i <= 5; i++) {
      const y = horizon + Math.pow(i / 5, 2.3) * (H - horizon) * 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.restore();

    const layout = clip.layout || 'auto';
    const region = clip.facecam || state.settings.facecam;
    if (layout === 'split') {
      const cover = Math.max(W / SRC_W, W / SRC_H);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, W);
      ctx.clip();
      ctx.translate(W / 2, W / 2);
      ctx.scale(cover, cover);
      ctx.translate(-SRC_W / 2, -SRC_H / 2);
      paintSource(ctx, SRC_W, SRC_H, clip.seed);
      ctx.restore();
      drawFacecamRegion(ctx, 0, W, W, H - W, region, clip.seed, 0);
    } else if (layout === 'facecam') {
      drawFacecamRegion(ctx, 24, 104, W - 48, H * 0.52, region, clip.seed);
    } else if (layout === 'gameplay') {
      drawFacecamRegion(ctx, 28, H - 400, 200, 186, region, clip.seed);
    } else if (layout === 'full') {
      const cover = Math.max(W / SRC_W, H / SRC_H);
      ctx.save();
      ctx.translate(W / 2, H / 2);
      ctx.scale(cover, cover);
      ctx.translate(-SRC_W / 2, -SRC_H / 2);
      paintSource(ctx, SRC_W, SRC_H, clip.seed);
      ctx.restore();
      const veil = ctx.createLinearGradient(0, 0, 0, H);
      veil.addColorStop(0, 'rgba(0,0,0,.44)');
      veil.addColorStop(0.3, 'rgba(0,0,0,0)');
      veil.addColorStop(0.72, 'rgba(0,0,0,0)');
      veil.addColorStop(1, 'rgba(0,0,0,.58)');
      ctx.fillStyle = veil;
      ctx.fillRect(0, 0, W, H);
    } else {
      drawFacecamRegion(ctx, 30, H - 356, 176, 166, region, clip.seed);
    }

    // top pills
    ctx.save();
    ctx.fillStyle = 'rgba(5,7,12,.62)';
    roundRect(ctx, 24, 26, 96, 32, 8);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.82)';
    ctx.font = '600 17px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${fmtTime(clip.start)}`, 38, 43);

    const score = String(clip.score || 0);
    ctx.font = '700 17px Inter, system-ui, sans-serif';
    const scoreW = ctx.measureText(score).width + 52;
    ctx.fillStyle = 'rgba(7,16,9,.72)';
    roundRect(ctx, W - 24 - scoreW, 26, scoreW, 32, 8);
    ctx.fill();
    ctx.fillStyle = '#b7ff2e';
    ctx.beginPath();
    ctx.arc(W - 24 - scoreW + 16, 42, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e9ffcb';
    ctx.fillText(score, W - 24 - scoreW + 28, 43);
    ctx.restore();

    if (state.settings.captions && state.settings.captionMode !== 'srt') drawCaption(ctx, clip, W, H);

    // bottom source strip
    ctx.save();
    const strip = ctx.createLinearGradient(0, H - 120, 0, H);
    strip.addColorStop(0, 'rgba(0,0,0,0)');
    strip.addColorStop(1, 'rgba(0,0,0,.72)');
    ctx.fillStyle = strip;
    ctx.fillRect(0, H - 120, W, 120);

    ctx.fillStyle = 'rgba(255,255,255,.6)';
    ctx.font = '500 15px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const label = String(clip.source || 'source').replace(/^https?:\/\//i, '').slice(0, 38);
    ctx.fillText(label, 26, H - 30);

    ctx.fillStyle = 'rgba(165,255,62,.9)';
    roundRect(ctx, 26, H - 20, 74, 3, 2);
    ctx.fill();
    ctx.restore();
  }

  /* ───────────────────────── clip data ───────────────────────── */
  function buildLines(r, length, t) {
    const phrase = pick(PHRASES, r);
    const words = phrase.split(' ');
    const cut = Math.ceil(words.length / 2);
    const first = words.slice(0, cut).join(' ');
    const second = words.slice(cut).join(' ') || t.hook;
    return [
      { at: 0.4, text: first },
      { at: Math.max(1, length * 0.42), text: second },
      { at: Math.max(2, length * 0.74), text: t.hook },
    ];
  }

  function makeClipData(source, index, extra = {}) {
    const seed = hash(`${source}|${index}|${extra.salt || 'studio'}|${extra.start ?? ''}`);
    const r = rng(seed);
    const minLen = state.settings.minLen;
    const maxLen = Math.max(state.settings.maxLen, minLen + 5);
    const length = Math.round(clamp(minLen + r() * (maxLen - minLen), 10, 180));
    const total = extra.total || 85 * 60;
    const start = typeof extra.start === 'number'
      ? Math.max(0, Math.round(extra.start))
      : Math.round(30 + r() * Math.max(30, total - length - 60));

    const t = pick(TITLE_POOL, r);

    return {
      id: `c${seed.toString(36)}${index}`,
      seed,
      hue: Math.floor(r() * 360),
      source,
      title: t.title,
      hook: t.hook,
      start,
      end: start + length,
      length,
      score: 77 + Math.floor(r() * 21),
      layout: state.settings.layout,
      style: state.settings.captionStyle,
      live: Boolean(extra.live),
      createdAt: Date.now(),
      lines: buildLines(r, length, t),
    };
  }

  const allClips = () => [...state.clips, ...state.liveClips, ...state.library];
  const findClip = (id) => allClips().find((clip) => clip.id === id);
  const isSaved = (id) => state.library.some((clip) => clip.id === id);

  /* ───────────────────────── clip cards ───────────────────────── */
  const ICONS = {
    bookmark: '<path d="M6 4.5h12a1 1 0 0 1 1 1v14l-7-4.2-7 4.2v-14a1 1 0 0 1 1-1z" stroke-linejoin="round"/>',
    doc: '<path d="M7 3.5h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z" stroke-linejoin="round"/><path d="M14 3.5v4h4" stroke-linejoin="round"/>',
    copy: '<rect x="9" y="9" width="10" height="11" rx="2"/><path d="M15 6.5V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h1.5"/>',
    trash: '<path d="M4.5 7h15M9.5 7V5.2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7M6.5 7l.9 11.9a1 1 0 0 0 1 .95h7.2a1 1 0 0 0 1-.95L17.5 7" stroke-linecap="round"/>',
  };

  function svg(paths) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${paths}</svg>`;
  }

  function labeledButton(label, icon, extraClass = '') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `icon-btn ${extraClass}`.trim();
    btn.innerHTML = `${svg(icon)}<span></span>`;
    btn.querySelector('span').textContent = label;
    return btn;
  }

  function iconButton(icon, title, extraClass = '') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `icon-btn sq ${extraClass}`.trim();
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.innerHTML = svg(icon);
    return btn;
  }

  function clipCard(clip, opts = {}) {
    const card = document.createElement('article');
    card.className = 'clip';
    card.dataset.id = clip.id;
    if (opts.delay) card.style.animationDelay = `${opts.delay}ms`;

    const media = document.createElement('div');
    media.className = 'clip-media';
    if (clip.file) {
      const video = document.createElement('video');
      video.src = clip.file;
      video.controls = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.setAttribute('aria-label', `Clip: ${clip.title}`);
      media.appendChild(video);
    } else {
      const canvas = document.createElement('canvas');
      canvas.dataset.clip = clip.id;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `Clip preview: ${clip.title}`);
      media.appendChild(canvas);
      drawPoster(canvas, clip);
    }
    if (clip.live) {
      const badge = document.createElement('span');
      badge.className = 'clip-badge';
      badge.textContent = 'Live';
      media.appendChild(badge);
    }
    card.appendChild(media);

    const body = document.createElement('div');
    body.className = 'clip-body';

    const top = document.createElement('div');
    top.className = 'clip-top';
    const score = document.createElement('span');
    score.className = 'clip-score';
    score.textContent = String(clip.score);
    const range = document.createElement('span');
    range.className = 'clip-range';
    range.textContent = `${fmtTime(clip.start)} – ${fmtTime(clip.end)}`;
    top.append(score, range);

    const title = document.createElement('h3');
    title.textContent = clip.title;
    const hook = document.createElement('p');
    hook.textContent = clip.hook;

    const actions = document.createElement('div');
    actions.className = 'clip-actions';

    const saved = isSaved(clip.id);
    const saveBtn = labeledButton(saved ? 'Saved' : 'Save', ICONS.bookmark, saved ? 'saved' : '');
    saveBtn.setAttribute('aria-pressed', String(saved));
    saveBtn.addEventListener('click', () => {
      toggleSave(clip);
      const nowSaved = isSaved(clip.id);
      saveBtn.classList.toggle('saved', nowSaved);
      saveBtn.querySelector('span').textContent = nowSaved ? 'Saved' : 'Save';
      saveBtn.setAttribute('aria-pressed', String(nowSaved));
    });

    const srtBtn = labeledButton('SRT', ICONS.doc, 'act-srt');
    srtBtn.title = 'Download caption file';
    srtBtn.addEventListener('click', () => {
      if (!state.settings.captions) { toast('Captions are off — turn them on to export.'); return; }
      if (clip.srtUrl) { downloadUrl(clip.srtUrl, `${slug(clip.title)}.srt`); return; }
      downloadSrt(clip);
    });

    const copyBtn = iconButton(ICONS.copy, 'Copy title and hook');
    copyBtn.addEventListener('click', async () => {
      const text = `${clip.title}\n${clip.hook}`;
      try {
        await navigator.clipboard.writeText(text);
        toast('Title and hook copied.');
      } catch {
        toast('Copy was blocked by the browser.');
      }
    });

    // Deleting the card also deletes the real file once no list still shows it.
    const forgetFile = () => {
      if (!clip.file) return;
      if (allClips().some((item) => item.id === clip.id)) return;
      fetch('/api/storage/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: clip.file }),
      }).then(() => refreshStorage()).catch(() => {});
    };

    const removeBtn = iconButton(ICONS.trash, opts.mode === 'library' ? 'Remove from library' : 'Discard clip', 'danger push');
    removeBtn.addEventListener('click', () => {
      if (opts.mode === 'library') {
        state.library = state.library.filter((item) => item.id !== clip.id);
        persistLibrary();
        renderLibrary();
        updateCounts();
        toast('Removed from library.');
      } else if (clip.live) {
        state.liveClips = state.liveClips.filter((item) => item.id !== clip.id);
        renderLiveClips();
      } else {
        state.clips = state.clips.filter((item) => item.id !== clip.id);
        renderClips();
      }
      forgetFile();
    });

    actions.append(saveBtn, srtBtn, copyBtn, removeBtn);
    body.append(top, title, hook, actions);
    card.appendChild(body);
    return card;
  }

  function toggleSave(clip) {
    if (isSaved(clip.id)) {
      state.library = state.library.filter((item) => item.id !== clip.id);
      toast('Removed from library.');
    } else {
      state.library = [{ ...clip, savedAt: Date.now() }, ...state.library];
      toast('Saved to your library.');
    }
    persistLibrary();
    updateCounts();
    if (state.view === 'library') renderLibrary();
  }

  /* ───────────────────────── downloads ───────────────────────── */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'clip';

  function downloadUrl(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    if (filename) a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('Caption file downloaded.');
  }

  function buildSrt(clip) {
    const stamp = (t) => {
      const ms = Math.max(0, Math.round(t * 1000));
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms % 1000).padStart(3, '0')}`;
    };
    return clip.lines
      .map((line, i) => {
        const next = clip.lines[i + 1] ? clip.lines[i + 1].at : clip.length;
        return `${i + 1}\n${stamp(line.at)} --> ${stamp(Math.max(line.at + 0.7, next - 0.06))}\n${line.text.toUpperCase()}`;
      })
      .join('\n\n') + '\n';
  }

  function downloadSrt(clip) {
    downloadBlob(new Blob([buildSrt(clip)], { type: 'application/x-subrip;charset=utf-8' }), `${slug(clip.title)}.srt`);
    toast('Caption file downloaded.');
  }

  /* ───────────────────────── rendering ───────────────────────── */
  function renderClips() {
    const grid = $('#clips');
    grid.innerHTML = '';
    state.clips.forEach((clip, i) => grid.appendChild(clipCard(clip, { delay: i * 40 })));
    $('#clips-empty').hidden = state.clips.length > 0;
    updateResultsMeta();
  }

  function updateResultsMeta() {
    const n = state.clips.length;
    if (!n) { $('#results-meta').textContent = 'Nothing yet'; return; }
    const rendered = state.clips.some((clip) => clip.file);
    const captionState = !state.settings.captions
      ? 'no captions'
      : state.settings.captionMode === 'srt' ? 'captions as .srt' : 'captions on';
    $('#results-meta').textContent = `${n} clip${n === 1 ? '' : 's'} · ${rendered ? 'rendered' : captionState}`;
  }

  function renderLiveClips() {
    const grid = $('#live-clips');
    grid.innerHTML = '';
    state.liveClips.forEach((clip, i) => grid.appendChild(clipCard(clip, { delay: i * 40 })));
    $('#live-empty').hidden = state.liveClips.length > 0;
    $('#live-meta').textContent = state.liveClips.length
      ? `${state.liveClips.length} captured · ${state.settings.captions ? 'captioned' : 'clean'}`
      : 'Nothing captured yet';
    $('#live-clips-count').textContent = String(state.liveClips.length);
  }

  function renderLibrary() {
    const grid = $('#library-grid');
    grid.innerHTML = '';
    state.library.forEach((clip, i) => grid.appendChild(clipCard(clip, { delay: i * 35, mode: 'library' })));
    $('#library-empty').hidden = state.library.length > 0;
    $('#library-meta').textContent = state.library.length
      ? `${state.library.length} clip${state.library.length === 1 ? '' : 's'} saved on this device`
      : 'No saved clips';
    $('#clear-library').disabled = state.library.length === 0;
    updateCounts();
  }

  function updateCounts() {
    $$('[data-lib-count]').forEach((el) => { el.textContent = String(state.library.length); });
    $('#library-count').textContent = `${state.library.length} clip${state.library.length === 1 ? '' : 's'}`;
  }

  /* ───────────────────────── captions ───────────────────────── */
  function applyCaptions() {
    const on = state.settings.captions;
    const mode = state.settings.captionMode === 'srt' ? 'srt' : 'burn';
    $$('[data-captions]').forEach((input) => { input.checked = on; });
    $$('[data-caption-state]').forEach((el) => { el.textContent = on ? 'On' : 'Off'; });
    document.body.classList.toggle('captions-off', !on);
    document.body.classList.toggle('caption-sidecar', on && mode === 'srt');
    $('#caption-note').textContent = !on
      ? 'Off — clips render clean and no .srt files are written.'
      : mode === 'srt'
        ? 'Clean video plus a .srt file you can restyle anywhere.'
        : 'Burned into every clip. Switch off for clean footage.';
    const modeOut = $('#caption-mode-out');
    if (modeOut) modeOut.textContent = mode === 'srt' ? 'Sidecar .srt' : 'Burned in';
    $$('#caption-mode button').forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode)));

    $$('canvas[data-clip]').forEach((canvas) => {
      const clip = findClip(canvas.dataset.clip);
      if (clip) drawPoster(canvas, clip);
    });

    updateResultsMeta();
    if (state.liveClips.length) renderLiveClips();
  }

  function setCaptions(on) {
    state.settings.captions = on;
    persistSettings();
    applyCaptions();
    $('#make-hint').textContent = `${state.settings.count} clip${state.settings.count === 1 ? '' : 's'} · ${on ? 'captions on' : 'no captions'}`;
    toast(on ? 'Captions on.' : 'Captions off — clean footage only.');
  }

  /* ───────────────────────── studio pipeline ───────────────────────── */
  function buildStageList(labels) {
    const list = $('#stage-list');
    list.innerHTML = '';
    labels.forEach((label) => {
      const li = document.createElement('li');
      li.textContent = label;
      list.appendChild(li);
    });
  }

  function setProgress(activeIndex, pct) {
    const items = $$('#stage-list li');
    items.forEach((li, i) => {
      li.classList.toggle('done', i < activeIndex);
      li.classList.toggle('active', i === activeIndex);
    });
    const current = items[activeIndex];
    $('#stage-label').textContent = current ? `${current.textContent}…` : 'Done';
    $('#progress-pct').textContent = `${Math.round(pct)}%`;
    $('#progress-bar').style.width = `${Math.round(pct)}%`;
  }

  async function makeClips() {
    const rawUrl = $('#source-url').value.trim();
    const source = state.file ? state.file.name : rawUrl;
    if (!source) {
      toast('Paste a link or choose an MP4 first.');
      $('#source-url').focus();
      return;
    }
    if (!state.file && !safeUrl(rawUrl)) {
      toast('That does not look like a link.');
      $('#source-url').focus();
      return;
    }

    const engine = state.engine.mode;
    if (engine === 'local' || (engine === 'partial' && state.file)) {
      return engineMakeClips(source, rawUrl);
    }
    return demoMakeClips(source);
  }

  async function demoMakeClips(source) {
    const job = { id: Date.now(), cancelled: false };
    state.job = job;
    const useCaptions = state.settings.captions;
    const count = state.settings.count;

    state.clips = [];
    renderClips();
    $('#progress').hidden = false;
    $('#progress-actions').hidden = false;
    $('#stop-clip').hidden = false;
    $('#review-open').hidden = true;
    $('#make-clips').disabled = true;

    const labels = [
      'Reading the source',
      'Pulling word-timed captions',
      'Scoring loudness + chat energy',
      'Cutting 9:16 frames',
      useCaptions ? 'Burning captions' : 'Rendering clean frames',
    ];
    buildStageList(labels);
    setProgress(0, 4);

    const planned = [];
    for (let i = 0; i < count; i++) {
      planned.push(makeClipData(source, i, { salt: `run${job.id}` }));
    }

    try {
      const pacing = [560, 720, 840, 620];
      for (let i = 0; i < 4; i++) {
        if (job.cancelled) return;
        setProgress(i, [14, 32, 54, 76][i]);
        await sleep(pacing[i]);
      }

      for (let i = 0; i < planned.length; i++) {
        if (job.cancelled) return;
        setProgress(4, 80 + Math.round((i / planned.length) * 16));
        await sleep(520);
        state.clips.push(planned[i]);
        $('#clips').appendChild(clipCard(planned[i], { delay: 0 }));
        $('#clips-empty').hidden = true;
        updateResultsMeta();
      }

      if (job.cancelled) return;
      setProgress(labels.length, 100);
      await sleep(420);
    } finally {
      if (state.job === job) {
        $('#progress').hidden = true;
        $('#progress-actions').hidden = true;
        $('#stop-clip').hidden = true;
        $('#review-open').hidden = true;
        $('#make-clips').disabled = false;
        state.job = null;
        $('#make-hint').textContent = `${count} clip${count === 1 ? '' : 's'} · ${useCaptions ? 'captions on' : 'no captions'}`;
        if (!job.cancelled && state.clips.length) {
          toast(`${state.clips.length} clip${state.clips.length === 1 ? '' : 's'} ready.`);
        }
      }
    }
  }

  /* ───────────────────────── live engine ───────────────────────── */
  const live = {
    timer: null, samples: [], elapsed: 0, peaks: 0, cooldownUntil: 0, base: 120, source: '',
    session: null, pollTimer: null, shots: [], pending: [], seenShots: 0, seenClips: 0,
  };
  const LIVE_SAMPLE_LABEL = '15 s';

  function logEvent(text, kind) {
    const list = $('#live-log');
    const placeholder = list.querySelector('.log-empty');
    if (placeholder) placeholder.remove();
    const li = document.createElement('li');
    if (kind) li.className = kind;
    const time = document.createElement('time');
    time.textContent = fmtTime(live.elapsed);
    const span = document.createElement('span');
    span.textContent = text;
    li.append(time, span);
    list.prepend(li);
    while (list.children.length > 40) list.lastElementChild.remove();
  }

  function updateLiveStats(value) {
    $('#live-chat').textContent = String(Math.round(value));
    $('#live-viewers').textContent = Math.round(live.base * 6.4 + Math.sin(live.elapsed / 11) * live.base * 0.35).toLocaleString();
    $('#live-peaks').textContent = String(live.peaks);
    $('#live-clips-count').textContent = String(state.liveClips.length);
    $('#live-clock').textContent = fmtTime(live.elapsed);
  }

  function drawSpark() {
    const canvas = $('#live-spark');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || 560;
    const h = 170;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const data = live.samples.slice(-62);
    if (!data.length) return;
    const padL = 10;
    const padR = 10;
    const padT = 14;
    const padB = 18;
    const max = Math.max(...data, live.base * 2.2) * 1.08;
    const min = 0;
    const stepX = (w - padL - padR) / Math.max(1, data.length - 1);
    const yOf = (v) => padT + (1 - (v - min) / (max - min)) * (h - padT - padB);

    // grid
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const y = padT + ((h - padT - padB) / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
    }

    const mean = data.reduce((a, b) => a + b, 0) / data.length;
    const variance = data.reduce((a, b) => a + (b - mean) ** 2, 0) / data.length;
    const sigma = Math.sqrt(variance) || 1;
    const trigger = mean + state.settings.sensitivity * sigma;

    // threshold
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,200,80,.4)';
    ctx.beginPath();
    ctx.moveTo(padL, yOf(trigger));
    ctx.lineTo(w - padR, yOf(trigger));
    ctx.stroke();
    ctx.setLineDash([]);

    // area
    const grad = ctx.createLinearGradient(0, padT, 0, h - padB);
    grad.addColorStop(0, 'rgba(165,255,62,.30)');
    grad.addColorStop(1, 'rgba(165,255,62,0)');
    ctx.beginPath();
    ctx.moveTo(padL, h - padB);
    data.forEach((v, i) => ctx.lineTo(padL + i * stepX, yOf(v)));
    ctx.lineTo(padL + (data.length - 1) * stepX, h - padB);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // line
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = padL + i * stepX;
      const y = yOf(v);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#a5ff3e';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // last point
    const lastX = padL + (data.length - 1) * stepX;
    const lastY = yOf(data[data.length - 1]);
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3.6, 0, Math.PI * 2);
    ctx.fillStyle = '#e6ffc2';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(lastX, lastY, 8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(165,255,62,.16)';
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,.24)';
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${Math.round(max)} msgs/min`, padL, h - 5);
  }

  function captureLiveClip(intensity) {
    const preroll = state.settings.preroll;
    const at = Math.round(live.elapsed);
    const clip = makeClipData(live.source, state.liveClips.length, {
      salt: `live${at}`,
      start: Math.max(0, at - preroll),
      total: Math.max(120, at + 30),
      live: true,
    });
    clip.live = true;
    clip.score = Math.round(clamp(82 + (intensity / Math.max(1, live.base * 2.2)) * 16, 80, 99));
    clip.end = clip.start + clip.length;
    state.liveClips.unshift(clip);
    renderLiveClips();
    logEvent(`Clip captured · ${fmtTime(clip.start)} → ${fmtTime(clip.end)}${state.settings.captions ? '' : ' · clean'}`, 'capture');
  }

  function liveTick() {
    live.elapsed += 0.7;
    const base = live.base;
    const previous = live.samples[live.samples.length - 1] || base;
    let next = previous + (Math.random() - 0.48) * base * 0.13;
    next = clamp(next, base * 0.35, base * 1.6);
    if (Math.random() < 0.055) next = base * (1.7 + Math.random() * 1.4);

    live.samples.push(next);
    if (live.samples.length > 96) live.samples.shift();

    const recent = live.samples.slice(-62, -1);
    const mean = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length);
    const variance = recent.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, recent.length);
    const sigma = Math.sqrt(variance) || 1;

    if (next > mean + state.settings.sensitivity * sigma && next > mean * 1.4 && live.elapsed > live.cooldownUntil) {
      live.peaks += 1;
      live.cooldownUntil = live.elapsed + 22;
      logEvent(`Chat spike · ${Math.round(next)} msgs/min (${((next - mean) / sigma).toFixed(1)}σ above baseline)`, 'spike');
      if (!state.settings.autoClip) {
        logEvent('Auto-clip is off — spike ignored.', '');
      } else if (live.session && live.session.data && live.session.data.status === 'watching') {
        requestLiveClip(next, 'spike');
      } else if (live.session) {
        logEvent('The stream is not ready yet, so that spike was not recorded.', '');
      } else {
        captureLiveClip(next);
      }
    }

    updateLiveStats(next);
    drawSpark();
  }

  function setLiveStatus(state, label) {
    const chip = $('#live-status');
    if (!chip) return;
    chip.dataset.state = state;
    chip.innerHTML = `<i></i>${label}`;
  }

  function renderLiveShots() {
    const panel = $('#live-shots-panel');
    const strip = $('#live-shots');
    if (!panel || !strip) return;
    const shots = live.shots || [];
    panel.hidden = shots.length === 0;
    strip.innerHTML = '';
    $('#live-shots-meta').textContent = shots.length
      ? `${shots.length} kept · sampled every ${LIVE_SAMPLE_LABEL}`
      : 'Taken at the start and whenever the camera moves';

    shots.forEach((shot) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'review-shot';
      btn.title = shot.note ? `${fmtTime(shot.at)} · ${shot.note}` : `Frame at ${fmtTime(shot.at)}`;
      if (shot.image) {
        const img = document.createElement('img');
        img.src = shot.image;
        img.alt = `Stream frame at ${fmtTime(shot.at)}`;
        btn.appendChild(img);
      }
      const time = document.createElement('span');
      time.textContent = fmtTime(shot.at);
      btn.appendChild(time);
      if (shot.changed) {
        const badge = document.createElement('i');
        badge.className = 'review-badge';
        badge.textContent = 'moved';
        btn.appendChild(badge);
      }
      btn.addEventListener('click', () => {
        state.settings.facecam = cleanRegion(shot.facecam);
        persistSettings();
        syncControls();
        openFrameEditor();
      });
      strip.appendChild(btn);
    });
  }

  function livePendingState(item) {
    if (item.status === 'recording') return 'recording the moment…';
    if (item.status === 'buffered') return item.approved ? 'approved — cutting shortly' : 'recorded — waiting for your OK';
    if (item.status === 'cutting') return 'cutting…';
    if (item.status === 'error') return 'could not record';
    return item.status;
  }

  function renderLivePending() {
    const box = $('#live-pending');
    const panel = $('#live-pending-panel');
    if (!box || !panel) return;
    const items = (live.pending || []).filter((item) =>
      ['recording', 'buffered', 'cutting', 'error'].includes(item.status) && !item.file);
    panel.hidden = items.length === 0;
    box.innerHTML = '';
    $('#live-pending-meta').textContent = items.length
      ? `${items.length} recorded, not cut yet`
      : 'Recorded, not cut yet';

    items.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'live-pending-card';
      if (item.image) {
        const img = document.createElement('img');
        img.src = item.image;
        img.alt = `Screenshot from ${fmtTime(item.at || 0)}`;
        card.appendChild(img);
      }

      const body = document.createElement('div');
      body.className = 'live-pending-body';
      const title = document.createElement('b');
      title.textContent = `${Math.round(item.length)}s clip at ${fmtTime(item.at || 0)}`;
      const state = document.createElement('span');
      state.className = `live-pending-state ${item.status === 'buffered' ? 'ready' : item.status === 'cutting' ? 'cutting' : ''}`;
      state.textContent = livePendingState(item);
      const note = document.createElement('small');
      note.textContent = item.error
        || 'Recording started the moment it was captured. Only the cut waits for you.';
      body.append(title, state, note);

      if (item.status === 'recording' || item.status === 'buffered') {
        const row = document.createElement('div');
        row.className = 'row-actions';
        const reviewBtn = document.createElement('button');
        reviewBtn.type = 'button';
        reviewBtn.className = 'btn primary small';
        reviewBtn.textContent = 'Review & cut';
        reviewBtn.addEventListener('click', () => openLiveReview(item.id));
        const discard = document.createElement('button');
        discard.type = 'button';
        discard.className = 'btn ghost small danger';
        discard.textContent = 'Discard';
        discard.addEventListener('click', () => discardLivePending(item.id));
        row.append(reviewBtn, discard);
        body.appendChild(row);
      }

      card.appendChild(body);
      box.appendChild(card);
    });
  }

  function openLiveReview(pendingId) {
    if (!live.session || !live.session.id) return;
    const item = (live.pending || []).find((entry) => entry.id === pendingId);
    if (!item) return;
    const shots = (live.shots && live.shots.length
      ? live.shots.map((shot) => ({ ...shot, facecam: cleanRegion(shot.facecam) }))
      : [{ at: item.at || 0, image: item.image, facecam: cleanRegion(item.region), changed: false }]);
    openReview(null, { shots }, {
      mode: 'live',
      pendingId,
      liveId: live.session.id,
      index: Math.max(0, shots.length - 1),
    });
  }

  async function discardLivePending(cid) {
    if (!live.session || !live.session.id) return;
    try {
      await fetch(`/api/live/${live.session.id}/pending/${cid}/reject`, { method: 'POST' });
    } catch {
      toast('Could not reach the engine to discard that clip.', 'error');
      return;
    }
    live.pending = (live.pending || []).filter((item) => item.id !== cid);
    renderLivePending();
    toast('Discarded — the recording was deleted.');
  }

  async function requestLiveClip(intensity, why) {
    if (!live.session || !live.session.id) {
      captureLiveClip(intensity || live.base);
      return;
    }
    const length = Math.round(clamp(Math.min(state.settings.maxLen, 60), 10, 90));
    try {
      const res = await fetch(`/api/live/${live.session.id}/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ length }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'The engine refused to record.');
      logEvent(`Moment captured${why === 'spike' ? ' on a spike' : ''} · ${length}s — approve it to cut.`, 'capture');
      notify('Moment recorded', 'Recording started right away. Check the facecam box and approve to cut it.', { type: 'clip' });
      livePoll();
    } catch (err) {
      toast(err && err.message ? err.message : 'The engine could not record that moment.', 'error');
    }
  }

  function addLiveEngineClip(entry) {
    if (!entry || !entry.file) return;
    const clip = engineClipCard(entry, live.source || 'live stream');
    clip.live = true;
    if (state.liveClips.some((item) => item.id === clip.id)) return;
    state.liveClips.unshift(clip);
    renderLiveClips();
    logEvent(`Clip cut · ${clip.title}`, 'capture');
    notify('Live clip ready', `${clip.title} — a real 1080 × 1920 MP4 on disk.`, { type: 'clip' });
  }

  async function livePoll() {
    if (!live.session || !live.session.id) return;
    let data = null;
    try {
      const res = await fetch(`/api/live/${live.session.id}`, { cache: 'no-store' });
      if (!res.ok) return;
      data = await res.json();
    } catch {
      return;
    }
    if (!live.session) return;
    live.session.data = data;

    if (Array.isArray(data.shots) && data.shots.length !== live.shots.length) {
      const fresh = data.shots.slice(live.seenShots);
      live.seenShots = data.shots.length;
      live.shots = data.shots;
      renderLiveShots();
      fresh.forEach((shot) => {
        logEvent(shot.changed
          ? `Camera looks like it moved — new screenshot at ${fmtTime(shot.at)}`
          : 'Screenshot taken — check the facecam box.', 'capture');
      });
      if (fresh.some((shot) => shot.changed)) {
        notify('Facecam moved', 'A new screenshot was kept. Check its box before the next clip is cut.', { type: 'approve' });
      }
    }

    live.pending = Array.isArray(data.pending) ? data.pending : [];
    renderLivePending();

    if (Array.isArray(data.clips) && data.clips.length > live.seenClips) {
      const fresh = data.clips.slice(live.seenClips);
      live.seenClips = data.clips.length;
      fresh.forEach(addLiveEngineClip);
    }

    if (data.status === 'error') {
      if (live.pollTimer) clearInterval(live.pollTimer);
      live.pollTimer = null;
      setLiveStatus('error', 'Stream error');
      logEvent(`Engine error · ${data.error || 'the stream stopped'}`, 'spike');
      notify('Live stream stopped', data.error || 'The engine lost the stream.', { type: 'error' });
      if (live.timer) clearInterval(live.timer);
      live.timer = null;
      live.session = null;
      $('#live-start').disabled = false;
      $('#live-now').disabled = true;
    } else if (data.status === 'stopped') {
      if (live.pollTimer) clearInterval(live.pollTimer);
      live.pollTimer = null;
    } else if (data.status === 'watching') {
      setLiveStatus('live', 'Watching');
      $('#live-now').disabled = false;
    } else if (data.status === 'connecting') {
      setLiveStatus('live', 'Connecting');
    }
  }

  function startLive() {
    const raw = $('#live-url').value.trim();
    if (!raw) {
      toast('Paste the live stream link first.');
      $('#live-url').focus();
      return;
    }
    if (!safeUrl(raw)) {
      toast('That does not look like a link.', 'error');
      return;
    }

    stopLive(true);
    live.samples = [];
    live.elapsed = 0;
    live.peaks = 0;
    live.cooldownUntil = 0;
    live.source = raw;
    live.shots = [];
    live.pending = [];
    live.seenShots = 0;
    live.seenClips = 0;
    live.base = 90 + Math.round(rng(hash(raw))() * 150);
    state.liveClips = [];
    renderLiveClips();
    renderLiveShots();
    renderLivePending();

    const r = rng(hash(`${raw}|warmup`));
    let v = live.base;
    for (let i = 0; i < 62; i++) {
      v = clamp(v + (r() - 0.5) * live.base * 0.22, live.base * 0.4, live.base * 1.5);
      live.samples.push(v);
    }

    $('#live-log').innerHTML = '';
    const detected = detectSource(raw);
    logEvent(`Watching ${detected.label} · chat baseline ${Math.round(live.base)} msgs/min`, '');

    setLiveStatus('live', 'Listening');
    $('#live-start').disabled = true;
    $('#live-stop').disabled = false;
    $('#live-url').disabled = true;
    $('#live-now').disabled = state.engine.mode !== 'local';
    updateLiveStats(live.samples[live.samples.length - 1] || live.base);
    drawSpark();

    live.timer = setInterval(liveTick, 700);

    if (state.engine.mode === 'local') {
      openLiveSession(raw);
    } else {
      logEvent('Demo mode — run python engine.py and live clips become real MP4s.', '');
      notify('Demo mode', 'Live clips are simulated posters until the local engine is running.', { type: 'info' });
    }
  }

  async function openLiveSession(raw) {
    try {
      const res = await fetch('/api/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: raw,
          layout: reviewLayout(),
          facecam: state.settings.facecam,
          captions: { on: state.settings.captions, mode: state.settings.captionMode },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.id) throw new Error(data.error || 'The engine could not open that stream.');
      live.session = { id: data.id, status: 'starting', data: null };
      live.pollTimer = setInterval(livePoll, 1500);
      logEvent('Engine connected — reading the stream and sampling frames.', '');
      notify('Watching the stream', 'Frames are sampled now; clips are only cut after you approve them.', { type: 'info' });
      livePoll();
    } catch (err) {
      live.session = null;
      $('#live-now').disabled = true;
      logEvent(`Could not open the stream · ${err && err.message ? err.message : 'unknown error'}`, 'spike');
      notify('Live link failed', err && err.message ? err.message : 'The engine could not open that stream.', { type: 'error' });
    }
  }

  function stopLive(silent) {
    if (live.timer) clearInterval(live.timer);
    live.timer = null;
    if (live.pollTimer) clearInterval(live.pollTimer);
    live.pollTimer = null;
    if (live.session && live.session.id) {
      fetch(`/api/live/${live.session.id}/stop`, { method: 'POST' }).catch(() => {});
    }
    live.session = null;
    $('#live-start').disabled = false;
    $('#live-stop').disabled = true;
    $('#live-now').disabled = true;
    $('#live-url').disabled = false;
    if (!silent) {
      setLiveStatus('paused', 'Paused');
      logEvent('Stopped watching. Clips already cut are kept.', '');
      notify('Stopped watching', 'The engine stopped sampling and recording. Cut clips stay in Live clips.', { type: 'info' });
    }
  }

  /* ───────────────────────── post presets ───────────────────────── */
  const SAFE_GUIDES = {
    reels: { top: 0.14, bottom: 0.22 },
    tiktok: { top: 0.12, bottom: 0.18 },
    shorts: { top: 0.16, bottom: 0.24 },
    custom: null,
  };

  function applyPreset(key, quiet) {
    const name = PRESETS[key] ? key : 'reels';
    const preset = PRESETS[name];
    state.settings.preset = name;
    if (state.settings.maxLen > preset.max) {
      state.settings.maxLen = preset.max;
      if (state.settings.minLen > preset.max - 5) {
        state.settings.minLen = Math.max(15, preset.max - 5);
      }
    }
    persistSettings();
    syncControls();
    drawFramePreview();
    if (!quiet) toast(`${preset.label} preset — clips up to ${preset.max}s.`);
  }

  function setCaptionMode(mode) {
    state.settings.captionMode = mode === 'srt' ? 'srt' : 'burn';
    persistSettings();
    applyCaptions();
    toast(state.settings.captionMode === 'srt'
      ? 'Captions become a sidecar .srt — clean video.'
      : 'Captions are burned into the video.');
  }

  function redrawPosters() {
    $$('canvas[data-clip]').forEach((canvas) => {
      const clip = findClip(canvas.dataset.clip);
      if (clip) drawPoster(canvas, clip);
    });
  }

  /* ───────────────────────── facecam editor ───────────────────────── */
  const frame = { drag: null, img: null };

  function regionLabel(reg) {
    const cx = reg.x + reg.w / 2;
    const cy = reg.y + reg.h / 2;
    const vertical = cy < 0.42 ? 'top' : cy > 0.58 ? 'bottom' : 'middle';
    const horizontal = cx < 0.42 ? 'left' : cx > 0.58 ? 'right' : 'center';
    if (vertical === 'middle' && horizontal === 'center') return 'center';
    if (vertical === 'middle') return `${horizontal} edge`;
    return `${vertical}-${horizontal}`;
  }

  function frameNote() {
    const el = $('#frame-note');
    if (!el) return;
    const reg = state.settings.facecam;
    el.textContent = `Facecam: ${regionLabel(reg)} · ${Math.round(reg.w * 100)}% × ${Math.round(reg.h * 100)}%`;
  }

  function handlePoints(bx, by, bw, bh) {
    return [
      [bx, by], [bx + bw / 2, by], [bx + bw, by],
      [bx, by + bh / 2], [bx + bw, by + bh / 2],
      [bx, by + bh], [bx + bw / 2, by + bh], [bx + bw, by + bh],
    ];
  }

  function frameHit(reg, px, py, tolX, tolY) {
    const near = (a, b, tol) => Math.abs(a - b) <= tol;
    const left = near(px, reg.x, tolX);
    const right = near(px, reg.x + reg.w, tolX);
    const top = near(py, reg.y, tolY);
    const bottom = near(py, reg.y + reg.h, tolY);
    const insideX = px >= reg.x - tolX && px <= reg.x + reg.w + tolX;
    const insideY = py >= reg.y - tolY && py <= reg.y + reg.h + tolY;
    if (top && left) return 'nw';
    if (top && right) return 'ne';
    if (bottom && left) return 'sw';
    if (bottom && right) return 'se';
    if (top && insideX) return 'n';
    if (bottom && insideX) return 's';
    if (left && insideY) return 'w';
    if (right && insideY) return 'e';
    if (insideX && insideY) return 'move';
    return '';
  }

  function frameCursor(hit) {
    if (!hit) return 'crosshair';
    if (hit === 'move') return 'move';
    if (hit === 'n' || hit === 's') return 'ns-resize';
    if (hit === 'e' || hit === 'w') return 'ew-resize';
    if (hit === 'nw' || hit === 'se') return 'nwse-resize';
    return 'nesw-resize';
  }

  function framePoint(evt) {
    const canvas = $('#frame-canvas');
    const rect = canvas.getBoundingClientRect();
    return {
      x: clamp((evt.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
      y: clamp((evt.clientY - rect.top) / Math.max(1, rect.height), 0, 1),
      w: rect.width,
      h: rect.height,
    };
  }

  function drawFrameEditor() {
    const canvas = $('#frame-canvas');
    if (!canvas) return;
    const w = canvas.clientWidth;
    if (!w) return;
    const h = Math.round((w * 9) / 16);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (frame.img && frame.img.width) {
      const cover = Math.max(w / frame.img.width, h / frame.img.height);
      const dw = frame.img.width * cover;
      const dh = frame.img.height * cover;
      ctx.drawImage(frame.img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    } else {
      paintSource(ctx, w, h, 31);
    }

    const guides = SAFE_GUIDES[state.settings.preset];
    if (guides) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,.05)';
      ctx.fillRect(0, 0, w, h * guides.top);
      ctx.fillRect(0, h * (1 - guides.bottom), w, h * guides.bottom);
      ctx.strokeStyle = 'rgba(255,255,255,.2)';
      ctx.setLineDash([5, 5]);
      ctx.beginPath(); ctx.moveTo(0, h * guides.top); ctx.lineTo(w, h * guides.top); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, h * (1 - guides.bottom)); ctx.lineTo(w, h * (1 - guides.bottom)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    const reg = state.settings.facecam;
    const bx = reg.x * w;
    const by = reg.y * h;
    const bw = reg.w * w;
    const bh = reg.h * h;

    ctx.save();
    ctx.fillStyle = 'rgba(4,6,11,.55)';
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.rect(bx, by, bw, bh);
    ctx.fill('evenodd');
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = 'rgba(165,255,62,.95)';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx + 0.5, by + 0.5, Math.max(1, bw - 1), Math.max(1, bh - 1));
    ctx.strokeStyle = 'rgba(165,255,62,.3)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(bx + (bw * i) / 3, by); ctx.lineTo(bx + (bw * i) / 3, by + bh); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(bx, by + (bh * i) / 3); ctx.lineTo(bx + bw, by + (bh * i) / 3); ctx.stroke();
    }
    ctx.fillStyle = '#0b0f16';
    ctx.strokeStyle = 'rgba(165,255,62,1)';
    handlePoints(bx, by, bw, bh).forEach(([hx, hy]) => {
      ctx.beginPath();
      ctx.rect(hx - 5, hy - 5, 10, 10);
      ctx.fill();
      ctx.stroke();
    });
    ctx.font = '600 10px Inter, system-ui, sans-serif';
    const label = 'FACECAM';
    const lw = ctx.measureText(label).width + 14;
    const ly = by > 22 ? by - 21 : by + 4;
    ctx.fillStyle = 'rgba(165,255,62,.94)';
    ctx.fillRect(Math.max(0, bx), ly, lw, 16);
    ctx.fillStyle = '#07120a';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, Math.max(0, bx) + 7, ly + 8);
    ctx.restore();

    const readout = $('#frame-readout');
    if (readout) {
      readout.textContent = `x ${Math.round(reg.x * 100)}% · y ${Math.round(reg.y * 100)}% · ${Math.round(reg.w * 100)}% × ${Math.round(reg.h * 100)}%`;
    }
  }

  function drawFramePreview() {
    const canvas = $('#frame-preview');
    if (!canvas) return;
    drawPoster(canvas, {
      id: 'frame-preview',
      seed: 7,
      hue: 208,
      layout: review.active ? review.layout : state.settings.layout,
      style: state.settings.captionStyle,
      start: 0,
      end: 62,
      length: 62,
      score: 92,
      source: 'facecam preview',
      title: 'Facecam preview',
      lines: [{ at: 0, text: 'this is the moment chat lost it' }],
    });
  }

  function loadFileFrame() {
    if (!state.file) return;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const src = URL.createObjectURL(state.file);
    video.src = src;
    const cleanup = () => URL.revokeObjectURL(src);
    video.addEventListener('loadeddata', () => {
      video.currentTime = Math.min(2, Math.max(0.1, (video.duration || 4) / 3));
    }, { once: true });
    video.addEventListener('seeked', () => {
      try {
        const shot = document.createElement('canvas');
        shot.width = video.videoWidth || SRC_W;
        shot.height = video.videoHeight || SRC_H;
        shot.getContext('2d').drawImage(video, 0, 0);
        const img = new Image();
        img.onload = () => { frame.img = img; drawFrameEditor(); };
        img.src = shot.toDataURL('image/jpeg', 0.82);
      } catch {
        /* keep the painted scene */
      }
      cleanup();
    }, { once: true });
    video.addEventListener('error', cleanup, { once: true });
  }

  async function loadUrlFrame() {
    const raw = $('#source-url').value.trim();
    if (!raw || !safeUrl(raw) || state.engine.mode === 'demo') return;
    if (frame.img && state.thumbUrl === raw) return;
    const loading = $('#frame-loading');
    if (loading) loading.hidden = false;
    try {
      const res = await fetch(`/api/analyze?url=${encodeURIComponent(raw)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.thumbnail) {
        state.thumb = data.thumbnail;
        state.thumbUrl = raw;
        const img = new Image();
        img.onload = () => { frame.img = img; drawFrameEditor(); };
        img.src = data.thumbnail;
      }
    } catch {
      /* the painted scene is a fine fallback */
    } finally {
      if (loading) loading.hidden = true;
    }
  }

  function openFrameEditor(opts = {}) {
    const dlg = $('#frame-dialog');
    if (!dlg) return;
    const reviewing = Boolean(opts.review || review.active);
    if (!reviewing) closeReview();
    $$('#frame-dialog [data-corner]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
    const presetName = $('#frame-preset-name');
    if (presetName) presetName.textContent = (PRESETS[state.settings.preset] || PRESETS.reels).label;
    if (typeof dlg.showModal === 'function') {
      if (!dlg.open) dlg.showModal();
    } else {
      dlg.setAttribute('open', '');
    }
    drawFrameEditor();
    drawFramePreview();
    requestAnimationFrame(() => { drawFrameEditor(); drawFramePreview(); });
    if (reviewing) {
      const shot = review.shots[review.index];
      frame.img = null;
      if (shot && shot.image) {
        const img = new Image();
        img.onload = () => {
          if (review.active && review.shots[review.index] === shot) {
            frame.img = img;
            drawFrameEditor();
          }
        };
        img.src = shot.image;
      }
    } else if (state.file) {
      loadFileFrame();
    } else {
      loadUrlFrame();
    }
  }

  function closeFrameEditor(opts = {}) {
    persistSettings();
    const dlg = $('#frame-dialog');
    if (dlg && dlg.open && typeof dlg.close === 'function') dlg.close();
    frame.drag = null;
    frameNote();
    redrawPosters();
    if (review.active) closeReview(Boolean(opts.resetReview));
  }

  function applyCorner(corner) {
    const reg = state.settings.facecam;
    const pad = 0.025;
    const spots = {
      tl: { x: pad, y: pad },
      tr: { x: 1 - reg.w - pad, y: pad },
      bl: { x: pad, y: 1 - reg.h - pad },
      br: { x: 1 - reg.w - pad, y: 1 - reg.h - pad },
    };
    const spot = spots[corner];
    if (!spot) return;
    state.settings.facecam = { x: spot.x, y: spot.y, w: reg.w, h: reg.h };
    persistSettings();
    drawFrameEditor();
    drawFramePreview();
    frameNote();
    redrawPosters();
  }

  function bindFrameEditor() {
    const dlg = $('#frame-dialog');
    const canvas = $('#frame-canvas');
    if (!dlg || !canvas) return;

    $('#open-frame').addEventListener('click', () => openFrameEditor());
    $('#frame-close').addEventListener('click', () => closeFrameEditor());
    dlg.addEventListener('close', () => {
      frame.drag = null;
      frameNote();
      redrawPosters();
      if (review.active) closeReview();
    });

    window.addEventListener('resize', () => {
      if (dlg.open) drawFrameEditor();
    });

    $$('#frame-dialog [data-corner]').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('#frame-dialog [data-corner]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        applyCorner(btn.dataset.corner);
      });
    });

    $('#frame-reset').addEventListener('click', () => {
      state.settings.facecam = { ...DEFAULT_REGION };
      persistSettings();
      $$('#frame-dialog [data-corner]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      drawFrameEditor();
      drawFramePreview();
      frameNote();
      redrawPosters();
      toast('Facecam area reset.');
    });

    $('#frame-full').addEventListener('click', () => {
      state.settings.layout = 'full';
      persistSettings();
      $('#layout-select').value = 'full';
      drawFramePreview();
      toast('Layout set to full frame.');
    });

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (canvas.setPointerCapture) {
        try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      }
      const p = framePoint(e);
      const reg = state.settings.facecam;
      const hit = frameHit(reg, p.x, p.y, 12 / Math.max(1, p.w), 12 / Math.max(1, p.h));
      if (hit) {
        frame.drag = { mode: hit, startX: p.x, startY: p.y, origin: { ...reg } };
      } else {
        const next = {
          x: clamp(p.x - reg.w / 2, 0, 1 - reg.w),
          y: clamp(p.y - reg.h / 2, 0, 1 - reg.h),
          w: reg.w,
          h: reg.h,
        };
        state.settings.facecam = next;
        frame.drag = { mode: 'move', startX: p.x, startY: p.y, origin: { ...next } };
      }
      drawFrameEditor();
      drawFramePreview();
      e.preventDefault();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!frame.drag) {
        const p = framePoint(e);
        const hit = frameHit(state.settings.facecam, p.x, p.y, 12 / Math.max(1, p.w), 12 / Math.max(1, p.h));
        canvas.style.cursor = frameCursor(hit);
        return;
      }
      const p = framePoint(e);
      const dx = p.x - frame.drag.startX;
      const dy = p.y - frame.drag.startY;
      const o = frame.drag.origin;
      const mode = frame.drag.mode;
      const min = 0.05;
      let reg = { ...o };
      if (mode === 'move') {
        reg.x = clamp(o.x + dx, 0, 1 - o.w);
        reg.y = clamp(o.y + dy, 0, 1 - o.h);
      } else {
        let x1 = o.x;
        let y1 = o.y;
        let x2 = o.x + o.w;
        let y2 = o.y + o.h;
        if (mode.includes('w')) x1 = clamp(o.x + dx, 0, x2 - min);
        if (mode.includes('e')) x2 = clamp(o.x + o.w + dx, x1 + min, 1);
        if (mode.includes('n')) y1 = clamp(o.y + dy, 0, y2 - min);
        if (mode.includes('s')) y2 = clamp(o.y + o.h + dy, y1 + min, 1);
        reg = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      }
      state.settings.facecam = reg;
      canvas.style.cursor = frameCursor(mode);
      drawFrameEditor();
      drawFramePreview();
    });

    const release = () => {
      if (!frame.drag) return;
      frame.drag = null;
      persistSettings();
      commitReviewShot();
      frameNote();
      redrawPosters();
    };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    dlg.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const step = e.shiftKey ? 0.02 : 0.005;
      const reg = { ...state.settings.facecam };
      let used = true;
      if (e.key === 'ArrowLeft') {
        if (e.shiftKey) reg.w = clamp(reg.w - step, 0.05, 1 - reg.x);
        else reg.x = clamp(reg.x - step, 0, 1 - reg.w);
      } else if (e.key === 'ArrowRight') {
        if (e.shiftKey) reg.w = clamp(reg.w + step, 0.05, 1 - reg.x);
        else reg.x = clamp(reg.x + step, 0, 1 - reg.w);
      } else if (e.key === 'ArrowUp') {
        if (e.shiftKey) reg.h = clamp(reg.h - step, 0.05, 1 - reg.y);
        else reg.y = clamp(reg.y - step, 0, 1 - reg.h);
      } else if (e.key === 'ArrowDown') {
        if (e.shiftKey) reg.h = clamp(reg.h + step, 0.05, 1 - reg.y);
        else reg.y = clamp(reg.y + step, 0, 1 - reg.h);
      } else {
        used = false;
      }
      if (!used) return;
      e.preventDefault();
      state.settings.facecam = reg;
      persistSettings();
      commitReviewShot();
      drawFrameEditor();
      drawFramePreview();
      frameNote();
      redrawPosters();
    });
  }

  /* ───────────────────────── review + approval ───────────────────────── */
  const review = {
    active: false, shots: [], index: 0, layout: 'gameplay', jobId: '',
    mode: 'studio', pendingId: '', liveId: '',
  };

  function reviewLayout() {
    return ['split', 'gameplay', 'facecam', 'full'].includes(state.settings.layout)
      ? state.settings.layout
      : 'gameplay';
  }

  function liveLayout() {
    const select = $('#live-layout');
    const value = select ? select.value : state.settings.layout;
    return ['split', 'gameplay', 'facecam', 'full'].includes(value) ? value : 'gameplay';
  }

  function renderReviewStrip() {
    const strip = $('#review-shots');
    if (!strip) return;
    strip.innerHTML = '';
    review.shots.forEach((shot, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'review-shot';
      btn.title = `Frame at ${fmtTime(shot.at)}`;
      btn.setAttribute('aria-pressed', String(i === review.index));
      if (shot.image) {
        const img = document.createElement('img');
        img.src = shot.image;
        img.alt = `Source frame at ${fmtTime(shot.at)}`;
        btn.appendChild(img);
      }
      const time = document.createElement('span');
      time.textContent = fmtTime(shot.at);
      btn.appendChild(time);
      if (shot.changed) {
        const badge = document.createElement('i');
        badge.className = 'review-badge';
        badge.textContent = 'moved';
        btn.appendChild(badge);
      }
      if (shot.edited) btn.classList.add('edited');
      btn.addEventListener('click', () => selectShot(i));
      strip.appendChild(btn);
    });
  }

  function selectShot(i) {
    const shot = review.shots[i];
    if (!shot) return;
    review.index = i;
    state.settings.facecam = { ...shot.facecam };
    $$('#review-shots .review-shot').forEach((el, k) => el.setAttribute('aria-pressed', String(k === i)));
    frame.img = null;
    drawFrameEditor();
    drawFramePreview();
    frameNote();
    if (shot.image) {
      const img = new Image();
      img.onload = () => {
        if (review.index === i) { frame.img = img; drawFrameEditor(); }
      };
      img.src = shot.image;
    }
  }

  function commitReviewShot() {
    if (!review.active) return;
    const shot = review.shots[review.index];
    if (!shot) return;
    shot.facecam = { ...state.settings.facecam };
    shot.edited = true;
    const el = $$('#review-shots .review-shot')[review.index];
    if (el) el.classList.add('edited');
  }

  function applyRegionToAll() {
    if (!review.shots.length) return;
    review.shots.forEach((shot) => {
      shot.facecam = { ...state.settings.facecam };
      shot.edited = true;
    });
    renderReviewStrip();
    toast('That box now applies to every shot.');
  }

  function paintReviewNote() {
    const note = $('#review-note');
    if (!note) return;
    const moved = review.shots.filter((shot) => shot.changed).length;
    const unsure = review.shots.filter((shot) => Number(shot.confidence) < 0.35).length;
    const bits = [
      moved
        ? `The camera seems to move ${moved} time${moved === 1 ? '' : 's'} — each shot keeps its own box.`
        : 'The camera looks like it stays in one place.',
    ];
    if (unsure) bits.push(`${unsure} frame${unsure === 1 ? '' : 's'} had no clear camera, so check those boxes.`);
    bits.push(review.mode === 'live'
      ? 'The recording is finished — the cut waits for this button.'
      : 'Nothing is cut until you press Start clipping.');
    note.textContent = bits.join(' ');
  }

  function openReview(job, payload, ctx = {}) {
    const incoming = payload && Array.isArray(payload.shots) && payload.shots.length ? payload.shots : review.shots;
    if (!incoming || !incoming.length) {
      toast('The engine could not pull any frames to review.', 'error');
      return;
    }
    const keepEdits = review.mode === (ctx.mode || 'studio')
      && review.shots.length === incoming.length
      && review.shots.some((shot) => shot.edited);
    if (!keepEdits) {
      review.shots = incoming.map((shot) => ({ ...shot, facecam: { ...(shot.facecam || DEFAULT_REGION) } }));
      review.index = 0;
    }
    if (!review.shots[review.index]) review.index = 0;
    review.mode = ctx.mode || 'studio';
    review.pendingId = ctx.pendingId || '';
    review.liveId = ctx.liveId || '';
    if (!keepEdits && Number.isFinite(ctx.index)) {
      review.index = clamp(Math.round(ctx.index), 0, review.shots.length - 1);
    }
    review.jobId = job && job.jobId ? job.jobId : review.jobId;
    review.layout = review.mode === 'live' ? liveLayout() : reviewLayout();
    review.active = true;
    state.settings.facecam = { ...review.shots[review.index].facecam };

    $('#review-strip').hidden = false;
    $('#review-foot').hidden = false;
    $('#review-start').hidden = false;
    $('#frame-apply-all').hidden = false;
    $('#frame-title').textContent = review.mode === 'live' ? 'Check the facecam before cutting' : 'Check the facecam';
    $('#frame-sub').textContent = review.mode === 'live'
      ? 'This is the moment the engine recorded. Fix the box, choose what the clip should focus on, then approve — nothing is cut until you do.'
      : 'The engine pulled these frames from your video and boxed where it thinks the camera is. Fix any box, choose what the clip should focus on, then start clipping.';
    $('#review-start').textContent = review.mode === 'live' ? 'Approve & cut' : 'Start clipping';

    renderReviewStrip();
    $$('#review-layout button').forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.layout === review.layout)));
    openFrameEditor({ review: true });
    paintReviewNote();
  }

  function closeReview(reset) {
    review.active = false;
    if (reset) {
      review.shots = [];
      review.index = 0;
    }
    const strip = $('#review-strip');
    if (strip) strip.hidden = true;
    const foot = $('#review-foot');
    if (foot) foot.hidden = true;
    const start = $('#review-start');
    if (start) {
      start.hidden = true;
      start.textContent = 'Start clipping';
    }
    const all = $('#frame-apply-all');
    if (all) all.hidden = true;
    review.mode = 'studio';
    review.pendingId = '';
    review.liveId = '';
    $('#frame-title').textContent = 'Facecam area';
    $('#frame-sub').textContent = "Drag the box over the streamer's camera. Drag on empty space to draw a fresh one.";
  }

  async function approveReview() {
    const job = state.job;
    const layout = review.layout;
    const shots = review.shots.map((shot) => ({ at: shot.at, facecam: { ...shot.facecam } }));

    state.settings.layout = layout;
    persistSettings();
    const layoutSelect = $('#layout-select');
    if (layoutSelect) layoutSelect.value = layout;
    const liveSelect = $('#live-layout');
    if (liveSelect) liveSelect.value = layout;

    if (review.mode === 'live') {
      if (!review.liveId || !review.pendingId) return;
      try {
        const res = await fetch(`/api/live/${review.liveId}/pending/${review.pendingId}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ layout, facecam: state.settings.facecam, shots }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast(data.error || 'The engine did not accept that layout.', 'error');
          return;
        }
      } catch {
        toast('Could not reach the engine to approve.', 'error');
        return;
      }
      closeFrameEditor({ resetReview: true });
      notify('Approved', 'Cutting that live clip now — it lands in Live clips when it is done.', { type: 'success' });
      livePoll();
      return;
    }

    if (job && job.jobId) {
      try {
        const res = await fetch(`/api/jobs/${job.jobId}/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ layout, facecam: state.settings.facecam, shots }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast(data.error || 'The engine did not accept that layout.');
          return;
        }
      } catch {
        toast('Could not reach the engine to approve.');
        return;
      }
    }

    state.settings.layout = layout;
    persistSettings();
    const select = $('#layout-select');
    if (select) select.value = layout;
    closeFrameEditor({ resetReview: true });
    if (job && job.resolveGate) job.resolveGate(true);
    toast('Layout approved — cutting clips now.', 'success');
  }

  function stopClipping() {
    const job = state.job;
    if (!job) return;
    job.cancelled = true;
    if (job.jobId) {
      fetch(`/api/jobs/${job.jobId}/cancel`, { method: 'POST' }).catch(() => {});
    }
    if (job.resolveGate) job.resolveGate(false);
    closeFrameEditor({ resetReview: true });
    $('#progress').hidden = true;
    $('#progress-actions').hidden = true;
    $('#stop-clip').hidden = true;
    $('#review-open').hidden = true;
    $('#make-clips').disabled = false;
    toast('Stopped — nothing else is being downloaded or cut.');
  }

  /* ───────────────────────── watchlist ───────────────────────── */
  function watchList() {
    return Array.isArray(state.watch) ? state.watch : [];
  }

  function renderWatch() {
    const list = $('#watch-list');
    if (!list) return;
    const items = watchList();
    list.innerHTML = '';

    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'watch-empty';
      li.textContent = 'No channels saved yet.';
      list.appendChild(li);
    }

    items.forEach((item, index) => {
      const li = document.createElement('li');

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'watch-open';
      open.title = `Watch ${item.url}`;
      const dot = document.createElement('i');
      dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = item.label;
      const kind = document.createElement('small');
      kind.textContent = item.source || 'Link';
      open.append(dot, label, kind);
      open.addEventListener('click', () => {
        $('#live-url').value = item.url;
        startLive();
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'watch-del';
      del.title = 'Remove from watchlist';
      del.setAttribute('aria-label', `Remove ${item.label}`);
      del.textContent = '×';
      del.addEventListener('click', () => {
        state.watch = watchList().filter((_, i) => i !== index);
        writeJSON(KEY.watch, state.watch);
        renderWatch();
        toast('Removed from watchlist.');
      });

      li.append(open, del);
      list.appendChild(li);
    });

    const count = $('#watch-count');
    if (count) count.textContent = `${items.length} saved`;
  }

  function addWatch(raw) {
    const value = String(raw || '').trim();
    if (!value) return;
    const url = /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`;
    if (!safeUrl(url)) { toast('That does not look like a link.'); return; }
    const trim = (text) => text.replace(/\/$/, '').toLowerCase();
    if (watchList().some((item) => trim(item.url) === trim(url))) {
      toast('Already on the watchlist.');
      return;
    }
    const info = detectSource(url);
    state.watch = [{
      url,
      label: value.replace(/^https?:\/\//i, '').replace(/\/$/, ''),
      source: info.known ? info.label : 'Link',
    }, ...watchList()].slice(0, 12);
    writeJSON(KEY.watch, state.watch);
    renderWatch();
    toast('Added to watchlist.');
  }

  /* ───────────────────────── local engine ───────────────────────── */
  function paintEngine() {
    const badge = $('#engine-badge');
    if (!badge) return;
    const mode = state.engine.mode;
    const health = state.engine.health;
    badge.dataset.mode = mode;
    const text = badge.querySelector('b');
    if (text) text.textContent = mode === 'local' ? 'Local engine' : mode === 'partial' ? 'Files only' : 'Demo mode';
    badge.title = mode === 'local'
      ? `Real clips with yt-dlp + ffmpeg${health && health.captions ? '' : ' (this ffmpeg cannot burn captions, so .srt only)'}`
      : mode === 'partial'
        ? 'ffmpeg found but yt-dlp is missing — local MP4 files render for real, links stay demo clips.'
        : 'Clipping is simulated. Run python engine.py in this folder for real MP4s.';

    const footer = $('#engine-footer');
    if (footer) footer.textContent = mode === 'local' ? 'Local engine on.' : mode === 'partial' ? 'ffmpeg only.' : 'Demo mode.';

    const hint = $('#make-hint');
    if (hint) {
      const n = state.settings.count;
      hint.textContent = mode === 'local'
        ? `${n} clip${n === 1 ? '' : 's'} · review frames, then cut`
        : `${n} clip${n === 1 ? '' : 's'} · ${state.settings.captions ? 'captions on' : 'no captions'}`;
    }
  }

  async function engineCheck() {
    let data = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch('/api/health', { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) data = await res.json();
    } catch {
      data = null;
    }
    state.engine.health = data;
    state.engine.mode = data && data.ok && data.ffmpeg ? (data.ytdlp ? 'local' : 'partial') : 'demo';
    paintEngine();
  }

  function engineClipCard(entry, source) {
    return {
      id: `e${hash(entry.file)}`,
      source,
      title: entry.title || 'Clip',
      hook: entry.burnedCaptions
        ? 'Rendered 1080 × 1920 with captions burned in.'
        : 'Rendered 1080 × 1920 by the local engine.',
      start: entry.start,
      end: entry.end,
      length: Math.max(1, entry.end - entry.start),
      score: entry.score || 86,
      layout: entry.layout || 'gameplay',
      style: state.settings.captionStyle,
      file: entry.file,
      srtUrl: entry.srt || '',
      createdAt: Date.now(),
      lines: [],
    };
  }

  function syncEngineClips(list, source) {
    const seen = new Set(state.clips.map((clip) => clip.id));
    list.forEach((entry) => {
      if (!entry || !entry.file) return;
      const clip = engineClipCard(entry, source);
      if (seen.has(clip.id)) return;
      seen.add(clip.id);
      state.clips.push(clip);
      $('#clips').appendChild(clipCard(clip));
      $('#clips-empty').hidden = true;
      updateResultsMeta();
    });
  }

  async function engineMakeClips(source, rawUrl) {
    const job = { id: Date.now(), cancelled: false, engine: true };
    state.job = job;
    const settings = state.settings;
    const usingFile = Boolean(state.file);

    state.clips = [];
    renderClips();
    $('#progress').hidden = false;
    $('#progress-actions').hidden = false;
    $('#stop-clip').hidden = false;
    $('#review-open').hidden = true;
    $('#make-clips').disabled = true;

    const labels = [
      usingFile ? 'Uploading the file' : 'Reading the video',
      'Listening to the audio',
      'Planning moments and screenshots',
      'Waiting for your layout check',
      'Cutting 1080 × 1920 clips',
    ];
    buildStageList(labels);
    setProgress(0, 3);

    try {
      let upload = '';
      if (state.file) {
        setProgress(0, 6);
        $('#stage-label').textContent = `Uploading ${state.file.name}…`;
        const up = await fetch(`/api/upload?name=${encodeURIComponent(state.file.name)}`, {
          method: 'POST',
          body: state.file,
        });
        const upData = await up.json().catch(() => ({}));
        if (!up.ok || !upData.upload) throw new Error(upData.error || 'The file could not be uploaded.');
        upload = upData.upload;
      }

      setProgress(1, 12);
      const res = await fetch('/api/clips', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: rawUrl,
          upload,
          count: settings.count,
          minLen: settings.minLen,
          maxLen: settings.maxLen,
          layout: settings.layout,
          preset: settings.preset,
          facecam: settings.facecam,
          captions: {
            on: settings.captions,
            mode: settings.captionMode,
            style: settings.captionStyle,
            lang: settings.language,
          },
        }),
      });
      const started = await res.json().catch(() => ({}));
      if (!res.ok || !started.id) throw new Error(started.error || 'The engine refused the job.');
      job.jobId = started.id;

      const stageIndex = (name) => ({
        fetch: 0, audio: 1, plan: 2, shots: 2, review: 3, cut: 4, done: 5,
      }[name] ?? 3);

      while (!job.cancelled) {
        const poll = await fetch(`/api/jobs/${job.jobId}`, { cache: 'no-store' });
        if (!poll.ok) throw new Error('Lost contact with the engine.');
        const data = await poll.json();
        const pct = Math.max(3, Math.min(99, Number(data.pct) || 0));
        setProgress(stageIndex(data.stage), pct);
        if (data.label) $('#stage-label').textContent = `${data.label}…`;
        if (data.clips && data.clips.length) syncEngineClips(data.clips, source);
        if (data.error) throw new Error(data.error);
        if (data.awaiting && data.review && Array.isArray(data.review.shots)) {
          state.reviewData = data.review;
          if (!job.reviewShown) {
            job.reviewShown = true;
            openReview(job, data.review);
            $('#review-open').hidden = false;
            $('#stage-label').textContent = 'Waiting for your layout check…';
            notify('Your turn', 'Screenshots are ready — check the facecam box to start cutting.', { type: 'approve' });
          }
          // The engine holds the cutting stage until this resolves.
          const go = await new Promise((resolve) => { job.resolveGate = resolve; });
          job.resolveGate = null;
          if (!go || job.cancelled) break;
          continue;
        }
        if (data.done) break;
        await sleep(900);
      }

      if (job.cancelled) return;
      setProgress(labels.length, 100);
      await sleep(280);
      if (!state.clips.length) toast('The engine finished without clips.');
      else toast(`${state.clips.length} real clip${state.clips.length === 1 ? '' : 's'} rendered.`);
    } catch (err) {
      console.warn('[engine]', err);
      toast(err && err.message ? err.message : 'The local engine failed.');
    } finally {
      if (state.job === job) {
        $('#progress').hidden = true;
        $('#progress-actions').hidden = true;
        $('#stop-clip').hidden = true;
        $('#review-open').hidden = true;
        $('#make-clips').disabled = false;
        state.job = null;
        state.reviewData = null;
        paintEngine();
      }
    }
  }

  /* ───────────────────────── cache + saved clips ───────────────────────── */
  const STORAGE_ROWS = [
    { key: 'cache', label: 'Temporary audio & stream parts', note: 'Downloaded audio, subtitles and frame grabs' },
    { key: 'clips', label: 'Rendered clips', note: 'Every MP4 the engine wrote' },
    { key: 'uploads', label: 'Uploaded videos', note: 'Local files you sent to the engine' },
  ];

  let storageData = null;

  function fmtBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }

  function renderStorage() {
    const list = $('#storage-list');
    const total = $('#storage-total');
    if (!list || !total || !storageData) return;
    const sum = STORAGE_ROWS.reduce((acc, row) => acc + ((storageData[row.key] || {}).bytes || 0), 0);
    total.textContent = `${fmtBytes(sum)} on disk`;
    list.innerHTML = '';

    STORAGE_ROWS.forEach(({ key, label, note }) => {
      const info = storageData[key] || { bytes: 0, files: 0 };
      const li = document.createElement('li');
      const body = document.createElement('div');
      const title = document.createElement('b');
      title.textContent = label;
      const small = document.createElement('small');
      small.textContent = `${note} · ${info.files} file${info.files === 1 ? '' : 's'}`;
      body.append(title, small);

      const size = document.createElement('span');
      size.className = 'storage-size';
      size.textContent = fmtBytes(info.bytes);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn ghost small danger';
      del.textContent = 'Delete';
      del.disabled = !info.files;
      del.addEventListener('click', () => clearStorage([key], label));

      li.append(body, size, del);
      list.appendChild(li);
    });
  }

  async function refreshStorage() {
    const list = $('#storage-list');
    const total = $('#storage-total');
    if (!list || !total) return;
    if (state.engine.mode === 'demo') {
      storageData = null;
      total.textContent = 'Engine offline — nothing on disk';
      list.innerHTML = '';
      return;
    }
    try {
      const res = await fetch('/api/storage', { cache: 'no-store' });
      if (!res.ok) throw new Error('offline');
      storageData = await res.json();
      renderStorage();
    } catch {
      total.textContent = 'Could not read the cache';
    }
  }

  async function clearStorage(what, label) {
    if (state.engine.mode === 'demo') return;
    try {
      const res = await fetch('/api/storage/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ what }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not delete those files.');
      storageData = data && data.cache ? data : null;
      if (storageData) renderStorage(); else refreshStorage();
      if (what.includes('clips')) {
        state.clips = [];
        state.liveClips = [];
        renderClips();
        renderLiveClips();
      }
      notify('Deleted', `${label || 'Files'} — ${fmtBytes(data.freed || 0)} freed.`, { type: 'success' });
    } catch (err) {
      toast(err && err.message ? err.message : 'Could not delete those files.', 'error');
    }
  }

  /* ───────────────────────── sync + wiring ───────────────────────── */
  function syncControls() {
    const s = state.settings;
    $('#min-length').value = String(s.minLen);
    $('#max-length').value = String(s.maxLen);
    $('#min-length-out').textContent = `${s.minLen}s`;
    $('#max-length-out').textContent = `${s.maxLen}s`;
    $$('#clip-count button').forEach((btn) => btn.setAttribute('aria-pressed', String(Number(btn.dataset.count) === s.count)));
    $('#layout-select').value = s.layout;
    $('#lang-select').value = s.language;
    $$('#style-chips .style-chip').forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.style === s.captionStyle)));
    $('#live-layout').value = s.layout;
    $('#live-auto').checked = s.autoClip;
    $('#live-sensitivity').value = String(s.sensitivity);
    $('#live-sensitivity-out').textContent = `${s.sensitivity.toFixed(1)}σ`;
    $('#live-preroll').value = String(s.preroll);
    $('#live-preroll-out').textContent = `${s.preroll}s`;
    $('#preset-select').value = PRESETS[s.preset] ? s.preset : 'reels';
    $('#preset-note').textContent = (PRESETS[s.preset] || PRESETS.reels).note;
    frameNote();
    $('#make-hint').textContent = `${s.count} clip${s.count === 1 ? '' : 's'} · ${s.captions ? 'captions on' : 'no captions'}`;
  }

  function setView(name) {
    state.view = name;
    $$('.tab').forEach((btn) => btn.setAttribute('aria-selected', String(btn.dataset.view === name)));
    $$('.view').forEach((view) => { view.hidden = view.id !== `view-${name}`; });
    if (name === 'library') {
      renderLibrary();
      refreshStorage();
    }
    if (name === 'studio') updateResultsMeta();
    if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  }

  function bind() {
    $$('.tab').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view)));
    $$('[data-goto]').forEach((el) => el.addEventListener('click', () => setView(el.dataset.goto)));

    // notifications
    $('#notif-bell').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleNotifPanel();
    });
    $('#notif-clear').addEventListener('click', () => {
      notifications.length = 0;
      renderNotifList();
    });
    document.addEventListener('click', (e) => {
      const panel = $('#notif-panel');
      if (!panel || panel.hidden) return;
      if (!panel.contains(e.target) && !$('#notif-bell').contains(e.target)) toggleNotifPanel(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') toggleNotifPanel(false);
    });

    // cache + clips on disk
    $('#storage-refresh').addEventListener('click', refreshStorage);
    $('#storage-clear-all').addEventListener('click', () => {
      if (!window.confirm('Delete the cache, every rendered clip and every upload from this disk? Saved library entries stay, but their files will be gone.')) return;
      clearStorage(['cache', 'clips', 'uploads'], 'Cache, clips and uploads');
    });

    $$('[data-captions]').forEach((input) => {
      input.addEventListener('change', () => setCaptions(input.checked));
    });

    $('#source-url').addEventListener('input', () => {
      const value = $('#source-url').value.trim();
      const info = detectSource(value);
      const badge = $('#source-kind');
      badge.textContent = info.label;
      badge.dataset.known = String(info.known);
      $('#source-hint').textContent = !value
        ? 'Videos and past broadcasts work. Live streams go in the Live tab.'
        : info.known
          ? `${info.label} detected — past broadcasts and VODs work best.`
          : 'Unknown host — the engine will try yt-dlp anyway.';
    });

    $('#file-input').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      state.file = file;
      frame.img = null;
      state.thumbUrl = '';
      $('#file-name').textContent = file.name;
      $('#file-chip').hidden = false;
      if (state.engine.mode !== 'demo') {
        $('#source-hint').textContent = 'Local file ready — the engine cuts it for real. There is no transcript for local files, so clips render without burned captions.';
      }
      toast(`${file.name} loaded.`);
    });

    $('#file-clear').addEventListener('click', () => {
      state.file = null;
      $('#file-input').value = '';
      $('#file-chip').hidden = true;
    });

    $('#reset-source').addEventListener('click', () => {
      if (state.job) stopClipping();
      state.file = null;
      state.clips = [];
      frame.img = null;
      state.thumb = '';
      $('#source-url').value = '';
      $('#file-input').value = '';
      $('#file-chip').hidden = true;
      $('#source-kind').textContent = 'Link';
      $('#source-kind').dataset.known = 'false';
      $('#source-hint').textContent = 'Videos and past broadcasts work. Live streams go in the Live tab.';
      $('#progress').hidden = true;
      $('#make-clips').disabled = false;
      renderClips();
      toast('Cleared.');
    });

    const minRange = $('#min-length');
    const maxRange = $('#max-length');
    minRange.addEventListener('input', () => {
      let min = Number(minRange.value);
      let max = Number(maxRange.value);
      if (min > max - 5) {
        max = Math.min(120, min + 5);
        maxRange.value = String(max);
        state.settings.maxLen = max;
        $('#max-length-out').textContent = `${max}s`;
      }
      state.settings.minLen = min;
      $('#min-length-out').textContent = `${min}s`;
      persistSettings();
    });
    maxRange.addEventListener('input', () => {
      let max = Number(maxRange.value);
      let min = Number(minRange.value);
      if (max < min + 5) {
        min = Math.max(15, max - 5);
        minRange.value = String(min);
        state.settings.minLen = min;
        $('#min-length-out').textContent = `${min}s`;
      }
      state.settings.maxLen = max;
      $('#max-length-out').textContent = `${max}s`;
      persistSettings();
    });

    $$('#clip-count button').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.settings.count = Number(btn.dataset.count);
        $$('#clip-count button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        persistSettings();
        $('#make-hint').textContent = `${state.settings.count} clip${state.settings.count === 1 ? '' : 's'} · ${state.settings.captions ? 'captions on' : 'no captions'}`;
      });
    });

    $('#layout-select').addEventListener('change', (e) => {
      state.settings.layout = e.target.value;
      persistSettings();
    });

    $('#lang-select').addEventListener('change', (e) => {
      state.settings.language = e.target.value;
      persistSettings();
    });

    $$('#style-chips .style-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.settings.captionStyle = btn.dataset.style;
        $$('#style-chips .style-chip').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        persistSettings();
        $$('canvas[data-clip]').forEach((canvas) => {
          const clip = findClip(canvas.dataset.clip);
          if (clip) drawPoster(canvas, { ...clip, style: state.settings.captionStyle });
        });
      });
    });

    $('#make-clips').addEventListener('click', makeClips);
    $('#source-url').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') makeClips();
    });

    $('#preset-select').addEventListener('change', (e) => applyPreset(e.target.value));

    $$('#caption-mode button').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!state.settings.captions) {
          toast('Captions are off — switch them on first.');
          return;
        }
        setCaptionMode(btn.dataset.mode);
      });
    });

    bindFrameEditor();

    $('#stop-clip').addEventListener('click', stopClipping);
    $('#review-open').addEventListener('click', () => openReview(state.job, state.reviewData));
    $('#review-start').addEventListener('click', approveReview);
    $('#frame-apply-all').addEventListener('click', applyRegionToAll);
    $$('#review-layout button').forEach((btn) => {
      btn.addEventListener('click', () => {
        review.layout = btn.dataset.layout;
        $$('#review-layout button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
        state.settings.layout = review.layout;
        persistSettings();
        const select = $('#layout-select');
        if (select) select.value = review.layout;
        drawFramePreview();
      });
    });

    // watchlist
    $('#watch-form').addEventListener('submit', (e) => {
      e.preventDefault();
      addWatch($('#watch-input').value);
      $('#watch-input').value = '';
    });

    // live
    $('#live-start').addEventListener('click', startLive);
    $('#live-stop').addEventListener('click', () => stopLive(false));
    $('#live-now').addEventListener('click', () => requestLiveClip(live.base, 'manual'));
    $('#live-frame').addEventListener('click', () => openFrameEditor());
    $('#live-layout').addEventListener('change', (e) => {
      state.settings.layout = e.target.value;
      persistSettings();
      const studio = $('#layout-select');
      if (studio) studio.value = e.target.value;
    });
    $('#live-url').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') startLive();
    });
    $('#live-auto').addEventListener('change', (e) => {
      state.settings.autoClip = e.target.checked;
      persistSettings();
      toast(e.target.checked ? 'Auto-clip on.' : 'Auto-clip off — spikes are logged only.');
    });
    $('#live-sensitivity').addEventListener('input', (e) => {
      state.settings.sensitivity = Number(e.target.value);
      $('#live-sensitivity-out').textContent = `${state.settings.sensitivity.toFixed(1)}σ`;
      persistSettings();
      drawSpark();
    });
    $('#live-preroll').addEventListener('input', (e) => {
      state.settings.preroll = Number(e.target.value);
      $('#live-preroll-out').textContent = `${state.settings.preroll}s`;
      persistSettings();
    });

    // library
    $('#clear-library').addEventListener('click', () => {
      if (!state.library.length) return;
      if (!window.confirm('Remove every saved clip from this device? Rendered files are deleted from disk too.')) return;
      const files = state.library.map((clip) => clip.file).filter(Boolean);
      state.library = [];
      persistLibrary();
      renderLibrary();
      files.forEach((file) => {
        fetch('/api/storage/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file }),
        }).catch(() => {});
      });
      toast('Library cleared.', 'success');
      refreshStorage();
    });

    window.addEventListener('resize', () => {
      if (state.view === 'live') drawSpark();
    });

    // buy me a coffee
    const coffeeBtn = $('#coffee-btn');
    const coffeeDlg = $('#coffee-dialog');
    const coffeeClose = $('#coffee-close');
    if (coffeeBtn && coffeeDlg) {
      coffeeBtn.addEventListener('click', () => {
        if (typeof coffeeDlg.showModal === 'function') {
          if (!coffeeDlg.open) coffeeDlg.showModal();
        } else {
          coffeeDlg.setAttribute('open', '');
        }
      });
      if (coffeeClose) {
        coffeeClose.addEventListener('click', () => {
          if (typeof coffeeDlg.close === 'function') coffeeDlg.close();
          else coffeeDlg.removeAttribute('open');
        });
      }
      coffeeDlg.addEventListener('click', (e) => {
        if (e.target === coffeeDlg) {
          if (typeof coffeeDlg.close === 'function') coffeeDlg.close();
          else coffeeDlg.removeAttribute('open');
        }
      });
    }
  }

  /* ───────────────────────── init ───────────────────────── */
  function init() {
    bind();
    syncControls();
    applyCaptions();
    renderClips();
    renderLiveClips();
    renderLibrary();
    renderWatch();
    updateCounts();
    paintEngine();
    renderNotifList();
    engineCheck();
    const initial = (location.hash || '#studio').replace('#', '');
    setView(['studio', 'live', 'library'].includes(initial) ? initial : 'studio');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
