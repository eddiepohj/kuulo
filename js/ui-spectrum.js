// Spectrum screen: peak frequency / level cards, audioMotion bars, an own-canvas waterfall, controls.
// Contract: init(section, { store, audio }) -> { show(), hide() }.
// audioMotion is created once (the first time audio starts) and only re-wired to each new source.
// One animation frame loop while shown; audioMotion's onCanvasDraw feeds the waterfall and the peak level.

import AudioMotionAnalyzer from '../vendor/audioMotion-analyzer.js';
import { buildLut, dbToIndex } from './colormap.js';
import { findPeak, formatHz, formatNote } from './peak.js';
import { curve } from './weighting.js';
import { fmt1, segmented } from './ui-common.js';

const DASH = '–';
const MIN_HZ = 25;
const MAX_HZ = 16000;
const LN_MIN = Math.log(MIN_HZ);
const LN_SPAN = Math.log(MAX_HZ) - LN_MIN;
const MIN_DB = -110; // audioMotion's dBFS range: bar value 0..1 spans these
const MAX_DB = -20;
const TONE_COMP_DB = 13.55; // Blackman coherent gain × one-sided amplitude: a pure tone's peak band reads like the Meter
const NOMINAL_OFFSET = 100; // uncalibrated waterfall: -90..-30 dBFS maps onto the 10..70 colour scale
const ROWS = 120; // 12 s of history at one row per 100 ms
const ROW_MS = 100;
const PEAK_MS = 100;
const X_MARKS = [[31.5, '31'], [125, '125'], [500, '500'], [2000, '2k'], [8000, '8k']];

const VIEWS = [{ value: 'fall', label: 'Waterfall' }, { value: 'bars', label: 'Bars' }];
const RESOLUTIONS = [{ value: 3, label: '1/3' }, { value: 6, label: '1/6' }];
const WEIGHTINGS = [{ value: 'A', label: 'A' }, { value: 'C', label: 'C' }, { value: 'Z', label: 'Z' }];

const MARKUP = `
<div class="topbar">
  <div class="brand">kuulo</div>
  <div class="pill"><span class="dot" data-r="dot"></span><span data-r="live">OFF</span></div>
</div>

<div class="sp-cards">
  <div class="sp-card">
    <div class="sp-card-label">PEAK FREQUENCY</div>
    <div class="sp-card-value acc" data-r="hz">–</div>
    <div class="sp-card-sub" data-r="note">no clear tone</div>
  </div>
  <div class="sp-card">
    <div class="sp-card-label">PEAK LEVEL</div>
    <div class="sp-card-value" data-r="pdb">–</div>
    <div class="sp-card-sub" data-r="psub">dB(A) in band</div>
  </div>
</div>

<div class="sp-plot" data-r="plot" data-view="fall">
  <div class="sp-row">
    <div class="sp-ycol" data-r="ycol" aria-hidden="true"></div>
    <div class="sp-am" data-r="am">
      <i class="sp-guide" style="top: 25%"></i>
      <i class="sp-guide" style="top: 50%"></i>
      <i class="sp-guide" style="top: 75%"></i>
    </div>
  </div>
  <div class="sp-row sp-fallrow">
    <div class="sp-tcol" aria-hidden="true">
      <span style="top: 0">now</span>
      <span style="top: 33.33%">−4 s</span>
      <span style="top: 66.66%">−8 s</span>
      <span style="bottom: 0">−12 s</span>
    </div>
    <div class="sp-wf" data-r="wfbox"><canvas data-r="wf" role="img" aria-label="Waterfall: frequency across, last 12 seconds downward"></canvas></div>
  </div>
  <div class="sp-xl" data-r="xl" aria-hidden="true"></div>
  <div class="sp-caption">
    <span data-r="cap">Hz · 1/3 oct, A-weighted</span>
    <div class="sp-legend"><span data-r="lg0">10</span><i class="sp-grad"></i><span data-r="lg1">70 dB</span></div>
  </div>
</div>

<div class="sp-controls">
  <div class="sp-line">
    <div data-r="segv"></div>
    <button type="button" class="btn" data-r="freeze" aria-pressed="false">Freeze</button>
  </div>
  <div class="sp-line">
    <div data-r="segr"></div>
    <div data-r="segw"></div>
  </div>
</div>
`;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
// Whole-number label through fmt1 (keeps the U+2212 minus).
const fmt0 = (v) => fmt1(Math.round(v)).replace(/\.0$/, '');

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// Longer card values get a smaller size (see app.css) so they fit the card on a 390 px screen.
function setLen(node, text) {
  const len = text.length >= 9 ? '9' : text.length === 8 ? '8' : '';
  if ((node.dataset.len || '') !== len) node.dataset.len = len;
}

