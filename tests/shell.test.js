import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

test('sw.js caches every shipped file (offline after first load)', () => {
  const sw = read('sw.js');
  const shell = [...sw.matchAll(/'(\.\/[^']*)'/g)].map((m) => m[1]);
  const expected = ['./', './index.html', './app.css', './manifest.webmanifest', './vendor/audioMotion-analyzer.js',
    ...readdirSync(new URL('js/', root)).filter((f) => f.endsWith('.js')).map((f) => `./js/${f}`),
    ...readdirSync(new URL('fonts/', root)).filter((f) => f.endsWith('.woff2')).map((f) => `./fonts/${f}`),
    './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'];
  for (const f of expected) assert.ok(shell.includes(f), `missing from SHELL: ${f}`);
  for (const f of shell) if (f !== './') assert.ok(existsSync(new URL(f, root)), `SHELL lists missing file: ${f}`);
  assert.match(sw, /const CACHE = 'kuulo-v\d+'/);
});

test('manifest is valid and points at existing icons', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '.');
  for (const i of m.icons) assert.ok(existsSync(new URL(i.src, root)), i.src);
});

test('index.html has the three screens, the tab bar and the start overlay', () => {
  const h = read('index.html');
  for (const id of ['screen-meter', 'screen-spectrum', 'screen-calibrate', 'start']) assert.match(h, new RegExp(`id="${id}"`));
  assert.match(h, /<script type="module" src="js\/app\.js"><\/script>/);
  assert.match(h, /rel="manifest"/);
  assert.match(h, /apple-touch-icon/);
});

test('fonts are self-hosted, no external requests', () => {
  const css = read('app.css'), h = read('index.html');
  assert.doesNotMatch(css + h, /fonts\.googleapis|fonts\.gstatic|https?:\/\/(?!github\.com\/eddiepohj\/kuulo|www\.w3\.org)/);
  assert.match(css, /@font-face/);
});

test('ui-common formatting', async () => {
  const { fmt1, fmtSigned } = await import('../js/ui-common.js');
  assert.equal(fmt1(48.25), '48.3');
  assert.equal(fmt1(-3.04), '−3.0');
  assert.equal(fmt1(null), '–');
  assert.equal(fmt1(-Infinity), '–');
  assert.equal(fmtSigned(108), '+108.0');
  assert.equal(fmtSigned(-3.5), '−3.5');
});
