# kuulo PWA: Design

**Date:** 07.10.2026
**Owner:** Eddie Pohjavirta
**Status:** Draft, pending owner review
**Mockup:** https://claude.ai/artifact/YCm8Fxe9tMwe34HVY5947h (Meter, Spectrum, Calibrate; demo data)
**Sibling project:** `~/projects/shikaku` (same build and hosting pattern)

"kuulo" is a working name. The repo and URL take the final name (§13).

---

## 1. Scope

A personal sound level meter and spectrum analyser, installed to an iPhone home
screen as a PWA. Single user, single device. Purpose: everyday curiosity ("how
loud is it", "what is that tone"). No accounts, no sharing, no analytics, no
recording.

Done when:

- The meter shows a stable, calibrated A/C/Z-weighted level with Fast/Slow
  response, Leq, Max, Min and a 60 s history.
- The spectrum shows a live waterfall and live bars, with a peak frequency
  readout.
- Calibration (offset, noise floor) survives closing and reopening the app.
- It runs installed on the iPhone, offline after first load.

## 2. What the numbers mean

The app measures what the phone's microphone delivers. It is not a certified
sound level meter (IEC 61672) and is not for workplace noise assessment.

- **Uncalibrated**, levels are shown in dBFS (relative to digital full scale).
- **Calibrated**, levels are shown as dB = dBFS + offset (§7). Accuracy depends
  on the reference used and on the phone microphone. The app does not claim a
  tolerance.
- **The meter number is the measurement.** Spectrum amplitudes are display
  values with the same offset applied and are labelled "≈". They are not
  standard 1/3-octave band levels (IEC 61260).

## 3. Tech stack

Same pattern as Shikaku:

- Vanilla HTML, CSS, JavaScript (ES modules). No framework, no build step.
- `manifest.webmanifest` + `sw.js` (network-first, versioned cache).
- `localStorage` for settings and calibration.
- One vendored library: **audioMotion-analyzer 4.5.4**, copied unmodified from
  the npm package (`src/audioMotion-analyzer.js`) into `vendor/`, version
  pinned in the filename header comment.
- `node --test` for the pure modules.

**Licence.** audioMotion-analyzer is AGPL-3.0-or-later, so this repo is
licensed AGPL-3.0-or-later (not Apache-2.0 like Shikaku). `NOTICE` credits
audioMotion-analyzer (Henrique Vianna). The app links to its public source
repo from the Calibrate screen footer, which covers AGPL §13 for a network-served
app.

## 4. Screens

Three tabs in a bottom bar. Layout and controls as in the mockup.

### Meter
- Large level readout, unit `dB(A)` / `dB(C)` / `dB(Z)` (or `dBFS` uncalibrated).
- Response label (Fast 125 ms / Slow 1 s / Hold) above, and a plain-words
  description below (§9).
- Range bar 20 to 120 dB: shaded zone below the noise floor, red zone above the
  ceiling, fill at current level, marker at Max.
- Tiles: Leq (named LAeq/LCeq/LZeq), Max, Min, elapsed time.
- 60 s history strip, one bar per second (energy average of that second).
- Controls: weighting A | C | Z, response Fast | Slow, Hold, Reset.
- "OVER" badge when clipping was detected in the last 1 s (§7).

### Spectrum
- Peak frequency card: Hz (or kHz), nearest note and cents offset. Shows "–"
  when no clear tone (§6.4).
- Peak level card: ≈ dB of the strongest band.
- **Waterfall view (default):** 80 px live bars strip on top, waterfall below:
  frequency on x (log, 25 Hz to 16 kHz), time downward, newest row on top,
  12 s history, colour scale legend 10 to 70 dB.
- **Bars view:** full-height LED bars with peak markers.
- Controls: Waterfall | Bars, Freeze, 1/3 | 1/6 octave, A | C | Z.
- Changing resolution or weighting clears the waterfall.

### Calibrate
- Offset with −/+ buttons (0.5 dB steps) and a line saying how it was set and
  when (e.g. "Set from reference meter, 07.10.2026").
- Method tabs:
  - **Reference meter:** live phone reading (dBFS), input for the reference
    reading, button "Set offset from reference".
  - **Quiet room:** warning text, live phone reading, assumed 25.0 dB(A),
    button "Use quiet room (±10 dB)".
- Measurable range card: floor (mic noise), ceiling (0 dBFS), range bar,
  button "Measure floor (10 s)".
- Footer: version, "Source code" link, one-line disclaimer from §2.

### Start overlay
Shown at launch and after the app returns from the background: "Tap to start".
The tap creates or resumes the AudioContext and requests the microphone. If
permission is denied, the overlay explains how to allow it in iOS Settings.

## 5. Audio pipeline

```
getUserMedia (mono, echoCancellation/noiseSuppression/autoGainControl: false)
  └─ MediaStreamAudioSourceNode
       ├─ AudioWorkletNode "meter"   → level messages every 50 ms → Meter UI
       ├─ audioMotion-analyzer       → bars canvas + getBars() → waterfall canvas
       └─ AnalyserNode (fftSize 16384) → peak frequency
```

Nothing connects to the speakers (`connectSpeakers: false`).

**Lifecycle.** On `visibilitychange` to hidden: stop the mic tracks and suspend
the AudioContext (releases the mic indicator and battery). On return: show the
Start overlay. Screen Wake Lock is requested while running, where supported.

## 6. Modules

Pure modules hold the maths and are unit-tested. UI modules draw and wire.

```
index.html, app.css, manifest.webmanifest, sw.js, icons/
vendor/audioMotion-analyzer.js          (AGPL, unmodified)
js/app.js            boot, tabs, Start overlay, lifecycle, wake lock, persistence
js/audio.js          mic + AudioContext + node graph; exposes start()/stop()
js/meter-worklet.js  pure DSP exports + AudioWorkletProcessor (see 6.1)
js/weighting.js      pure: A/C biquad design for any sample rate; analytic curves
js/calibration.js    pure: offset maths, floor, ceiling, describe() labels
js/peak.js           pure: peak bin search, parabolic interpolation, note name
js/colormap.js       pure: 256-entry LUT from 5 stops
js/ui-meter.js       Meter screen
js/ui-spectrum.js    Spectrum screen: audioMotion setup, waterfall canvas
js/ui-calibrate.js   Calibrate screen
tests/*.test.js
```

### 6.1 `meter-worklet.js`
One file serves both the worklet and the tests: it exports its DSP functions,
and calls `registerProcessor` only when that function exists. No imports
inside the worklet (avoids module-import support differences in worklets).

Per 128-sample block:
1. Apply the selected weighting (cascaded biquads from `weighting.js`
   coefficients, passed in via `processorOptions` and `port` messages on change).
2. Accumulate squared samples for Leq (since last Reset) and for the current
   1 s history bar.
3. Exponential time weighting on the squared signal, τ = 0.125 s (Fast) or
   1 s (Slow).
4. Track Max and Min of the time-weighted level. Min starts after 1 s, so the
   settling filter does not set it.
5. Clip flag: any raw sample with |x| ≥ 0.99.

Every 50 ms it posts `{ level, leq, max, min, secondLeq?, clipped }` in dBFS.

**dBFS convention:** level = 10·log10(2·mean square), so a full-scale sine
reads 0 dBFS.

### 6.2 `weighting.js`
- `curve(type, f)`: analytic A and C curves (IEC 61672 formulas, normalised
  to 0 dB at 1 kHz). Z = 0.
- `design(type, sampleRate)`: biquad coefficients. The iPhone runs at 48 kHz;
  44.1 kHz must also work.

### 6.3 Spectrum (`ui-spectrum.js`)
audioMotion options: `mode` 6 (1/3) or 4 (1/6), `frequencyScale: 'log'`,
`ansiBands: true`, `minFreq: 25`, `maxFreq: 16000`, `weightingFilter` `'A'` /
`'C'` / `''`, `ledBars: true` in Bars view, `showScaleY: false` (we draw ≈dB
labels with the offset), `fftSize: 8192`.

Waterfall: an own `<canvas>`. In audioMotion's `onCanvasDraw` callback, at most
10 times per second, read `getBars()`, convert each `value` (0 to 1 between
`minDecibels` and `maxDecibels`) back to dB, add the offset, map through the
colormap and paint one row spanning each bar's `freqLo` to `freqHi` on a log
x-axis. Shift existing rows down by one row first. 120 rows = 12 s.

### 6.4 `peak.js`
From the AnalyserNode spectrum (25 Hz to 16 kHz, current weighting applied):
strongest bin, parabolic interpolation for the frequency. Reported only when
the peak is at least 10 dB above the median bin level, otherwise "–". Note
name from A4 = 440 Hz, cents rounded to whole numbers.

## 7. Calibration model

- **Offset:** dB = dBFS + offset. One number per phone and browser. Weighting
  does not change it (all curves are 0 dB at 1 kHz).
- **Reference method:** offset = reference reading − phone Leq over the last
  5 s. Recommended conditions shown in the UI: steady sound around 50 to 80 dB,
  phone and meter side by side. A free reference option is the NIOSH SLM app on
  the same iPhone, measuring the same steady sound one app after the other.
- **Quiet room method (rough):** offset = 25.0 − phone A-weighted Leq over 10 s.
  Stored as rough and labelled ±10 dB. The quiet room sits near the mic's own
  noise, so normal sounds will likely read low.
- **Manual:** −/+ 0.5 dB.
- **Floor:** A-weighted Leq over 10 s in the quietest available place, stored
  in dBFS. Shown as floor dBFS + offset. Meter readings within 3 dB of the floor
  get the description "near mic floor".
- **Ceiling:** 0 dBFS + offset (= offset). Clipping is detected from samples,
  not inferred from the level.

## 8. Persistence schema

One `localStorage` key: `kuulo.v1.settings`.

```json
{
  "offsetDb": 108.0,
  "calMethod": "reference",
  "calibratedAt": "2026-10-07",
  "floorDbfs": -77.0,
  "meter": { "weighting": "A", "response": "F" },
  "spectrum": { "view": "fall", "res": 3, "weighting": "A" }
}
```

Missing or unparsable → defaults, uncalibrated. Measurements are not saved.

## 9. Visual style

From the mockup. Dark is the primary theme; a light theme follows the OS
setting through the same CSS variables. Canvas colours (LED amber, waterfall
colormap) are the same in both.

| Token | Dark | Use |
|---|---|---|
| `--bg` | `#0F1113` | ground |
| `--surface` | `#181B1F` | tiles, cards |
| `--line` | `#2A2F35` | hairlines, control borders |
| `--fg` | `#E8E6E1` | text |
| `--muted` | `#9AA1A9` | labels |
| `--accent` | `#F5A524` | readouts, bars, active tab |
| `--over` | `#FF7A5C` | clipping |

Light values are set in the plan. Fonts: IBM Plex Mono (numbers), IBM Plex Sans
Condensed (labels), self-hosted woff2 in `fonts/` so the app works offline.
Waterfall stops: `#0F1113`, `#2B1D3A`, `#8A2F4A`, `#E0702E`, `#FFE2AE` over
10 to 70 dB. Touch targets ≥ 44 px.

Descriptions (indicative, A-weighted): < 40 quiet room, < 55 calm office,
< 70 conversation, < 85 busy street, ≥ 85 "loud: limit long exposure".

## 10. Hosting and deploy

- Public GitHub repo under `eddiepohj`, served by GitHub Pages from `main`.
  HTTPS is required for microphone access; Pages provides it.
- Deploy = push. Bump the `sw.js` cache name on each release.
- Install once via Safari → Share → Add to Home Screen.

## 11. Out of scope (v1)

Recording or exporting audio, measurement logs and export, per-model mic
frequency correction, standard band-power 1/3-octave levels, dose/exposure
calculation, LCpeak, multiple calibration profiles, Android-specific tuning,
Docker/nginx hosting, a native app, sharing, telemetry.

## 12. Risks

| Risk | Mitigation |
|---|---|
| iOS keeps voice processing (noise suppression, auto-gain) despite the constraints | First build step is an on-device spike: log `track.getSettings()`, and check a steady sound stepped by about 20 dB reads as a step, not pumping. If iOS ignores the constraints, record that in the README and decide with the owner. |
| audioMotion docs warn that Safari returns no analyser data for *live media-element streams* (WebKit bug 195043) | Expected not to affect a mic `MediaStream`; the spike verifies bars and `getBars()` on the iPhone before UI work. Fallback: drive the bars from our own AnalyserNode. |
| AudioWorklet in the installed (standalone) PWA | Verified in the spike. Fallback: compute the meter from AnalyserNode time-domain data on the main thread. |
| iOS asks for mic permission again after relaunch | Accepted; the Start overlay handles it. |
| Low bands (25 to 50 Hz) coarse at fftSize 8192 | Accepted for v1. |
| Phone mic roll-off at low and high frequencies | Accepted; §2 says what the numbers mean. |
| AGPL obligations | Public repo + source link in the app. |

## 13. Open decisions for the owner

1. Final app name (sets repo name and URL).
2. Repo creation and first commit (owner does git writes).

## 14. Testing and acceptance

**Unit tests (`npm test`):**
- Weighting: `design()` frequency response at 48 kHz and 44.1 kHz matches
  `curve()` within 0.5 dB from 31.5 Hz to 8 kHz and within IEC 61672 class 2
  limits up to 16 kHz.
- Meter DSP: full-scale sine = 0.0 dBFS (±0.1), 0.1 amplitude = −20.0 dBFS;
  Leq of a two-level signal equals the energy average; Fast and Slow decay rates
  match τ = 0.125 s and 1 s (34.7 and 4.3 dB/s) within 5 %; clip flag at 0.99.
- Calibration maths, floor and ceiling, describe() thresholds.
- Peak: synthetic tone at 1 250 Hz found within 1 Hz; 440 Hz → A4 +0 ct;
  flat spectrum → "–".
- Colormap: endpoints and monotonic lightness.

**On the iPhone (installed PWA):**
1. Tap to start; meter and both spectrum views run; toggles work.
2. A whistle shows as a clear trace in the waterfall and in the peak readout.
3. Calibrate against a reference; offset and floor survive a force-quit.
4. Mic indicator turns off when the app goes to the background.
5. Works in airplane mode after first load.
6. Recorded, not pass/fail: phone vs reference at a second steady level 10 to
   20 dB away from the calibration level.