export function init(section, { store, audio }) {
  section.innerHTML = MARKUP;
  const r = {};
  for (const n of section.querySelectorAll('[data-r]')) r[n.dataset.r] = n;

  // X-axis labels at log positions (static: the axis never changes).
  for (const [f, label] of X_MARKS) {
    const s = document.createElement('span');
    s.textContent = label;
    s.style.left = `${(((Math.log(f) - LN_MIN) / LN_SPAN) * 100).toFixed(2)}%`;
    r.xl.appendChild(s);
  }

  // State
  let cfg = store.get();
  let applied = { view: null, res: null, weighting: null, offsetDb: undefined };
  let am = null; // the audioMotion instance, created on the first source
  let connected = null; // the source node audioMotion is currently fed from
  let shown = false;
  let frozen = false;
  let pendingClear = false; // a restart happened while frozen: clear the waterfall on Resume
  let raf = 0;
  let dirty = true; // cards need a redraw
  let peakHz = null; // from the analyser (null = no clear tone)
  let peakDbfs = null; // strongest audioMotion bar, in dBFS (null = none)
  let lastPeakAt = 0;
  let wasRunning = false;
  let nextRow = 0; // rAF timestamp when the next waterfall row is due
  let weightDb = (f) => curve('A', f);
  let buf = null; // analyser spectrum, reused

  // Waterfall canvas
  const lut32 = (() => {
    const lut = buildLut();
    return new Uint32Array(lut.buffer, lut.byteOffset, 256);
  })();
  const wfCtx = r.wf.getContext('2d');
  let wfW = 0;
  let wfH = 0;
  let rowPx = 1;
  let rowImg = null; // one ImageData row (rowPx pixel lines), reused
  let row32 = null;

  const viewSeg = segmented(r.segv, VIEWS, cfg.spectrum.view, (v) => {
    store.update((s) => { s.spectrum.view = v; });
  });
  const resSeg = segmented(r.segr, RESOLUTIONS, cfg.spectrum.res, (v) => {
    store.update((s) => { s.spectrum.res = v; });
  }, { mono: true });
  const weightSeg = segmented(r.segw, WEIGHTINGS, cfg.spectrum.weighting, (v) => {
    store.update((s) => { s.spectrum.weighting = v; });
  }, { mono: true });

  // ---- Waterfall -------------------------------------------------------------------------------

  // Backing store = CSS size x devicePixelRatio, with the height snapped to a whole number of
  // pixel lines per row so 120 rows are exactly 12 s. Zero sizes (screen hidden) are ignored.
  function sizeWaterfall() {
    const cssW = r.wfbox.clientWidth;
    const cssH = r.wfbox.clientHeight;
    if (!cssW || !cssH) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(cssW * dpr);
    const rp = Math.max(1, Math.round((cssH * dpr) / ROWS));
    const h = ROWS * rp;
    if (w === wfW && h === wfH) return;
    wfW = w;
    wfH = h;
    rowPx = rp;
    r.wf.width = w; // also clears the canvas
    r.wf.height = h;
    rowImg = wfCtx.createImageData(w, rp);
    row32 = new Uint32Array(rowImg.data.buffer);
  }

  function clearWaterfall() {
    pendingClear = false;
    if (wfW) wfCtx.clearRect(0, 0, wfW, wfH);
  }

  const xOf = (f) => clamp(Math.round((wfW * (Math.log(f) - LN_MIN)) / LN_SPAN), 0, wfW);

  // Shift the picture down one row, then paint the newest row on top. The row is built in `row32`.
  function paintRow(bars) {
    if (!wfW) sizeWaterfall();
    if (!wfW) return;
    const off = (cfg.offsetDb ?? NOMINAL_OFFSET) + TONE_COMP_DB;
    const range = MAX_DB - MIN_DB;
    wfCtx.drawImage(r.wf, 0, 0, wfW, wfH - rowPx, 0, rowPx, wfW, wfH - rowPx);
    row32.fill(lut32[0], 0, wfW);
    let x0 = -1;
    for (const b of bars) {
      const db = MIN_DB + b.value[0] * range + off;
      if (x0 < 0) x0 = xOf(b.freqLo);
      const x1 = xOf(b.freqHi);
      if (x1 > x0) row32.fill(lut32[dbToIndex(db)], x0, x1);
      x0 = Math.max(x0, x1); // neighbouring bands share an edge: no gaps
    }
    for (let i = 1; i < rowPx; i++) row32.copyWithin(i * wfW, 0, wfW);
    wfCtx.putImageData(rowImg, 0, 0);
  }

  // ---- audioMotion -----------------------------------------------------------------------------

  // Called after every audioMotion frame. Throttled to one row per 100 ms (on average: a frame
  // within half a frame of the due time counts as due, so 60 Hz gives an even 10 rows/s).
  function onDraw(instance, info) {
    const ts = info.timestamp;
    if (frozen || !audio.running() || ts < nextRow - 8) return;
    nextRow = ts - nextRow > 2 * ROW_MS ? ts + ROW_MS : nextRow + ROW_MS;

    const bars = instance.getBars();
    let top = 0;
    for (const b of bars) if (b.value[0] > top) top = b.value[0];
    peakDbfs = top > 0 ? MIN_DB + top * (MAX_DB - MIN_DB) : null;
    dirty = true;
    paintRow(bars);
  }

  function createAm(ctx) {
    const s = cfg.spectrum;
    am = new AudioMotionAnalyzer(r.am, {
      audioCtx: ctx,
      connectSpeakers: false,
      mode: s.res === 3 ? 6 : 4,
      frequencyScale: 'log',
      ansiBands: true,
      minFreq: MIN_HZ,
      maxFreq: MAX_HZ,
      weightingFilter: s.weighting === 'Z' ? '' : s.weighting,
      ledBars: s.view === 'bars',
      showScaleY: false,
      showScaleX: false,
      showPeaks: true,
      fftSize: 8192,
      smoothing: 0.5,
      minDecibels: MIN_DB,
      maxDecibels: MAX_DB,
      overlay: true,
      showBgColor: false,
      bgAlpha: 0,
      start: false,
      onCanvasDraw: onDraw,
    });
    am.registerGradient('kuulo', { bgColor: '#0F1113', colorStops: ['#F5A524'] });
    am.gradient = 'kuulo';
    // The container may have been hidden (zero size) when the options were read: fit it now.
    fitAm();
  }

  // audioMotion follows its container; assigning `height` re-reads the size right away instead
  // of waiting for the ResizeObserver debounce.
  function fitAm() {
    if (am) am.height = undefined;
  }

  // A new source after each start (and the test tone). The context never changes, so the
  // instance is reused. The old source was already disconnected by audio.stop(), so disconnecting
  // it from audioMotion may throw; that is harmless.
  audio.onSource((source, ctx) => {
    try {
      if (!am) {
        createAm(ctx);
      } else if (connected) {
        try { am.disconnectInput(connected); } catch { /* already disconnected */ }
      }
      am.connectInput(source);
      connected = source;
      if (shown && !frozen) am.toggleAnalyzer(true);
    } catch (e) {
      console.error(e);
    }
    if (frozen) pendingClear = true;
    else clearWaterfall();
    nextRow = 0;
    peakHz = null;
    peakDbfs = null;
    dirty = true;
  });

  // ---- Settings --------------------------------------------------------------------------------

  function applySettings() {
    const { view, res, weighting } = cfg.spectrum;
    const off = cfg.offsetDb;
    const cal = off != null;
    const viewChanged = view !== applied.view;
    const resChanged = res !== applied.res;
    const weightingChanged = weighting !== applied.weighting;
    const offsetChanged = off !== applied.offsetDb;
    applied = { view, res, weighting, offsetDb: off };

    viewSeg.set(view);
    resSeg.set(res);
    weightSeg.set(weighting);
    r.plot.dataset.view = view;
    weightDb = (f) => curve(weighting, f);

    if (am) {
      if (resChanged) am.mode = res === 3 ? 6 : 4;
      if (weightingChanged) am.weightingFilter = weighting === 'Z' ? '' : weighting;
      // Assigning ledBars rebuilds the bars, which also drops peak markers from the old settings.
      if (viewChanged || resChanged || weightingChanged) am.ledBars = view === 'bars';
      if (viewChanged) fitAm();
    }
    // Resolution, weighting and offset change what a row means: start the picture over.
    if (resChanged || weightingChanged || offsetChanged) {
      clearWaterfall();
      peakDbfs = null;
    }

    // Y labels (Bars view): every 20 dB, at their true height in the compensated, offset range.
    const shift = TONE_COMP_DB + (off ?? 0);
    const top = MAX_DB + shift;
    const bottom = MIN_DB + shift;
    let yHtml = '';
    for (let v = Math.floor(top / 20) * 20; v >= bottom; v -= 20) {
      yHtml += `<span style="top: ${(((top - v) / (top - bottom)) * 100).toFixed(2)}%">${fmt0(v)}</span>`;
    }
    if (r.ycol.dataset.key !== yHtml) {
      r.ycol.innerHTML = yHtml;
      r.ycol.dataset.key = yHtml;
    }

    setText(r.cap, `Hz · ${res === 3 ? '1/3' : '1/6'} oct, ${weighting}-weighted`);
    setText(r.lg0, cal ? '10' : fmt0(10 - NOMINAL_OFFSET));
    setText(r.lg1, cal ? '70 dB' : `${fmt0(70 - NOMINAL_OFFSET)} dBFS`);
    setText(r.psub, `${cal ? `dB(${weighting})` : 'dBFS'} in band`);
    dirty = true;
  }

  store.subscribe((s) => {
    try {
      cfg = s;
      applySettings();
    } catch (e) {
      console.error(e);
    }
  });

  // ---- Readout and frame loop ------------------------------------------------------------------

  function readPeak() {
    const an = audio.getAnalyser();
    const ctx = audio.getContext();
    if (!an || !ctx) {
      peakHz = null;
      return;
    }
    if (!buf || buf.length !== an.frequencyBinCount) buf = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(buf);
    const p = findPeak(buf, { sampleRate: ctx.sampleRate, fftSize: an.fftSize, weightDb });
    peakHz = p ? p.hz : null;
    dirty = true;
  }

  function renderCards() {
    const live = audio.running() || frozen;
    const hz = live ? peakHz : null;
    const hzText = hz == null ? DASH : formatHz(hz);
    setText(r.hz, hzText);
    setLen(r.hz, hzText);
    setText(r.note, hz == null ? 'no clear tone' : formatNote(hz));

    const db = live ? peakDbfs : null;
    const dbText = db == null ? DASH : `≈ ${fmt1(db + TONE_COMP_DB + (cfg.offsetDb ?? 0))}`;
    setText(r.pdb, dbText);
    setLen(r.pdb, dbText);
  }

  function renderStatus() {
    let label;
    let live = false;
    if (frozen) {
      label = 'FROZEN';
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
    setText(r.freeze, frozen ? 'Resume' : 'Freeze');
    r.freeze.classList.toggle('on', frozen);
    r.freeze.setAttribute('aria-pressed', String(frozen));
  }

  function frame(t) {
    raf = requestAnimationFrame(frame);
    const running = audio.running();
    if (running !== wasRunning) {
      wasRunning = running;
      dirty = true;
    }
    if (!frozen && running && t - lastPeakAt >= PEAK_MS) {
      lastPeakAt = t;
      readPeak();
    }
    if (dirty) {
      dirty = false;
      renderCards();
    }
    renderStatus();
  }

  // ---- Controls --------------------------------------------------------------------------------

  r.freeze.addEventListener('click', () => {
    frozen = !frozen;
    if (frozen) {
      if (am && shown) am.toggleAnalyzer(false);
    } else {
      if (pendingClear) clearWaterfall();
      nextRow = 0;
      if (am && shown) am.toggleAnalyzer(true);
    }
    dirty = true;
  });

  if (typeof ResizeObserver === 'function') new ResizeObserver(sizeWaterfall).observe(r.wfbox);
  else window.addEventListener('resize', sizeWaterfall);

  applySettings();
  renderCards();
  renderStatus();

  return {
    show() {
      shown = true;
      cfg = store.get();
      applySettings();
      sizeWaterfall();
      fitAm();
      if (am && !frozen) am.toggleAnalyzer(true);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    },
    hide() {
      shown = false;
      cancelAnimationFrame(raf);
      raf = 0;
      if (am) am.toggleAnalyzer(false);
    },
  };
}
