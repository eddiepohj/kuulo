import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapError } from '../js/audio.js';

test('mapError maps DOMException-like errors despite numeric legacy codes', () => {
  assert.equal(mapError({ name: 'SecurityError', code: 18, message: 'x' }).code, 'denied');
  assert.equal(mapError({ name: 'NotAllowedError', code: 0, message: 'x' }).code, 'denied');
  const nf = mapError({ name: 'NotFoundError', code: 8, message: 'x' });
  assert.equal(nf.code, 'failed');
  assert.match(nf.message, /No microphone/);
  assert.equal(mapError({ name: 'AbortError', code: 20, message: 'boom' }).code, 'failed');
  assert.equal(mapError(new Error('plain')).code, 'failed');
});

test('mapError passes the module\'s own errors through', () => {
  const own = Object.assign(new Error('nope'), { code: 'unsupported' });
  assert.equal(mapError(own), own);
  assert.equal(mapError(Object.assign(new Error('a'), { code: 'denied' })).code, 'denied');
  assert.equal(mapError(Object.assign(new Error('a'), { code: 'weird' })).code, 'failed');
});
