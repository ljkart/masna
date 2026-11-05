import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso, readJson, writeJson } from './fsutil.mjs';
import { groupDir, jobDir, jobsDir } from './project.mjs';

export const ACTIVE_STAGES = ['build', 'gate', 'review', 'approve', 'landing'];
const TERMINAL_STAGES = ['landed', 'cancelled'];

const MOVES = {
  'build>gate': {
    check: (e) => e.buildReady && e.clean && e.commitsAhead,
    needs: 'build.md saying READY, a clean worktree and commits ahead of the group branch',
  },
  'gate>review': {
    check: (e) => e.checks === 'PASS',
    needs: 'checks.md saying PASS for the current commit',
  },
  'gate>build': {
    check: (e) => e.checks === 'FAIL' && e.gateFixes < e.maxGateFixes,
    needs: 'checks.md saying FAIL for the current commit, within max_gate_fixes',
  },
  'review>approve': {
    check: (e) => e.allPass,
    needs: 'a valid PASS from every required reviewer',
  },
  'review>build': {
    check: (e) => e.allVerdicts && e.anyChanges && e.round < e.maxRounds,
    needs: 'a valid verdict from every required reviewer, at least one CHANGES, within max_rounds',
  },
  'approve>landing': {
    check: (e) => e.decision === 'APPROVE',
    needs: 'decision.md saying APPROVE for the current commit',
  },
  'landing>landed': {
    check: (e) => e.trailerOnRemote && e.issueClosed && e.verdictsPosted,
    needs: 'the commit on the remote group branch, the issue closed and verdicts posted',
  },
  'needs-human>build': {
    check: (e) => e.feedback,
    needs: 'feedback from a person',
  },
};

export function checkMove(from, to, evidence = {}) {
  if (TERMINAL_STAGES.includes(from)) return { ok: false, reason: `${from} is final` };
  if (to === 'needs-human' && from !== 'needs-human') return { ok: true };
  if (to === 'cancelled') return { ok: true };
  const move = MOVES[`${from}>${to}`];
  if (!move) return { ok: false, reason: `no move from ${from} to ${to}` };
  if (!move.check(evidence)) return { ok: false, reason: `${from} to ${to} needs ${move.needs}` };
  return { ok: true };
}

export const loadJob = (root, id) => readJson(join(jobDir(root, id), 'job.json'));

export function saveJob(root, job) {
  job.updated_at = nowIso();
  writeJson(join(jobDir(root, job.id), 'job.json'), job);
}

export const loadGroup = (root, number) => readJson(join(groupDir(root, number), 'group.json'));

export function saveGroup(root, group) {
  group.updated_at = nowIso();
  writeJson(join(groupDir(root, group.number), 'group.json'), group);
}

function jobFolders(root) {
  const dir = jobsDir(root);
  return existsSync(dir) ? readdirSync(dir) : [];
}

export function listJobs(root) {
  return jobFolders(root)
    .filter((name) => !name.startsWith('group-'))
    .map((name) => loadJob(root, name))
    .filter(Boolean);
}

export function listGroups(root) {
  return jobFolders(root)
    .filter((name) => name.startsWith('group-'))
    .map((name) => readJson(join(jobsDir(root), name, 'group.json')))
    .filter(Boolean);
}
