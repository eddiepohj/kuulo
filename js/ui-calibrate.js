// Calibrate screen: offset (manual, reference meter, quiet room), measurable range with floor measurement, footer.
// Contract: init(section, { store, audio }) -> { show(), hide() }.
// Subscriptions are registered once at init. Everything shown is drawn by render() from the state below.

import { fmt1, fmtSigned, segmented, VERSION } from './ui-common.js';
import {
  offsetFromReference, offsetFromQuietRoom, nudge, parseReading, energyMean, round1,
  floorDb, ceilingDb, sourceText, todayIso, QUIET_ROOM_DB,
} from './calibration.js';

const DASH = '–';
const BUF_LEN = 10; // rolling buffer of one-second A-weighted Leq values (dBFS)
const REF_SECS = 5;
const QUIET_SECS = 10;
const FLOOR_SECS = 10;
const OFFSET_MAX = 200; // settings.js drops anything outside 0..200
const REPO_URL = 'https://github.com/eddiepohj/kuulo';

const METHODS = [{ value: 'reference', label: 'Reference meter' }, { value: 'quiet', label: 'Quiet room' }];

const MARKUP = `
<div class="topbar">
  <div class="brand">kuulo</div>
  <div class="cal-title">CALIBRATE</div>
</div>

<div class="cal-card cal-offset">
  <div class="cal-offset-row">
    <div>
      <div class="cal-label">OFFSET</div>
      <div class="cal-offset-value"><span data-r="offset">–</span><span data-r="offsetunit"></span></div>
    </div>
    <div class="cal-nudge">
      <button type="button" class="btn" data-r="down" aria-label="Lower offset by 0.5 dB">−</button>
      <button type="button" class="btn" data-r="up" aria-label="Raise offset by 0.5 dB">+</button>
    </div>
  </div>
  <div class="cal-sub">Shown level = phone reading (dBFS) + offset</div>
  <div class="cal-source" data-r="source"></div>
</div>

<div class="cal-block" data-r="methods"></div>

<div class="cal-block cal-panel" data-r="panelref">
  <p class="cal-text">Play a steady sound (fan, shower, pink noise). Hold the phone and the reference meter side by side, then type what the meter shows.</p>
  <p class="cal-text cal-muted">No meter? The free NIOSH SLM app on the same iPhone works: measure the same steady sound in one app, then the other.</p>
  <div class="cal-tiles">
    <div class="cal-tile">
      <div class="cal-label">PHONE READS</div>
      <div class="cal-tile-value"><span data-r="phoneref">–</span><span class="cal-unit"> dBFS</span></div>
    </div>
    <div class="cal-tile">
      <label class="cal-label" for="cal-ref">REFERENCE dB(A)</label>
      <input class="cal-input" id="cal-ref" data-r="refinput" type="text" inputmode="decimal" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done" aria-describedby="cal-ref-err">
      <div class="cal-err" id="cal-ref-err" data-r="referr" role="alert"></div>
    </div>
  </div>
  <button type="button" class="btn btn-primary" data-r="applyref">Set offset from reference</button>
  <div class="cal-note" data-r="refnote" role="status"></div>
</div>

<div class="cal-block cal-panel" data-r="panelquiet" hidden>
  <div class="cal-warn">Rough only. A quiet room (20–30 dB) sits close to the mic's own noise, so the phone hears mostly itself. Normal sounds will likely read a few dB too low.</div>
  <div class="cal-tiles">
    <div class="cal-tile">
      <div class="cal-label">PHONE READS</div>
      <div class="cal-tile-value"><span data-r="phonequiet">–</span><span class="cal-unit"> dBFS</span></div>
    </div>
    <div class="cal-tile">
      <div class="cal-label">ASSUMED ROOM</div>
      <div class="cal-tile-value"><span data-r="assumed"></span><span class="cal-unit"> dB(A)</span></div>
    </div>
  </div>
  <button type="button" class="btn btn-outline" data-r="applyquiet">Use quiet room (±10 dB)</button>
  <div class="cal-note" data-r="quietnote" role="status"></div>
</div>

<div class="cal-card cal-range">
  <div class="cal-range-head">
    <div class="cal-label">MEASURABLE RANGE</div>
    <button type="button" class="btn cal-floor-btn" data-r="measure">Measure floor (10 s)</button>
  </div>
  <div class="cal-note" data-r="floornote" role="status"></div>
  <div class="cal-bar"><div class="cal-bar-fill" data-r="barfill"></div></div>
  <div class="cal-bar-ends"><span data-r="barlo"></span><span data-r="barhi"></span></div>
  <div class="cal-range-vals">
    <div>
      <div class="cal-sub">Floor (mic noise)</div>
      <div class="cal-range-value" data-r="floor">–</div>
    </div>
    <div>
      <div class="cal-sub">Ceiling (0 dBFS)</div>
      <div class="cal-range-value" data-r="ceil">–</div>
    </div>
  </div>
</div>

<div class="cal-footer">
  <div><span data-r="version"></span> · <a href="${REPO_URL}" target="_blank" rel="noopener">Source code</a> · AGPL-3.0</div>
  <div>Not a certified sound level meter. Readings depend on the phone mic and the calibration.</div>
  <div class="mono" data-r="diag"></div>
</div>
`;

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const validNum = (v) => typeof v === 'number' && Number.isFinite(v);
const inRange = (off) => off >= 0 && off <= OFFSET_MAX;

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// Whole-number label through fmt1 (keeps the U+2212 minus).
const fmt0 = (v) => fmt1(Math.round(v)).replace(/\.0$/, '');

