# kuulo

Personal sound level meter and spectrum analyser, installed to the iPhone home screen as a web app (PWA). For everyday curiosity ("how loud is it", "what is that tone"). Single user, no accounts, no analytics, no recording. Designed to work offline after the first load (check 5 below).

- The Meter screen shows an A, C or Z weighted level with Fast or Slow response, Leq, Max, Min and a 60 s history.
- The Spectrum screen shows a live waterfall and live bars, with a peak frequency readout.
- Calibration (offset and noise floor) is kept when the app is closed.

## What the numbers mean

This is not a certified sound level meter (IEC 61672) and is not for workplace noise assessment. It measures what the phone microphone delivers.

- Uncalibrated, levels are shown in dBFS (relative to digital full scale).
- Calibrated, levels are dB = dBFS + offset. Accuracy depends on the reference used and on the phone microphone. No tolerance is claimed.
- The Meter number is the measurement. Spectrum levels are display values, marked "≈", and are not standard 1/3-octave band levels. The peak band of a pure tone is compensated (+13.55 dB for the Blackman window) so that it reads like the Meter.

## Install on iPhone

Open https://eddiepohj.github.io/kuulo/ in Safari, then Share, then Add to Home Screen. Allow the microphone when asked.

## Develop

    npm run serve   # static file server at http://localhost:8124/
    npm test        # run unit tests

Open http://localhost:8124/?tone to use a test tone instead of the microphone (440 Hz and 1.25 kHz, switching every 2 s).

## Deploy

Push to `main`; GitHub Pages serves it. On each release bump both `CACHE` in `sw.js` and `VERSION` in `js/ui-common.js`. Bumping `CACHE` replaces the offline copy and deletes the old one. The Calibrate footer shows `VERSION`, so you can see which build the phone runs.

## On-device checks

Run on the installed app:

1. Tap to start. The Meter and both Spectrum views run, and the toggles work.
2. A whistle shows as a clear trace in the waterfall and in the peak readout.
3. Calibrate against a reference. The offset and floor survive a force-quit.
4. The microphone indicator turns off when the app goes to the background.
5. Turn on airplane mode, launch from the home screen, tap Start: the meter runs.
6. Recorded, not pass or fail: phone against reference at a second steady level 10 to 20 dB away from the calibration level.

Microphone spike (do this first, spec section 12): iOS may keep voice processing (auto-gain, noise suppression) even though the app asks for it to be off. On first launch, open Calibrate and read the microphone line in the footer (sample rate and AGC, NS and EC shown as on, off or ?). Then play a steady sound and step it by about 20 dB. The Meter should step with it, not pump up and down. If it pumps, note it here and decide what to do.

## Spec and plan

See `docs/superpowers/`.

## Licence

AGPL-3.0-or-later, see `LICENSE`. Includes audioMotion-analyzer 4.5.4 (AGPL) and IBM Plex (SIL OFL), see `NOTICE`. Source: https://github.com/eddiepohj/kuulo
