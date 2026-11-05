import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { issue, Orchestrator, Project } from '../helpers/project.mjs';

const BIN = fileURLToPath(new URL('../../plugins/masna/bin/masna', import.meta.url));

let project;
let worktree;

const call = (input, cwd = project.root) => project.masnaRaw(['guard'], JSON.stringify({ cwd, ...input }), cwd);
const push = { tool_name: 'Bash', tool_input: { command: 'git push origin main' } };

before(() => {
  project = new Project({ issues: [issue(1)], config: { reviewers: { '**': ['code', 'house-style'] } } });
  const orchestrator = new Orchestrator(project, { 1: { builder: () => 'crash' } });
  orchestrator.begin();
  orchestrator.drive();
  worktree = join(project.root, project.group(1).worktree);
});

after(() => project.cleanup());

test('during a run, the main session can\'t push the base branch', () => {
  const result = call(push);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Blocked by Masna: pushing main is blocked/);
});

test('during a run, the builder writes in its worktree but not elsewhere', () => {
  const builder = { agent_type: 'masna:builder', tool_name: 'Write' };
  assert.equal(call({ ...builder, tool_input: { file_path: join(worktree, 'src/a.txt') } }, worktree).status, 0);
  assert.equal(call({ ...builder, tool_input: { file_path: join(project.jobFolder(1), 'build.md') } }, worktree).status, 0);
  assert.equal(call({ ...builder, tool_input: { file_path: join(worktree, 'CLAUDE.md') } }, worktree).status, 2);
  assert.equal(call({ ...builder, tool_input: { file_path: join(project.root, 'README.md') } }, worktree).status, 2);
  assert.equal(call({ ...builder, tool_input: { file_path: join(project.jobFolder(1), 'decision.md') } }, worktree).status, 2);
});

test('reviewers, including custom ones, write only their own file', () => {
  const allowed = call({
    agent_type: 'masna:reviewer-code',
    tool_name: 'Write',
    tool_input: { file_path: join(project.jobFolder(1), 'review-code.md') },
  });
  assert.equal(allowed.status, 0);
  const denied = call({
    agent_type: 'house-style',
    tool_name: 'Write',
    tool_input: { file_path: join(project.jobFolder(1), 'review-code.md') },
  });
  assert.equal(denied.status, 2);
  const own = call({
    agent_type: 'house-style',
    tool_name: 'Write',
    tool_input: { file_path: join(project.jobFolder(1), 'review-house-style.md') },
  });
  assert.equal(own.status, 0);
});

test('only the UI and UX reviewers can save screens, in their job\'s folder', () => {
  const save = (agent_type) => call({
    agent_type,
    tool_name: 'Write',
    tool_input: { file_path: join(project.jobFolder(1), 'screens/home.png') },
  }).status;
  assert.equal(save('masna:reviewer-ui'), 0);
  assert.equal(save('masna:reviewer-ux'), 0);
  assert.equal(save('masna:reviewer-code'), 2);
  assert.equal(save('masna:reviewer-security'), 2);
  assert.equal(save('masna:approver'), 2);
  assert.equal(save('masna:builder'), 2);
  assert.equal(save('house-style'), 2);
});

test('MCP tools are blocked for Masna\'s agents', () => {
  const result = call({ agent_type: 'masna:builder', tool_name: 'mcp__github__merge_pull_request', tool_input: {} });
  assert.equal(result.status, 2);
});

test('tool events record who and which tool, never the input', () => {
  call({ agent_type: 'masna:builder', tool_name: 'Bash', tool_input: { command: 'echo SECRET-VALUE' } });
  const log = readFileSync(join(project.root, '.masna/events.jsonl'), 'utf8');
  assert.equal(log.includes('SECRET-VALUE'), false);
  assert.match(log, /"type":"tool","agent":"builder","tool":"Bash"/);
});

test('a broken config blocks Masna\'s agents: the guard fails closed', () => {
  const file = join(project.root, '.masna/config.json');
  const good = readFileSync(file, 'utf8');
  writeFileSync(file, '{ not json');
  const result = call({ agent_type: 'masna:builder', tool_name: 'Bash', tool_input: { command: 'ls' } });
  writeFileSync(file, good);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /the guard failed/);
});

test('bad hook input blocks too', () => {
  const result = project.masnaRaw(['guard'], 'this is not json');
  assert.equal(result.status, 2);
});

test('with no run active, ordinary sessions aren\'t guarded', () => {
  const file = join(project.root, '.masna/run.json');
  const old = new Date(Date.now() - 20 * 60_000);
  utimesSync(file, old, old);
  assert.equal(spawnSync(BIN, ['guard'], {
    cwd: project.root,
    env: project.env,
    input: JSON.stringify({ cwd: project.root, ...push }),
    encoding: 'utf8',
  }).status, 0);

  // Masna's own agents are guarded whether or not a run is active.
  const agent = spawnSync(BIN, ['guard'], {
    cwd: project.root,
    env: project.env,
    input: JSON.stringify({ cwd: project.root, agent_type: 'masna:builder', ...push }),
    encoding: 'utf8',
  });
  assert.equal(agent.status, 2);
  project.begin(['--takeover']);
});

test('a project without Masna, or outside git, is left alone', () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'masna-plain-')));
  const run = (cwd) => spawnSync(BIN, ['guard'], {
    cwd,
    env: project.env,
    input: JSON.stringify({ cwd, agent_type: 'masna:builder', ...push }),
    encoding: 'utf8',
  }).status;
  assert.equal(run(plain), 0);
  execFileSync('git', ['init', '--quiet', plain]);
  assert.equal(run(plain), 0);
  mkdirSync(join(plain, '.masna'));
  assert.equal(run(plain), 0);
});

test('the hooks that record agents never fail, even with bad input', () => {
  assert.equal(project.masnaRaw(['agent-ended'], 'not json').status, 0);
  assert.equal(project.masnaRaw(['agent-started'], '{}').status, 0);
});

test('a missing library still blocks: the guard survives a broken install', () => {
  const copy = realpathSync(mkdtempSync(join(tmpdir(), 'masna-broken-')));
  cpSync(fileURLToPath(new URL('../../plugins/masna', import.meta.url)), copy, { recursive: true });
  rmSync(join(copy, 'lib/guard.mjs'));
  const result = spawnSync(join(copy, 'bin/masna'), ['guard'], {
    cwd: project.root,
    env: project.env,
    input: JSON.stringify({ cwd: project.root, agent_type: 'masna:builder', ...push }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /the guard failed/);
  rmSync(copy, { recursive: true, force: true });
});
