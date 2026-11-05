import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalizeConfig } from '../../plugins/masna/lib/config.mjs';
import { decide } from '../../plugins/masna/lib/guard.mjs';
import { simpleCommands, writeTargets } from '../../plugins/masna/lib/shell.mjs';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'masna-guard-')));
const worktree = join(root, '.masna/worktrees/3-checkout');
const jobFolder = join(root, '.masna/jobs/12');
mkdirSync(worktree, { recursive: true });
mkdirSync(jobFolder, { recursive: true });

const config = normalizeConfig({
  never_touch: ['secrets/**'],
  blocked_commands: ['npm publish'],
});

const context = (agent, overrides = {}) => ({
  root,
  config,
  agent,
  worktreeRoots: [worktree],
  baseBranch: 'main',
  branchIn: () => 'masna/issue/12',
  ...overrides,
});
const builder = { kind: 'builder', short: 'builder', ownFile: join(jobFolder, 'build.md'), worktree };
const reviewer = { kind: 'reviewer', short: 'reviewer-code', ownFile: join(jobFolder, 'review-code.md') };
const finisher = { kind: 'finisher', short: 'finisher', ownFile: join(root, '.masna/jobs/group-3/group.md') };

const bash = (command, agent = null, overrides = {}) => decide({
  toolName: 'Bash', toolInput: { command }, cwd: worktree, context: context(agent, overrides),
});
const write = (path, agent = null, toolName = 'Write') => decide({
  toolName, toolInput: { file_path: path, notebook_path: path }, cwd: worktree, context: context(agent),
});

for (const command of [
  'git push origin main',
  'git push origin HEAD:main',
  'git push origin feature:refs/heads/main',
  'git push -f origin masna/issue/12',
  'git push --force origin x',
  'git push --force-with-lease origin x',
  'git push origin +x',
  'git push --all',
  'git push --mirror',
  'git -C /some/where push origin main',
  'cd x && git push origin main',
  'true; git push origin main',
  'bash -c "git push origin main"',
  'sh -c \'git push origin main\'',
  'eval git push origin main',
  'FOO=1 git push origin main',
  'sudo git push origin main',
  'echo $(git push origin main)',
  'echo `git push origin main`',
  'gh pr merge 3',
  'gh pr merge 3 --squash',
  'gh -R a/b pr merge 3',
  'gh --repo a/b pr merge 3',
  'gh api repos/a/b/pulls/3/merge -X PUT',
  'gh api repos/a/b/merges -f base=main',
  'gh api repos/a/b/git/refs/heads/main -X PATCH',
  'npm publish',
  'cd a && npm publish --tag x',
]) {
  test(`everyone is blocked from: ${command}`, () => {
    assert.equal(bash(command).allow, false);
    assert.equal(bash(command, builder).allow, false);
  });
}

for (const command of [
  'git push origin masna/issue/12',
  'git push -u origin masna/group/3-checkout',
  'git status',
  'git log --oneline',
  'gh pr view 3',
  'gh issue list',
  'echo "git push origin main"',
  'npm test',
]) {
  test(`allowed: ${command}`, () => {
    assert.equal(bash(command).allow, true);
  });
}

test('a bare push is blocked only on the base branch', () => {
  assert.equal(bash('git push').allow, true);
  assert.equal(bash('git push', null, { branchIn: () => 'main' }).allow, false);
  assert.equal(bash('git push origin HEAD', null, { branchIn: () => 'main' }).allow, false);
});

test('everyone is blocked from never_touch paths', () => {
  assert.equal(write(join(root, 'secrets/key')).allow, false);
  assert.equal(write(join(worktree, 'secrets/key')).allow, false);
  assert.equal(bash('echo x > secrets/key').allow, false);
  assert.equal(write(join(root, 'src/a.ts')).allow, true);
});

test('the builder writes inside its worktree, even though that\'s under .masna', () => {
  assert.equal(write(join(worktree, 'src/a.ts'), builder).allow, true);
  assert.equal(write('src/a.ts', builder).allow, true);
});

