import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const bin = fileURLToPath(new URL('../plugins/masna/bin/masna', import.meta.url));
const manifest = JSON.parse(
  readFileSync(new URL('../plugins/masna/.claude-plugin/plugin.json', import.meta.url), 'utf8'),
);

test('--version prints the version in the plugin manifest', () => {
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), manifest.version);
});

test('an unknown command fails', () => {
  const result = spawnSync(bin, ['not-a-command'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
});
