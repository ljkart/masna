import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkMove } from '../../plugins/masna/lib/state.mjs';

const legal = [
  ['build', 'gate', { buildReady: true, clean: true, commitsAhead: true }],
  ['gate', 'review', { checks: 'PASS' }],
  ['gate', 'build', { checks: 'FAIL', gateFixes: 0, maxGateFixes: 3 }],
  ['review', 'approve', { allPass: true }],
  ['review', 'build', { allVerdicts: true, anyChanges: true, round: 1, maxRounds: 3 }],
  ['approve', 'landing', { decision: 'APPROVE' }],
  ['landing', 'landed', { trailerOnRemote: true, issueClosed: true, verdictsPosted: true }],
  ['needs-human', 'build', { feedback: true }],
];

for (const [from, to, evidence] of legal) {
  test(`${from} to ${to} is allowed with its evidence`, () => {
    assert.equal(checkMove(from, to, evidence).ok, true);
  });

  test(`${from} to ${to} is refused without evidence`, () => {
    assert.equal(checkMove(from, to, {}).ok, false);
  });
}

const refused = [
  ['build', 'gate', { buildReady: true, clean: false, commitsAhead: true }, 'a dirty worktree'],
  ['build', 'gate', { buildReady: true, clean: true, commitsAhead: false }, 'no commits'],
  ['gate', 'review', { checks: 'FAIL' }, 'failed checks'],
  ['gate', 'build', { checks: 'FAIL', gateFixes: 3, maxGateFixes: 3 }, 'no gate fixes left'],
  ['gate', 'build', { checks: 'PASS', gateFixes: 0, maxGateFixes: 3 }, 'passing checks'],
  ['review', 'build', { allVerdicts: false, anyChanges: true, round: 1, maxRounds: 3 }, 'a missing verdict'],
  ['review', 'build', { allVerdicts: true, anyChanges: false, round: 1, maxRounds: 3 }, 'no changes wanted'],
  ['review', 'build', { allVerdicts: true, anyChanges: true, round: 3, maxRounds: 3 }, 'no rounds left'],
  ['approve', 'landing', { decision: 'REJECT' }, 'a rejection'],
  ['landing', 'landed', { trailerOnRemote: true, issueClosed: false, verdictsPosted: true }, 'an open issue'],
];

for (const [from, to, evidence, why] of refused) {
  test(`${from} to ${to} is refused with ${why}`, () => {
    assert.equal(checkMove(from, to, evidence).ok, false);
  });
}

test('stages can\'t be skipped', () => {
  assert.equal(checkMove('build', 'review', { checks: 'PASS' }).ok, false);
  assert.equal(checkMove('build', 'landed', {}).ok, false);
  assert.equal(checkMove('gate', 'approve', { allPass: true }).ok, false);
  assert.equal(checkMove('review', 'landing', { decision: 'APPROVE' }).ok, false);
});

test('any active stage can move to needs-human or cancelled without evidence', () => {
  for (const stage of ['build', 'gate', 'review', 'approve', 'landing']) {
    assert.equal(checkMove(stage, 'needs-human').ok, true);
    assert.equal(checkMove(stage, 'cancelled').ok, true);
  }
});

test('landed and cancelled are final', () => {
  for (const to of ['build', 'needs-human', 'cancelled']) {
    assert.equal(checkMove('landed', to, { feedback: true }).ok, false);
    assert.equal(checkMove('cancelled', to, { feedback: true }).ok, false);
  }
});

test('needs-human returns only to build, and only with feedback', () => {
  assert.equal(checkMove('needs-human', 'gate', { feedback: true }).ok, false);
  assert.equal(checkMove('needs-human', 'build', { feedback: false }).ok, false);
});