test('the builder can write its own build.md', () => {
  assert.equal(write(join(jobFolder, 'build.md'), builder).allow, true);
});

test('protected paths match relative to the worktree', () => {
  for (const path of ['.masna/checks.sh', '.claude/settings.json', '.mcp.json', 'CLAUDE.md', 'src/CLAUDE.md', 'AGENTS.md', '.github/workflows/ci.yml']) {
    assert.equal(write(join(worktree, path), builder).allow, false, path);
  }
});

test('the builder can\'t write outside its worktree', () => {
  assert.equal(write(join(root, 'src/a.ts'), builder).allow, false);
  assert.equal(write('/etc/hosts', builder).allow, false);
  assert.equal(write(join(jobFolder, 'decision.md'), builder).allow, false);
  assert.equal(write(join(worktree, '../../jobs/12/decision.md'), builder).allow, false);
});

test('a symlink can\'t lead the builder out of its worktree', () => {
  const link = join(worktree, 'escape');
  symlinkSync(join(root, 'src'), link);
  assert.equal(write(join(link, 'a.ts'), builder).allow, false);
});

test('NotebookEdit follows the same path rules', () => {
  assert.equal(write(join(root, 'nb.ipynb'), builder, 'NotebookEdit').allow, false);
  assert.equal(write(join(worktree, 'nb.ipynb'), builder, 'NotebookEdit').allow, true);
});

test('Bash writes follow the same rules for the builder', () => {
  assert.equal(bash('echo x > src/a.ts', builder).allow, true);
  assert.equal(bash('echo x > .masna/checks.sh', builder).allow, false);
  assert.equal(bash('echo x > CLAUDE.md', builder).allow, false);
  assert.equal(bash('echo x >> /etc/hosts', builder).allow, false);
  assert.equal(bash('rm -rf .claude', builder).allow, false);
  assert.equal(bash('echo x | tee .mcp.json', builder).allow, false);
  assert.equal(bash('cp a.ts ../../jobs/12/decision.md', builder).allow, false);
  assert.equal(bash('sed -i.bak s/a/b/ CLAUDE.md', builder).allow, false);
  assert.equal(bash('echo x > "$HOME/a"', builder).allow, false);
  assert.equal(bash('npm test > /dev/null 2>&1', builder).allow, true);
});

test('reviewers and the finisher write only their own output file', () => {
  assert.equal(write(join(jobFolder, 'review-code.md'), reviewer).allow, true);
  assert.equal(write(join(jobFolder, 'review-security.md'), reviewer).allow, false);
  assert.equal(write(join(worktree, 'src/a.ts'), reviewer).allow, false);
  assert.equal(write(join(jobFolder, 'decision.md'), reviewer).allow, false);
  assert.equal(bash('echo x > src/a.ts', reviewer).allow, false);
  assert.equal(bash('git diff HEAD~1', reviewer).allow, true);
  assert.equal(write(join(root, '.masna/jobs/group-3/group.md'), finisher).allow, true);
  assert.equal(write(join(worktree, 'a.ts'), finisher).allow, false);
});

test('a reviewer given a screens folder can write there, and only there', () => {
  const screens = join(jobFolder, 'screens');
  const ui = { kind: 'reviewer', short: 'reviewer-ui', ownFile: join(jobFolder, 'review-ui.md'), screens };
  assert.equal(write(join(screens, 'home.png'), ui).allow, true);
  assert.equal(bash(`mkdir -p ${screens}`, ui).allow, true);
  assert.equal(write(join(jobFolder, 'screens-other/home.png'), ui).allow, false);
  assert.equal(write(join(screens, '../decision.md'), ui).allow, false);
  assert.equal(write(join(worktree, 'src/a.ts'), ui).allow, false);
  assert.equal(write(join(screens, 'home.png'), reviewer).allow, false);
});

test('a screens folder that links elsewhere leads nowhere', () => {
  const screens = join(jobFolder, 'screens-link');
  symlinkSync(worktree, screens);
  const ui = { kind: 'reviewer', short: 'reviewer-ui', ownFile: join(jobFolder, 'review-ui.md'), screens };
  assert.equal(write(join(screens, 'a.ts'), ui).allow, false);
});

