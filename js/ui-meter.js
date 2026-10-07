// Meter screen: live level, range bar, Leq/Max/Min/Time tiles, 60 s history, weighting/response/hold/reset.
// Contract: init(section, { store, audio }) -> { show(), hide() }.
// Meter messages are kept in a variable and drawn at most once per animation frame while the screen is shown.

import { MIN_DBFS } from './meter-worklet.js';
import { fmt1, fmtSigned, segmented } from './ui-common.js';
import { displayLevel, unitLabel, describe, floorDb, ceilingDb } from './calibration.js';

const HISTORY_LEN = 60;
const DASH = '–';
const TICKS = 6; // 20..120 dB or -100..0 dBFS, one label every 20

const WEIGHTINGS = [{ value: 'A', label: 'A' }, { value: 'C', label: 'C' }, { value: 'Z', label: 'Z' }];
const RESPONSES = [{ value: 'F', label: 'Fast' }, { value: 'S', label: 'Slow' }];
const RESPONSE_LABEL = { F: 'Fast · 125 ms', S: 'Slow · 1 s' };

const MARKUP = `
<div class="topbar">
  <div class="brand">kuulo</div>
  <div class="topbar-right">
    <div class="pill"><span class="dot" data-r="dot"></span><span data-r="live">OFF</span></div>
    <button type="button" class="pill pill-btn" data-r="cal" aria-label="Open calibration">UNCAL</button>
  </div>
</div>

<div class="meter-readout">
  <div class="meter-resp" data-r="resp">Fast · 125 ms</div>
  <div class="meter-over" data-r="over" aria-hidden="true">OVER</div>
  <div class="meter-row">
    <div class="meter-level" data-r="level">–</div>
    <div class="meter-unit" data-r="unit">dBFS</div>
  </div>
  <div class="meter-desc" data-r="desc"></div>
</div>

<div class="meter-range">
  <div class="meter-bar">
    <div class="meter-zone-floor" data-r="zfloor"></div>
    <div class="meter-zone-ceil" data-r="zceil"></div>
    <div class="meter-fill" data-r="fill"></div>
    <div class="meter-max" data-r="maxmark"></div>
  </div>
  <div class="meter-ticks" data-r="ticks"></div>
  <div class="meter-caps">
    <span data-r="capfloor"></span>
    <span class="over" data-r="capceil"></span>
  </div>
</div>

<div class="meter-tiles">
  <div class="tile"><div class="tile-label" data-r="leqname">LAEQ</div><div class="tile-value" data-r="leq">–</div></div>
  <div class="tile"><div class="tile-label">MAX</div><div class="tile-value" data-r="max">–</div></div>
  <div class="tile"><div class="tile-label">MIN</div><div class="tile-value" data-r="min">–</div></div>
  <div class="tile"><div class="tile-label">TIME</div><div class="tile-value" data-r="time">00:00</div></div>
</div>

<div class="meter-hist">
  <div class="meter-hist-head"><span>LAST 60 S</span><span class="mono" data-r="histcap">20–100 dB</span></div>
  <div class="meter-bars" data-r="bars"></div>
</div>

<div class="meter-controls">
  <div class="meter-line">
    <div class="meter-seg-w" data-r="segw"></div>
    <div class="meter-seg-r" data-r="segr"></div>
  </div>
  <div class="meter-line">
    <button type="button" class="btn meter-btn" data-r="hold" aria-pressed="false">Hold</button>
    <button type="button" class="btn meter-btn" data-r="reset">Reset</button>
  </div>
</div>
`;

const valid = (v) => typeof v === 'number' && Number.isFinite(v) && v > MIN_DBFS;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const pad2 = (n) => String(n).padStart(2, '0');
// Whole-number label through fmt1 (keeps the U+2212 minus).
const fmt0 = (v) => fmt1(Math.round(v)).replace(/\.0$/, '');
const now = () => performance.now();

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

