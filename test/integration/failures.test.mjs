import assert from 'node:assert/strict';
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { agents, issue, landedOnGroup, Orchestrator, Project } from '../helpers/project.mjs';

const GROUP_BRANCH = 'masna/group/1-milestone-1';

function setup(options, script) {
  const project = new Project(options);
  const orchestrator = new Orchestrator(project, script);
  orchestrator.begin();
  return { project, orchestrator };
}

const spawnCount = (orchestrator, type) => orchestrator.actions
  .filter((action) => action.action === 'spawn')
  .flatMap((action) => action.agents)
  .filter((agent) => agent.type === type).length;

test('a crash during landing is safe to resume, with no duplicate commit or comment', () => {
  const { project, orchestrator } = setup({ issues: [issue(1)] });
  project.updateGitHub((state) => state.failOn.push('issue close'));

  const paused = orchestrator.drive();
  assert.equal(paused.action, 'pause');
  assert.match(paused.reason, /GitHub or the network failed/);
  assert.equal(project.job(1).stage, 'landing');
  assert.deepEqual(landedOnGroup(project, GROUP_BRANCH), ['Masna-Issue: 1']);

  project.updateGitHub((state) => { state.failOn = []; });
  const resumed = new Orchestrator(project);
  resumed.begin();
  assert.match(resumed.drive().reason, /ready for review/);

  assert.deepEqual(landedOnGroup(project, GROUP_BRANCH), ['Masna-Issue: 1']);
  const [only] = project.gitHub().issues;
  assert.equal(only.state, 'CLOSED');
  assert.equal(only.comments.length, 1);
  project.cleanup();
});

test('a GitHub outage pauses the run and blames no issue', () => {
  const { project, orchestrator } = setup({ issues: [issue(1)] });
  project.updateGitHub((state) => state.failOn.push('issue list'));
  const action = orchestrator.drive();
  assert.equal(action.action, 'pause');
  assert.match(action.reason, /GitHub or the network failed/);
  assert.equal(project.gitHub().issues[0].labels.length, 1);
  project.cleanup();
});

test('an agent that ends with no output is started once more', () => {
  let builds = 0;
  const { project, orchestrator } = setup({ issues: [issue(1)] }, {
    1: {
      builder(p, info) {
        builds += 1;
        if (builds > 1) agents.builder(p, info);
      },
    },
  });
  assert.match(orchestrator.drive().reason, /ready for review/);
  assert.equal(spawnCount(orchestrator, 'masna:builder'), 2);
  project.cleanup();
});

test('malformed output counts as no output', () => {
  let reviews = 0;
  const { project, orchestrator } = setup({ issues: [issue(1)] }, {
    1: {
      'reviewer-code': (p, info) => {
        reviews += 1;
        if (reviews === 1) writeFileSync(info.output, 'It looks good to me!\n');
        else agents.reviewer(p, info);
      },
    },
  });
  assert.match(orchestrator.drive().reason, /ready for review/);
  assert.equal(reviews, 2);
  project.cleanup();
});

test('two failures in a row pause the run without using up the retry', () => {
  const silent = () => {};
  const { project, orchestrator } = setup({ issues: [issue(1), issue(2)] }, { 1: { builder: silent } });

  const paused = orchestrator.drive();
  assert.equal(paused.action, 'pause');
  assert.match(paused.reason, /two agents in a row/);
  assert.equal(project.job(1).stage, 'build');
  assert.equal(project.gitHub().issues[0].labels.some((label) => label.name === 'masna:needs-human'), false);
  assert.equal(project.view().run.state, 'paused');

  // Still broken in a new run: that's the job's own problem, so it's now stuck,
  // and the queue moves on.
  const second = new Orchestrator(project, { 1: { builder: silent } });
  second.begin();
  const finished = second.drive();
  assert.equal(project.job(1).stage, 'needs-human');
  assert.match(project.job(1).reason, /ended twice/);
  assert.equal(finished.action, 'pause');
  assert.deepEqual(landedOnGroup(project, GROUP_BRANCH), ['Masna-Issue: 2']);
  project.cleanup();
});