test('a cd earlier in the command decides where the main session\'s writes land', () => {
  const fromRoot = (command) => decide({
    toolName: 'Bash', toolInput: { command }, cwd: root, context: context(null),
  });
  mkdirSync(join(root, 'secrets'), { recursive: true });
  assert.equal(fromRoot('cd secrets && echo x > a.ts').allow, false);
  assert.equal(fromRoot('cd secrets; cd ..; echo x > a.ts').allow, true);
  assert.equal(fromRoot(`cd ${worktree} && echo x > a.ts`).allow, true);
});

// All 20 calls Claude Code denied in the first real run held a cd, and none without
// one was denied. Its message blames Bash as a whole, so agents gave up on running
// tests. Refusing the same calls here tells them what to send instead.
for (const command of [
  'cd /wt && git status',
  'cd /wt && npm test 2>&1 | tail -15; git status --short',
  'cd /wt; git -C /wt diff',
  'cd /jobs/2 && ls; ls ../../rules 2>/dev/null',
  'cd /wt && cat ../../rules/*.md',
  'cd /jobs && ls -a ../',
  'cd /wt && mkdir -p x',
  'cd /wt && echo x > src/a.ts',
  'ls /wt; mkdir -p /jobs/3/screens; cd /jobs/3/screens && npx playwright screenshot http://x y.png',
]) {
  test(`an agent is told why it can't send: ${command}`, () => {
    for (const agent of [builder, reviewer, finisher]) {
      const decision = bash(command, agent);
      assert.equal(decision.allow, false);
      assert.match(decision.reason, /Claude Code refuses a call with cd/);
      assert.match(decision.reason, /git -C/);
    }
  });
}

for (const command of [
  `cd ${worktree} && npm test`,
  `cd ${worktree} && npm test 2>&1 | tail -8`,
  `cd ${worktree} && npm test 2>/dev/null`,
  `cd ${jobFolder} && ls && cat a.md b.md 2>/dev/null`,
  `git -C ${worktree} status --short; ls ${jobFolder}`,
  'ls ../other',
  `mkdir -p ${worktree}/src`,
]) {
  test(`an agent can send: ${command}`, () => {
    assert.equal(bash(command, builder).allow, true);
  });
}

test('the main session\'s cd calls are left to Claude Code', () => {
  assert.equal(bash('cd /wt && git status').allow, true);
});

test('MCP tools are blocked for Masna\'s agents only', () => {
  const call = (agent) => decide({ toolName: 'mcp__github__merge_pull_request', toolInput: {}, cwd: worktree, context: context(agent) });
  assert.equal(call(builder).allow, false);
  assert.equal(call(reviewer).allow, false);
  assert.equal(call(null).allow, true);
});

test('simpleCommands looks inside shells, eval and substitutions', () => {
  const names = (text) => simpleCommands(text).map((c) => c.name);
  assert.deepEqual(names('a && b | c; d'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(names('bash -c "a; b"'), ['a', 'b']);
  assert.ok(names('echo $(a)').includes('a'));
});

test('writeTargets finds what a pattern check can', () => {
  const targets = (text) => simpleCommands(text).flatMap(writeTargets);
  assert.deepEqual(targets('echo x > a'), ['a']);
  assert.deepEqual(targets('echo x >> a 2>&1'), ['a']);
  assert.deepEqual(targets('echo x 2> err'), ['err']);
  assert.deepEqual(targets('echo x &> a'), ['a']);
  assert.deepEqual(targets('rm -rf a b'), ['a', 'b']);
  assert.deepEqual(targets('cp a b c'), ['c']);
  assert.deepEqual(targets('mv a b'), ['a', 'b']);
  assert.deepEqual(targets('chmod +x a'), ['a']);
  assert.deepEqual(targets('dd if=a of=b'), ['b']);
  assert.deepEqual(targets('sed -i s/a/b/ c'), ['c']);
  assert.deepEqual(targets('sed s/a/b/ c'), []);
  assert.deepEqual(targets('ls -la'), []);
});
