#!/usr/bin/env node
// Drives the engine against the real GitHub API with scripted agents and no model
// calls. It proves the calls that change GitHub: labels, comments, closing issues,
// and creating and editing a PR. Its milestone is due first, so the sandbox's real
// issues stay untouched, and it removes what it created.
//
//   node test/sandbox/smoke.mjs <owner/repo>
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agents, Orchestrator } from '../helpers/project.mjs';

const repo = process.argv[2];
if (!repo) throw new Error('usage: smoke.mjs <owner/repo>');

const BIN = fileURLToPath(new URL('../../plugins/masna/bin/masna', import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'masna-smoke-')));
const root = join(dir, 'clone');
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', ...options }).trim();
const gh = (...args) => run('gh', args);
const ghJson = (...args) => JSON.parse(gh(...args));

// What the test helpers' Orchestrator and scripted agents need from a project.
const project = {
  root,
  git: (args, cwd = root) => run('git', args, { cwd }),
  masnaRaw: (args, input = '') => spawnSync(BIN, args, { cwd: root, input, encoding: 'utf8' }),
  masna(args, input = '') {
    const result = project.masnaRaw(args, input);
    if (result.status !== 0) throw new Error(`masna ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  },
  json: (args, input) => JSON.parse(project.masna(args, input)),
  begin: (options = []) => project.json(['begin', ...options]),
};

const step = (text) => console.log(`- ${text}`);
const report = (action) => step(`${action.action}: ${action.report ?? action.reason ?? ''}`);

const created = { issues: [], milestone: null, pr: null, branch: null };
const issuesBefore = () => ghJson('issue', 'list', '--state', 'all', '--label', 'ready-for-agent', '--json', 'number,state,labels')
  .filter(({ number }) => !created.issues.includes(number));

function createIssue(title) {
  const body = '## What to build\nA smoke test.\n\n## Acceptance criteria\n- [ ] It lands\n\n## Blocked by\nNone\n';
  const url = gh('issue', 'create', '--title', title, '--body', body, '--label', 'ready-for-agent', '--milestone', 'Smoke test');
  const number = Number(url.split('/').pop());
  created.issues.push(number);
  return number;
}

let untouched;
try {
  execFileSync('gh', ['repo', 'clone', repo, root, '--', '--quiet'], { stdio: 'ignore' });
  const masnaRepo = fileURLToPath(new URL('../..', import.meta.url));
  for (const key of ['user.name', 'user.email']) {
    project.git(['config', key, execFileSync('git', ['config', key], { cwd: masnaRepo, encoding: 'utf8' }).trim()]);
  }

  const due = new Date(Date.now() + 86_400_000).toISOString();
  created.milestone = ghJson('api', 'repos/{owner}/{repo}/milestones', '-f', 'title=Smoke test', '-f', `due_on=${due}`).number;
  untouched = JSON.stringify(issuesBefore());
  const good = createIssue('Smoke: lands first time');
  const stuck = createIssue('Smoke: stuck, then fixed by feedback');
  step(`created issues #${good} and #${stuck} in milestone ${created.milestone}`);

  // One issue lands; the other is rejected, which gives a partial PR.
  const first = new Orchestrator(project, {
    [stuck]: { approver: (p, info) => agents.approver(p, info, 'REJECT') },
  });
  first.onStep = report;
  first.begin();
  const partial = first.drive();
  assert.equal(partial.action, 'pause');
  assert.match(partial.reason, /is partial/);

  const pr = ghJson('pr', 'list', '--state', 'open', '--json', 'number,title,body,headRefName,baseRefName')[0];
  created.pr = pr.number;
  created.branch = pr.headRefName;
  assert.match(pr.title, /^\[partial\] /);
  assert.equal(pr.baseRefName, 'main');
  assert.ok(pr.body.includes(`#${good}`));
  assert.ok(pr.body.includes(`#${stuck}`));
  step(`partial PR #${pr.number} opened on ${pr.headRefName}`);

  const landed = ghJson('issue', 'view', String(good), '--json', 'state,stateReason,comments');
  assert.equal(landed.state, 'CLOSED');
  assert.equal(landed.stateReason, 'COMPLETED');
  assert.equal(landed.comments.length, 1);
  assert.match(landed.comments[0].body, /Landed on/);
  assert.match(landed.comments[0].body, /code: PASS/);
  const stuckNow = ghJson('issue', 'view', String(stuck), '--json', 'state,labels');
  assert.equal(stuckNow.state, 'OPEN');
  assert.ok(stuckNow.labels.some(({ name }) => name === 'masna:needs-human'));
  step(`#${good} closed with its verdicts, #${stuck} labelled masna:needs-human`);

  // Feedback reopens the stuck issue, and it lands, which edits the same PR.
  step(project.masna(['feedback', String(stuck)], 'Try again.'));
  assert.equal(ghJson('issue', 'view', String(stuck), '--json', 'labels').labels.some(({ name }) => name === 'masna:needs-human'), false);
  const second = new Orchestrator(project);
  second.onStep = report;
  second.begin();
  const finished = second.drive();
  assert.equal(finished.action, 'pause');
  assert.match(finished.reason, /ready for review/);

  const edited = ghJson('pr', 'view', String(pr.number), '--json', 'title,state,commits');
  assert.equal(edited.state, 'OPEN');
  assert.equal(edited.title, 'Smoke test');
  assert.equal(ghJson('issue', 'view', String(stuck), '--json', 'state').state, 'CLOSED');
  assert.ok(project.git(['log', `origin/${created.branch}`, '--format=%B']).includes(`Masna-Issue: ${stuck}`));
  step(`PR #${pr.number} edited to complete, and #${stuck} landed`);

  assert.equal(JSON.stringify(issuesBefore()), untouched);
  step('the sandbox\'s real issues are untouched');
  console.log('PASS');
} finally {
  const quiet = (...args) => spawnSync('gh', args, { cwd: root, stdio: 'ignore' });
  if (created.pr) quiet('pr', 'close', String(created.pr));
  // Deleted directly: gh can't delete a branch that a local worktree has checked out.
  if (created.milestone) {
    spawnSync('git', ['push', '--quiet', 'origin', '--delete', `masna/group/${created.milestone}-smoke-test`], { cwd: root, stdio: 'ignore' });
  }
  for (const number of created.issues) quiet('issue', 'close', String(number), '--reason', 'not planned');
  if (created.milestone) quiet('api', '-X', 'DELETE', `repos/{owner}/{repo}/milestones/${created.milestone}`);
  rmSync(dir, { recursive: true, force: true });
}