test('an agent that dies on an API failure is restarted and uses no retries', () => {
  let builds = 0;
  const { project, orchestrator } = setup({ issues: [issue(1)] }, {
    1: {
      builder(p, info) {
        builds += 1;
        if (builds === 1) return 'failed';
        return agents.builder(p, info);
      },
    },
  });
  assert.match(orchestrator.drive().reason, /ready for review/);
  assert.equal(builds, 2);
  assert.equal(project.job(1).agents.builder.attempts, 1);
  project.cleanup();
});

test('an outage killing every agent pauses after two, however long it lasts', () => {
  const dead = () => 'failed';
  const { project, orchestrator } = setup({ issues: [issue(1), issue(2)] }, { 1: { builder: dead } });
  const action = orchestrator.drive();
  assert.equal(action.action, 'pause');
  assert.match(action.reason, /usage limit or an outage/);
  assert.equal(project.job(1).stage, 'build');

  const again = new Orchestrator(project, { 1: { builder: dead } });
  again.begin();
  assert.match(again.drive().reason, /usage limit or an outage/);
  assert.equal(project.job(1).stage, 'build');
  project.cleanup();
});

test('an agent still running means wait, until its timeout means pause', () => {
  const crash = () => 'crash';
  const { project, orchestrator } = setup({ issues: [issue(1)] }, { 1: { builder: crash } });
  assert.equal(orchestrator.drive().action, 'crash');
  assert.equal(orchestrator.next().action, 'wait');

  const job = project.job(1);
  job.agents.builder.spawned_at = '2020-01-01T00:00:00Z';
  writeFileSync(join(project.jobFolder(1), 'job.json'), JSON.stringify(job));
  const action = orchestrator.next();
  assert.equal(action.action, 'pause');
  assert.match(action.reason, /hasn't finished after 60 minutes/);
  project.cleanup();
});

test('a builder that says it\'s blocked goes to a person, and the queue carries on', () => {
  const { project, orchestrator } = setup({ issues: [issue(1), issue(2)] }, {
    1: { builder: (p, info) => writeFileSync(info.output, 'STATUS: BLOCKED\n') },
  });
  assert.match(orchestrator.drive().reason, /partial/);
  assert.equal(project.job(1).stage, 'needs-human');
  assert.equal(project.job(2).stage, 'landed');
  project.cleanup();
});

test('a failing baseline pauses before any builder runs, and retries on the next run', () => {
  const { project, orchestrator } = setup({ issues: [issue(1)], checks: 'test -f READY' });
  const paused = orchestrator.drive();
  assert.equal(paused.action, 'pause');
  assert.match(paused.reason, /already fail before any work/);
  assert.equal(spawnCount(orchestrator, 'masna:builder'), 0);

  writeFileSync(join(project.root, '.masna/checks.sh'), 'true\n');
  project.git(['add', '-A']);
  project.git(['commit', '--quiet', '-m', 'Fix the checks']);
  project.git(['push', '--quiet', 'origin', 'main']);

  const next = new Orchestrator(project);
  next.begin();
  assert.match(next.drive().reason, /ready for review/);
  project.cleanup();
});

test('gate failures go back to the builder, up to the limit', () => {
  const failing = (p, info) => {
    writeFileSync(join(info.worktree, 'FAIL'), String(Date.now()));
    agents.builder(p, info);
  };
  const { project, orchestrator } = setup({
    issues: [issue(1)],
    config: { max_gate_fixes: 2 },
  }, { 1: { builder: failing } });

  assert.equal(orchestrator.drive().action, 'pause');
  assert.equal(spawnCount(orchestrator, 'masna:builder'), 3);
  assert.equal(project.job(1).stage, 'needs-human');
  assert.match(project.job(1).reason, /still failing after 2 fixes/);
  assert.equal(spawnCount(orchestrator, 'masna:reviewer-code'), 0);
  project.cleanup();
});

test('checks that run too long count as a failed gate', () => {
  const { project, orchestrator } = setup({
    issues: [issue(1)],
    // The baseline has no work to check, so only the real build hangs.
    checks: 'if [ -f src/1.txt ]; then sleep 30; fi',
    config: { max_gate_fixes: 0, gate_timeout_minutes: 0.02 },
  });
  const started = Date.now();
  orchestrator.drive();
  assert.ok(Date.now() - started < 25_000);
  assert.match(project.job(1).reason, /timed out/);
  project.cleanup();
});

test('a branch that changes a protected path fails the gate', () => {
  for (const path of ['.masna/checks.sh', '.claude/settings.json', 'CLAUDE.md', 'src/AGENTS.md', '.github/workflows/ci.yml']) {
    const { project, orchestrator } = setup({ issues: [issue(1)], config: { max_gate_fixes: 0 } }, {
      1: { builder: (p, info) => agents.builder(p, info, path) },
    });
    orchestrator.drive();
    assert.match(project.job(1).reason, /changes protected paths/, path);
    project.cleanup();
  }
});

test('the gate runs the checks on the base branch, not the branch\'s own copy', () => {
  const { project, orchestrator } = setup({ issues: [issue(1)], config: { max_gate_fixes: 0 } }, {
    1: {
      builder(p, info) {
        agents.builder(p, info);
        writeFileSync(join(p.root, '.masna/checks.sh'), 'exit 3\n');
        p.git(['add', '-A']);
        p.git(['commit', '--quiet', '-m', 'Tighten the checks']);
        p.git(['push', '--quiet', 'origin', 'main']);
        p.git(['reset', '--quiet', '--hard', 'HEAD~1']);
      },
    },
  });
  orchestrator.drive();
  assert.match(project.job(1).reason, /checks\.sh exited with 3/);
  project.cleanup();
});

test('a local change to the config has no effect until it\'s on the base branch', () => {
  const { project, orchestrator } = setup({ issues: [issue(1)] });
  const file = join(project.root, '.masna/config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, reviewers: { '**': ['security'] } }));
  orchestrator.drive();
  assert.equal(spawnCount(orchestrator, 'masna:reviewer-security'), 0);
  assert.equal(spawnCount(orchestrator, 'masna:reviewer-code'), 1);
  project.cleanup();
});

test('the checks get no GitHub or API tokens', () => {
  const { project, orchestrator } = setup({
    issues: [issue(1)],
    checks: 'test -z "$GH_TOKEN$GITHUB_TOKEN$ANTHROPIC_API_KEY"',
  });
  project.env = { ...project.env, GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', ANTHROPIC_API_KEY: 'secret' };
  assert.match(orchestrator.drive().reason, /ready for review/);
  project.cleanup();
});

test('only changed reviewers run again, and an unchanged pass still holds', () => {
  const { project, orchestrator } = setup({ issues: [issue(1)] }, {
    1: {
      builder(p, info) {
        // Round 1 touches the API. Round 2 touches only docs.
        agents.builder(p, info, info.round === 1 ? 'api/a.txt' : 'docs/b.txt');
      },
      'reviewer-code': (p, info) => agents.reviewer(p, info, info.round === 1 ? 'CHANGES' : 'PASS'),
    },
  });
  assert.match(orchestrator.drive().reason, /ready for review/);
  assert.equal(spawnCount(orchestrator, 'masna:reviewer-security'), 1);
  assert.equal(spawnCount(orchestrator, 'masna:reviewer-code'), 2);
  project.cleanup();
});

test('a reviewer runs again if its own files changed since it passed', () => {
  let round = 0;
  const { project, orchestrator } = setup({ issues: [issue(1)] }, {
    1: {
      builder(p, info) {
        round += 1;
        agents.builder(p, info, `api/${round}.txt`);
      },
      'reviewer-code': (p, info) => agents.reviewer(p, info, info.round === 1 ? 'CHANGES' : 'PASS'),
    },
  });
  orchestrator.drive();
  assert.equal(spawnCount(orchestrator, 'masna:reviewer-security'), 2);
  project.cleanup();
});

test('reviewers that keep asking for changes stop at max_rounds', () => {
  const { project, orchestrator } = setup({ issues: [issue(1)], config: { max_rounds: 2 } }, {
    1: { 'reviewer-code': (p, info) => agents.reviewer(p, info, 'CHANGES') },
  });
  orchestrator.drive();
  assert.equal(spawnCount(orchestrator, 'masna:builder'), 2);
  assert.equal(project.job(1).stage, 'needs-human');
  assert.match(project.job(1).reason, /after 2 rounds/);
  project.cleanup();
});

test('an approver asking for a business decision stops the job', () => {
  const { project, orchestrator } = setup({ issues: [issue(1)] }, {
    1: { approver: (p, info) => agents.approver(p, info, 'DECISION-NEEDED') },
  });
  orchestrator.drive();
  assert.match(project.job(1).reason, /a person needs to decide/);
  project.cleanup();
});

test('an issue closed by a person mid-job is cancelled, and its branch is kept', () => {
  let closed = false;
  const { project, orchestrator } = setup({ issues: [issue(1), issue(2)] }, {
    1: {
      'reviewer-code': (p, info) => {
        agents.reviewer(p, info);
        p.updateGitHub((state) => {
          state.issues[0].state = 'CLOSED';
          closed = true;
        });
      },
    },
  });
  assert.match(orchestrator.drive().reason, /ready for review/);
  assert.equal(closed, true);
  assert.equal(project.job(1).stage, 'cancelled');
  assert.equal(project.job(2).stage, 'landed');
  assert.deepEqual(landedOnGroup(project, GROUP_BRANCH), ['Masna-Issue: 2']);
  assert.match(project.git(['branch', '--list', 'masna/issue/1']), /masna\/issue\/1/);
  project.cleanup();
});

test('removing the queue label stops a job at the next check', () => {
  const { project, orchestrator } = setup({ issues: [issue(1)] }, {
    1: {
      approver: (p, info) => {
        agents.approver(p, info);
        p.updateGitHub((state) => { state.issues[0].labels = []; });
      },
    },
  });
  orchestrator.drive();
  assert.equal(project.job(1).stage, 'cancelled');
  assert.equal(project.gitHub().prs.length, 0);
  project.cleanup();
});

test('a body edited after labelling needs a new label before anything runs', () => {
  const { project, orchestrator } = setup({
    issues: [issue(1, { lastEditedAt: '2026-02-01T00:00:00Z', editor: 'mallory' })],
  });
  const action = orchestrator.drive();
  assert.match(action.reason, /nothing landed/);
  assert.equal(project.job(1).stage, 'needs-human');
  assert.match(project.job(1).reason, /edited after it was labelled/);
  assert.equal(spawnCount(orchestrator, 'masna:builder'), 0);

  // A person reads it and labels it again.
  project.updateGitHub((state) => { state.issues[0].labeledAt = '2026-03-01T00:00:00Z'; });
  const next = new Orchestrator(project);
  next.begin();
  assert.match(next.drive().reason, /ready for review/);
  assert.equal(project.job(1).stage, 'landed');
  assert.equal(project.gitHub().issues[0].labels.some((label) => label.name === 'masna:needs-human'), false);
  project.cleanup();
});

test('a title changed after labelling counts as an edit', () => {
  const { project, orchestrator } = setup({
    issues: [issue(1, { renames: [{ createdAt: '2026-02-01T00:00:00Z', actor: { login: 'mallory' } }] })],
  });
  orchestrator.drive();
  assert.match(project.job(1).reason, /edited after it was labelled/);
  project.cleanup();
});

test('a cancelled issue can run again if a person puts it back', () => {
  let cancelled = false;
  const script = {
    1: {
      approver(p, info) {
        agents.approver(p, info);
        if (!cancelled) {
          cancelled = true;
          p.updateGitHub((state) => { state.issues[0].labels = []; });
        }
      },
    },
  };
  const { project, orchestrator } = setup({ issues: [issue(1)] }, script);
  orchestrator.drive();
  assert.equal(project.job(1).stage, 'cancelled');

  project.updateGitHub((state) => {
    state.issues[0].labels = [{ name: 'ready-for-agent' }];
    state.issues[0].labeledAt = '2026-03-01T00:00:00Z';
  });
  const next = new Orchestrator(project, script);
  next.begin();
  assert.match(next.drive().reason, /ready for review/);
  assert.equal(project.job(1).stage, 'landed');
  assert.deepEqual(landedOnGroup(project, GROUP_BRANCH), ['Masna-Issue: 1']);
  project.cleanup();
});

test('an edit by someone with write access is fine', () => {
  const { project, orchestrator } = setup({
    issues: [issue(1, { lastEditedAt: '2026-02-01T00:00:00Z', editor: 'owner' })],
  });
  assert.match(orchestrator.drive().reason, /ready for review/);
  project.cleanup();
});

test('issue.md leaves out comments a person never reviewed', () => {
  const comment = (login, createdAt, body) => ({ author: { login }, createdAt, body });
  const { project, orchestrator } = setup({
    issues: [issue(1, {
      comments: [
        comment('alice', '2026-01-05T00:00:00Z', 'AUTHOR-BEFORE'),
        comment('alice', '2026-02-05T00:00:00Z', 'AUTHOR-AFTER'),
        comment('mallory', '2026-01-05T00:00:00Z', 'STRANGER'),
        comment('owner', '2026-02-05T00:00:00Z', 'OWNER-AFTER'),
      ],
    })],
  });
  orchestrator.drive();
  const data = readFileSync(join(project.jobFolder(1), 'issue.md'), 'utf8');
  assert.match(data, /AUTHOR-BEFORE/);
  assert.match(data, /OWNER-AFTER/);
  assert.doesNotMatch(data, /AUTHOR-AFTER/);
  assert.doesNotMatch(data, /STRANGER/);
  project.cleanup();
});

test('unreadable issues and dependency cycles go to a person, with dependents skipped', () => {
  const { project, orchestrator } = setup({
    issues: [
      { ...issue(1), body: 'No sections at all' },
      issue(2, { blockedBy: [3] }),
      issue(3, { blockedBy: [2] }),
      issue(4, { blockedBy: [1] }),
      issue(5),
    ],
  });
  assert.match(orchestrator.drive().reason, /partial/);
  const labelled = (number) => project.gitHub().issues.find((i) => i.number === number).labels.some((l) => l.name === 'masna:needs-human');
  assert.equal(labelled(1), true);
  assert.equal(labelled(2), true);
  assert.equal(labelled(3), true);
  assert.equal(labelled(4), false);
  assert.equal(project.job(5).stage, 'landed');
  const rows = new Map(project.view().groups[0].issues.map((row) => [row.number, row]));
  assert.equal(rows.get(4).state, 'skipped');
  project.cleanup();
});

test('blockers outside the queue must be done', () => {
  const { project, orchestrator } = setup({
    issues: [
      issue(1, { blockedBy: [10] }),
      issue(2, { blockedBy: [11] }),
      issue(3, { blockedBy: [12] }),
      issue(10, { milestone: null, labels: [], state: 'CLOSED', stateReason: 'COMPLETED' }),
      issue(11, { milestone: null, labels: [], state: 'CLOSED', stateReason: 'NOT_PLANNED' }),
      issue(12, { milestone: null, labels: [] }),
    ],
  });
  orchestrator.drive();
  assert.equal(project.job(1).stage, 'landed');
  assert.match(project.job(2).reason, /closed without being done/);
  assert.match(project.job(3).reason, /open and outside/);
  project.cleanup();
});

test('labelled issues outside any milestone are never picked up', () => {
  const { project, orchestrator } = setup({ issues: [issue(1, { milestone: null })] });
  assert.equal(orchestrator.drive().action, 'done');
  assert.equal(project.gitHub().issues[0].state, 'OPEN');
  project.cleanup();
});

test('the view shows a dead run as stalled, not running', () => {
  const { project, orchestrator } = setup({ issues: [issue(1)] }, { 1: { builder: () => 'crash' } });
  orchestrator.drive();
  assert.equal(project.view().run.state, 'running');
  assert.equal(project.view().current.stage, 'build');
  assert.deepEqual(project.view().current.agents.map((agent) => [agent.name, agent.state]), [['builder', 'running']]);

  const old = new Date(Date.now() - 20 * 60_000);
  utimesSync(join(project.root, '.masna/run.json'), old, old);
  assert.equal(project.view().run.state, 'stalled');
  // A stalled run no longer blocks a new one.
  assert.equal(project.begin().action, 'started');
  project.cleanup();
});

test('masna status prints what\'s happening', () => {
  const { project, orchestrator } = setup({ issues: [issue(1), issue(2, { blockedBy: [1] })] }, {
    1: { approver: (p, info) => agents.approver(p, info, 'REJECT') },
  });
  orchestrator.drive();
  const text = project.masna(['status']);
  assert.match(text, /run r1: paused/);
  assert.match(text, /group 1: 0 of 2 landed/);
  assert.match(text, /#1 stuck: the approver says the criteria aren't met/);
  assert.match(text, /#2 skipped: blocked by stuck #1/);
  project.cleanup();
});
