import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchGlob, passStillHolds, route } from '../../plugins/masna/lib/route.mjs';

test('matchGlob handles the patterns configs use', () => {
  assert.equal(matchGlob('**', 'a/b/c.ts'), true);
  assert.equal(matchGlob('src/api/**', 'src/api/x/y.ts'), true);
  assert.equal(matchGlob('src/api/**', 'src/web/y.ts'), false);
  assert.equal(matchGlob('*.md', 'README.md'), true);
  assert.equal(matchGlob('*.md', 'docs/README.md'), false);
  assert.equal(matchGlob('**/CLAUDE.md', 'CLAUDE.md'), true);
  assert.equal(matchGlob('**/CLAUDE.md', 'a/b/CLAUDE.md'), true);
  assert.equal(matchGlob('.masna/**', '.masna/checks.sh'), true);
  assert.equal(matchGlob('.masna/**', 'xmasna/checks.sh'), false);
  assert.equal(matchGlob('.mcp.json', 'xmcpxjson'), false);
  assert.equal(matchGlob('.claude/**', '.claude'), true);
  assert.equal(matchGlob('.claude/**', '.claude/settings.json'), true);
  assert.equal(matchGlob('.claude/**', '.claudette'), false);
});

const reviewers = {
  'src/api/**': ['code', 'security'],
  'src/web/**': ['code', 'ui', 'ux'],
  '**': ['code'],
};

test('route gives a file the reviewers of every pattern it matches', () => {
  assert.deepEqual(route(['src/api/a.ts'], reviewers), ['code', 'security']);
  assert.deepEqual(route(['src/api/a.ts', 'src/web/b.ts'], reviewers), ['code', 'security', 'ui', 'ux']);
});

test('route falls back to the code reviewer when nothing matches', () => {
  assert.deepEqual(route(['x'], { 'src/**': ['ui'] }), ['code']);
  assert.deepEqual(route([], reviewers), ['code']);
});

test('a pass holds only if none of the reviewer\'s files changed', () => {
  assert.equal(passStillHolds('security', ['src/web/b.ts'], reviewers), true);
  assert.equal(passStillHolds('security', ['src/api/a.ts'], reviewers), false);
  assert.equal(passStillHolds('code', ['anything'], reviewers), false);
  assert.equal(passStillHolds('security', [], reviewers), true);
});