export function init(section, { store, audio }) {
  section.innerHTML = MARKUP;
  const r = {};
  for (const n of section.querySelectorAll('[data-r]')) r[n.dataset.r] = n;

  const bars = [];
  for (let i = 0; i < HISTORY_LEN; i++) {
    const b = document.createElement('div');
    r.bars.appendChild(b);
    bars.push(b);
  }

  // State
  let cfg = store.get();
  let latest = null; // last meter message (not updated while held)
  let hist = []; // secondLeq values in dBFS, oldest first
  let held = false;
  let t0 = now();
  let frozenMs = 0; // TIME shown while held
  let raf = 0;
  let dirty = true; // readout / range / tiles need a redraw
  let histDirty = true;
  // Scale for the current calibration state: bar range (lo..hi) and history range (hLo..hHi).
  let scale = { lo: -100, hi: 0, hLo: -100, hHi: -20 };

  const weightingSeg = segmented(r.segw, WEIGHTINGS, cfg.meter.weighting, (w) => {
    store.update((s) => { s.meter.weighting = w; });
  }, { mono: true });
  const responseSeg = segmented(r.segr, RESPONSES, cfg.meter.response, (v) => {
    store.update((s) => { s.meter.response = v; });
  });

  function clearStats() {
    latest = null;
    hist = [];
    t0 = now();
    frozenMs = 0;
    dirty = true;
    histDirty = true;
  }

  // Settings-dependent parts: scale, ticks, zones, captions, labels.
  function applySettings() {
    const off = cfg.offsetDb;
    const cal = off != null;
    scale = cal ? { lo: 20, hi: 120, hLo: 20, hHi: 100 } : { lo: -100, hi: 0, hLo: -100, hHi: -20 };

    let ticksHtml = '';
    for (let i = 0; i < TICKS; i++) ticksHtml += `<span>${fmt0(scale.lo + i * 20)}</span>`;
    if (r.ticks.dataset.key !== ticksHtml) {
      r.ticks.innerHTML = ticksHtml;
      r.ticks.dataset.key = ticksHtml;
    }

    const span = scale.hi - scale.lo;
    const floor = floorDb(cfg);
    const ceil = ceilingDb(cfg);
    r.zfloor.style.width = floor == null ? '0%' : `${clamp01((floor - scale.lo) / span) * 100}%`;
    r.zceil.style.width = `${clamp01((scale.hi - ceil) / span) * 100}%`;
    setText(r.capfloor, floor == null ? 'floor not measured' : `below ${fmt0(floor)}: mic noise`);
    setText(r.capceil, `over ${fmt0(ceil)}${cal ? '' : ' dBFS'}: clipping`);

    // A dash between negative numbers reads as a minus sign, so spell the uncalibrated range out.
    setText(r.histcap, cal ? `${fmt0(scale.hLo)}–${fmt0(scale.hHi)} dB` : `${fmt0(scale.hLo)} to ${fmt0(scale.hHi)} dBFS`);
    setText(r.leqname, `L${cfg.meter.weighting}EQ`);
    setText(r.unit, unitLabel(cfg.meter.weighting, off));
    setText(r.cal, cal ? `CAL ${fmtSigned(off)}` : 'UNCAL');
    weightingSeg.set(cfg.meter.weighting);
    responseSeg.set(cfg.meter.response);
    dirty = true;
    histDirty = true;
  }

  const pos = (dbfs) => clamp01((displayLevel(dbfs, cfg.offsetDb) - scale.lo) / (scale.hi - scale.lo));

  function renderValues() {
    const off = cfg.offsetDb;
    const m = latest;
    const lvl = m && valid(m.level) ? m.level : null;
    const text = lvl == null ? DASH : fmt1(displayLevel(lvl, off));
    setText(r.level, text);
    // Longer numbers get a smaller size (see app.css) so they fit next to the unit on a 390 px screen.
    const len = text.length >= 6 ? '6' : text.length === 5 ? '5' : '';
    if ((r.level.dataset.len || '') !== len) r.level.dataset.len = len;
    setText(r.desc, lvl == null ? '' : describe(lvl, cfg));
    r.over.classList.toggle('on', !!(m && m.clipped));

    r.fill.style.width = lvl == null ? '0%' : `${(pos(lvl) * 100).toFixed(2)}%`;
    if (m && valid(m.max)) {
      r.maxmark.style.display = '';
      r.maxmark.style.left = `calc((100% - 2px) * ${pos(m.max).toFixed(4)})`;
    } else {
      r.maxmark.style.display = 'none';
    }

    const tile = (v) => (valid(v) ? fmt1(displayLevel(v, off)) : DASH);
    setText(r.leq, tile(m && m.leq));
    setText(r.max, tile(m && m.max));
    setText(r.min, tile(m && m.min));
  }

  function renderHistory() {
    const { hLo, hHi } = scale;
    const off = cfg.offsetDb;
    const n = hist.length;
    for (let i = 0; i < HISTORY_LEN; i++) {
      const v = hist[n - HISTORY_LEN + i]; // right-aligned: newest in the last slot
      const b = bars[i];
      if (v === undefined) {
        b.style.height = '0%';
        b.classList.remove('new');
      } else {
        const pct = clamp01((displayLevel(v, off) - hLo) / (hHi - hLo)) * 100;
        b.style.height = `${Math.max(2, pct).toFixed(1)}%`;
        b.classList.toggle('new', i === HISTORY_LEN - 1);
      }
    }
  }

  // Cheap per-frame parts: live pill, response label, hold button, clock.
  function renderStatus() {
    let label;
    let live = false;
    if (held) {
      label = 'HOLD';
    } else if (!audio.running()) {
      label = 'OFF';
    } else {
      const { sampleRate, source } = audio.info();
      const khz = sampleRate ? ` ${Number((sampleRate / 1000).toFixed(1))} kHz` : '';
      label = `${source === 'tone' ? 'TONE' : 'LIVE'}${khz}`;
      live = true;
    }
    setText(r.live, label);
    r.dot.classList.toggle('live', live);

    setText(r.resp, held ? 'Hold' : RESPONSE_LABEL[cfg.meter.response]);
    setText(r.hold, held ? 'Resume' : 'Hold');
    r.hold.classList.toggle('on', held);
    r.hold.setAttribute('aria-pressed', String(held));

    const secs = Math.floor((held ? frozenMs : now() - t0) / 1000);
    setText(r.time, `${pad2(Math.floor(secs / 60))}:${pad2(secs % 60)}`);
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    if (dirty) { dirty = false; renderValues(); }
    if (histDirty) { histDirty = false; renderHistory(); }
    renderStatus();
  }

  // Data in. Subscribed for the page's lifetime so the history keeps filling on other tabs.
  audio.onMeter((m) => {
    if (held) return;
    latest = m;
    dirty = true;
    if (typeof m.secondLeq === 'number') {
      hist.push(m.secondLeq);
      if (hist.length > HISTORY_LEN) hist.shift();
      histDirty = true;
    }
  });

  // A new start is a fresh measurement: reset the worklet stats and everything shown with them,
  // and release Hold (otherwise the meter would keep dashes after the restart).
  audio.onSource(() => {
    audio.resetMeter();
    clearStats();
    held = false;
  });

  // Settings in
  store.subscribe((s) => {
    try {
      const weightingChanged = s.meter.weighting !== cfg.meter.weighting;
      cfg = s;
      if (weightingChanged) {
        audio.resetMeter(); // Leq across weightings is meaningless
        clearStats();
      }
      applySettings();
    } catch (e) {
      console.error(e);
    }
  });

  // Controls
  r.hold.addEventListener('click', () => {
    held = !held;
    if (held) frozenMs = now() - t0;
    dirty = true;
  });
  r.reset.addEventListener('click', () => {
    audio.resetMeter();
    clearStats();
  });
  r.cal.addEventListener('click', () => {
    section.dispatchEvent(new CustomEvent('kuulo:tab', { detail: 'calibrate', bubbles: true }));
  });

  applySettings();
  renderStatus();

  return {
    show() {
      cfg = store.get();
      applySettings();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    },
    hide() {
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