function onOff(v) {
  if (v === true) return 'on';
  if (v === false) return 'off';
  return '?';
}

export function init(section, { store, audio }) {
  section.innerHTML = MARKUP;
  const r = {};
  for (const n of section.querySelectorAll('[data-r]')) r[n.dataset.r] = n;
  setText(r.version, `kuulo v${VERSION}`);
  setText(r.assumed, fmt1(QUIET_ROOM_DB));

  // State
  let cfg = store.get();
  let shown = false;
  let method = 'reference'; // UI state only
  let buf = []; // last BUF_LEN secondLeqA values, oldest first
  let floorVals = null; // null = idle, array = measuring
  let watch = 0; // interval id: notices an audio stop while measuring
  let refError = '';
  const notes = { ref: '', quiet: '', floor: '' };

  const methodSeg = segmented(r.methods, METHODS, method, (m) => {
    method = m;
    notes.ref = '';
    notes.quiet = '';
    refError = '';
    render();
  });

  const lastN = (n) => (buf.length >= n ? buf.slice(-n) : null);

  // Write a new offset. False when settings would reject it (outside 0..200).
  function commit(offset, calMethod) {
    if (!validNum(offset) || !inRange(offset)) return false;
    store.update((s) => {
      s.offsetDb = offset;
      s.calMethod = calMethod;
      s.calibratedAt = todayIso();
    });
    return true;
  }

  function stopWatch() {
    clearInterval(watch);
    watch = 0;
  }

  function cancelFloor() {
    stopWatch();
    if (floorVals === null) return;
    floorVals = null;
    render();
  }

  function render() {
    const off = cfg.offsetDb;
    const cal = off != null;

    // Waiting messages go away once enough readings are in.
    if (notes.ref.startsWith('Wait') && buf.length >= REF_SECS) notes.ref = '';
    if (notes.quiet.startsWith('Wait') && buf.length >= QUIET_SECS) notes.quiet = '';

    // Offset card
    setText(r.offset, cal ? fmtSigned(off) : DASH);
    setText(r.offsetunit, cal ? ' dB' : '');
    r.down.disabled = cal && !inRange(nudge(off, -1));
    r.up.disabled = cal && !inRange(nudge(off, 1));
    setText(r.source, sourceText(cfg));

    // Method panels
    methodSeg.set(method);
    r.panelref.hidden = method !== 'reference';
    r.panelquiet.hidden = method !== 'quiet';

    const ref5 = lastN(REF_SECS);
    setText(r.phoneref, ref5 ? fmtSigned(energyMean(ref5)) : DASH);
    const quiet10 = lastN(QUIET_SECS);
    setText(r.phonequiet, quiet10 ? fmtSigned(energyMean(quiet10)) : DASH);

    setText(r.referr, refError);
    if (refError) r.refinput.setAttribute('aria-invalid', 'true');
    else r.refinput.removeAttribute('aria-invalid');
    setText(r.refnote, notes.ref);
    setText(r.quietnote, notes.quiet);

    // Range card
    const measuring = floorVals !== null;
    setText(r.measure, measuring ? `Measuring… ${FLOOR_SECS - floorVals.length} s` : `Measure floor (${FLOOR_SECS} s)`);
    r.measure.disabled = measuring;
    setText(r.floornote, notes.floor);

    const unit = cal ? 'dB(A)' : 'dBFS';
    const lo = cal ? 20 : -100;
    const hi = cal ? 120 : 0;
    const span = hi - lo;
    const floor = floorDb(cfg);
    const ceil = ceilingDb(cfg);
    setText(r.barlo, `${fmt0(lo)}`);
    setText(r.barhi, `${fmt0(hi)} ${cal ? 'dB' : 'dBFS'}`);
    if (floor == null) {
      r.barfill.style.left = '0%';
      r.barfill.style.right = '100%';
    } else {
      const a = clamp01((floor - lo) / span);
      const b = clamp01((ceil - lo) / span);
      r.barfill.style.left = `${(Math.min(a, b) * 100).toFixed(1)}%`;
      r.barfill.style.right = `${((1 - Math.max(a, b)) * 100).toFixed(1)}%`;
    }
    setText(r.floor, measuring ? '…' : floor == null ? 'Not measured' : `${fmt1(floor)} ${unit}`);
    setText(r.ceil, `≈ ${fmt1(ceil)} ${cal ? 'dB' : 'dBFS'}`);

    renderDiag();
  }

  function renderDiag() {
    const { sampleRate, source, trackSettings } = audio.info();
    let text;
    if (!sampleRate) {
      text = 'Microphone not started';
    } else {
      const khz = `${Number((sampleRate / 1000).toFixed(1))} kHz`;
      if (source === 'tone') {
        text = `${khz} · test tone`;
      } else {
        const t = trackSettings || {};
        text = `${khz} · AGC ${onOff(t.autoGainControl)} · NS ${onOff(t.noiseSuppression)} · EC ${onOff(t.echoCancellation)}`;
      }
    }
    setText(r.diag, text);
  }

  // Data in. Subscribed for the page's lifetime so the buffer keeps filling on other tabs.
  audio.onMeter((m) => {
    if (!validNum(m.secondLeqA)) return;
    buf.push(m.secondLeqA);
    if (buf.length > BUF_LEN) buf.shift();
    if (floorVals !== null) {
      floorVals.push(m.secondLeqA);
      if (floorVals.length >= FLOOR_SECS) {
        const values = floorVals;
        stopWatch();
        floorVals = null;
        store.update((s) => { s.floorDbfs = round1(energyMean(values)); });
        notes.floor = '';
      }
    }
    if (shown) render();
  });

  // A new start is a new measurement: drop the buffer and any floor measurement in progress.
  audio.onSource(() => {
    buf = [];
    notes.ref = '';
    notes.quiet = '';
    notes.floor = '';
    stopWatch();
    floorVals = null;
    render();
  });

  store.subscribe((s) => {
    try {
      cfg = s;
      render();
    } catch (e) {
      console.error(e);
    }
  });

  // Controls
  r.down.addEventListener('click', () => { commit(nudge(cfg.offsetDb, -1), 'manual'); });
  r.up.addEventListener('click', () => { commit(nudge(cfg.offsetDb, 1), 'manual'); });

  r.refinput.addEventListener('input', () => {
    if (!refError && !notes.ref) return;
    refError = '';
    notes.ref = '';
    render();
  });
  r.refinput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); r.applyref.click(); }
  });

  r.applyref.addEventListener('click', () => {
    refError = '';
    notes.ref = '';
    const parsed = parseReading(r.refinput.value);
    if (parsed.error) {
      refError = parsed.error;
    } else if (!audio.running()) {
      notes.ref = 'Tap Start first';
    } else {
      const ref5 = lastN(REF_SECS);
      if (!ref5) notes.ref = `Wait ${REF_SECS} s for a steady phone reading`;
      else if (commit(offsetFromReference(parsed.value, energyMean(ref5)), 'reference')) notes.ref = 'Offset set';
      else notes.ref = 'That gives an offset outside 0 to 200 dB. Check the reading.';
    }
    render();
  });

  r.applyquiet.addEventListener('click', () => {
    notes.quiet = '';
    if (!audio.running()) {
      notes.quiet = 'Tap Start first';
    } else {
      const q = lastN(QUIET_SECS);
      if (!q) notes.quiet = `Wait ${QUIET_SECS} s for a steady phone reading`;
      else if (commit(offsetFromQuietRoom(energyMean(q)), 'quiet')) notes.quiet = 'Offset set';
      else notes.quiet = 'That gives an offset outside 0 to 200 dB.';
    }
    render();
  });

  r.measure.addEventListener('click', () => {
    if (floorVals !== null) return;
    notes.floor = '';
    if (!audio.running()) {
      notes.floor = 'Tap Start first';
    } else {
      floorVals = [];
      stopWatch();
      watch = setInterval(() => { if (!audio.running()) cancelFloor(); }, 1000);
    }
    render();
  });

  render();

  return {
    show() {
      shown = true;
      cfg = store.get();
      render();
    },
    hide() {
      // Leaving the screen abandons a floor measurement: it should be taken in the quiet place the user chose, on this screen.
      shown = false;
      notes.floor = '';
      cancelFloor();
    },
  };
}
