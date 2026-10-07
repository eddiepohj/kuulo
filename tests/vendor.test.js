import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

test('audioMotion-analyzer 4.5.4 is vendored unmodified', () => {
  const src = readFileSync(new URL('../vendor/audioMotion-analyzer.js', import.meta.url), 'utf8');
  assert.match(src, /@version 4\.5\.4/);
  assert.match(src, /const VERSION = '4\.5\.4';/);
  assert.match(src, /@license AGPL-3\.0-or-later/);
});

test('licence files are present', () => {
  const lic = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');
  assert.match(lic, /GNU AFFERO GENERAL PUBLIC LICENSE/);
  const notice = readFileSync(new URL('../NOTICE', import.meta.url), 'utf8');
  assert.match(notice, /audioMotion-analyzer/);
  assert.match(notice, /IBM Plex/);
  assert.ok(existsSync(new URL('../fonts/OFL.txt', import.meta.url)));
});

test('self-hosted fonts are present', () => {
  for (const f of [
    'ibm-plex-mono-latin-400-normal.woff2',
    'ibm-plex-mono-latin-500-normal.woff2',
    'ibm-plex-sans-condensed-latin-400-normal.woff2',
    'ibm-plex-sans-condensed-latin-500-normal.woff2',
    'ibm-plex-sans-condensed-latin-600-normal.woff2',
  ]) assert.ok(existsSync(new URL(`../fonts/${f}`, import.meta.url)), f);
});
