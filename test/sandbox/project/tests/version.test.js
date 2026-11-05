import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VERSION } from '../src/version.js';

test('the version is set', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
