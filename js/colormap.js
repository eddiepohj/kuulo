// Waterfall colormap: five evenly spaced stops, linear interpolation in sRGB.

export const STOPS = ['#0F1113', '#2B1D3A', '#8A2F4A', '#E0702E', '#FFE2AE'];

function parseHex(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 256-entry RGBA lookup table (alpha 255). */
export function buildLut(stops = STOPS) {
  const rgb = stops.map(parseHex);
  const lut = new Uint8ClampedArray(256 * 4);
  const segments = rgb.length - 1;
  for (let i = 0; i < 256; i++) {
    const pos = (i / 255) * segments;
    const s = Math.min(Math.floor(pos), segments - 1);
    const t = pos - s;
    for (let c = 0; c < 3; c++) {
      lut[i * 4 + c] = Math.round(rgb[s][c] + (rgb[s + 1][c] - rgb[s][c]) * t);
    }
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

/** Map a dB value to a LUT index 0..255 (clamped; non-finite → 0). */
export function dbToIndex(db, lo = 10, hi = 70) {
  if (!Number.isFinite(db)) return 0;
  const t = (db - lo) / (hi - lo);
  return Math.round(Math.min(1, Math.max(0, t)) * 255);
}
