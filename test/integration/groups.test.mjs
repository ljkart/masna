import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { agents, issue, landedOnGroup, Orchestrator, Project } from '../helpers/project.mjs';

const milestones = [
  { number: 1, title: 'Sign in' },
  { number: 2, title: 'Check out, part 2!' },
];
const GROUP_1 = 'masna/group/1-sign-in';
const GROUP_2 = 'masna/group/2-check-out-part-2';

function run(project, script) {
  const orchestrator = new Orchestrator(project, script);
  orchestrator.begin();
  return { orchestrator, action: orchestrator.drive() };
}

const pushToBase = (project, file, text) => {
  writeFileSync(join(project.root, file), text);
  project.git(['add', '-A']);
  project.git(['commit', '--quiet', '-m', `Change ${file}`]);
  project.git(['push', '--quiet', 'origin', 'main']);
};

test('groups run one at a time, by milestone order, as stacked PRs', () => {
  const project = new Project({ milestones, issues: [issue(1, { milestone: 1 }), issue(2, { milestone: 2 })] });

  assert.match(run(project).action.reason, /group 1: PR #900 is ready/);
  assert.equal(project.job(1).stage, 'landed');
  assert.equal(existsSync(project.jobFolder(2)), false);

  assert.match(run(project).action.reason, /group 2: PR #901 is ready/);
  const [first, second] = project.gitHub().prs;
  assert.equal(first.baseRefName, 'main');
  assert.equal(first.headRefName, GROUP_1);
  assert.equal(second.baseRefName, GROUP_1);
  assert.equal(second.headRefName, GROUP_2);
  assert.equal(project.remote(['rev-list', '--count', `${GROUP_1}..${GROUP_2}`]), '1');

  assert.equal(run(project).action.action, 'done');
  project.cleanup();
});

test('milestones with due dates come first', () => {
  const project = new Project({
    milestones: [{ number: 1, title: 'Later' }, { number: 2, title: 'Sooner', due_on: '2026-12-01T00:00:00Z' }],
    issues: [issue(1, { milestone: 1 }), issue(2, { milestone: 2 })],
  });
  run(project);
  assert.equal(project.job(2).stage, 'landed');
  assert.equal(existsSync(project.jobFolder(1)), false);
  project.cleanup();
});

test('pause_after_group false carries straight on to the next group', () => {
  const project = new Project({
    milestones,
    issues: [issue(1, { milestone: 1 }), issue(2, { milestone: 2 })],
    config: { pause_after_group: false },
  });
  assert.equal(run(project).action.action, 'done');
  assert.equal(project.gitHub().prs.length, 2);
  project.cleanup();
});

test('a group with stuck issues holds back the next group, until they\'re dealt with', () => {
  const project = new Project({ milestones, issues: [issue(1, { milestone: 1 }), issue(3, { milestone: 1 }), issue(2, { milestone: 2 })] });
  const script = { 1: { approver: (p, info) => agents.approver(p, info, 'REJECT') } };

  assert.match(run(project, script).action.reason, /partial/);
  const held = run(project, script).action;
  assert.match(held.reason, /still has issues to deal with: #1/);
  assert.equal(existsSync(project.jobFolder(2)), false);

  // A person removes the stuck issue from the queue, and the next group can start.
  project.updateGitHub((state) => {
    state.issues.find((candidate) => candidate.number === 1).labels = [];
  });
  assert.match(run(project, script).action.reason, /group 2: PR/);
  project.cleanup();
});

test('a group where nothing landed opens no PR', () => {
  const project = new Project({ issues: [issue(1)] });
  const { action } = run(project, { 1: { approver: (p, info) => agents.approver(p, info, 'REJECT') } });
  assert.match(action.reason, /nothing landed/);
  assert.equal(project.gitHub().prs.length, 0);
  project.cleanup();
});

test('the base branch is merged in before the PR opens', () => {
  const project = new Project({ issues: [issue(1)] });
  const { action } = run(project, {
    1: {
      approver(p, info) {
        agents.approver(p, info);
        pushToBase(p, 'base-moved.txt', 'x\n');
      },
    },
  });
  assert.match(action.reason, /ready for review/);
  assert.ok(project.remote(['ls-tree', '--name-only', 'masna/group/1-milestone-1']).includes('base-moved.txt'));
  project.cleanup();
});

test('a conflict with the base branch pauses, and resumes after a person fixes it', () => {
  const project = new Project({ issues: [issue(1)] });
  const script = {
    1: {
      builder: (p, info) => agents.builder(p, info, 'shared.txt'),
      approver(p, info) {
        agents.approver(p, info);
        pushToBase(p, 'shared.txt', 'from base\n');
      },
    },
  };
  const { action } = run(project, script);
  assert.match(action.reason, /conflicts with origin\/main/);
  assert.equal(project.gitHub().prs.length, 0);

  // The person merges by hand in the group's worktree and pushes.
  const worktree = join(project.root, project.group(1).worktree);
  try {
    project.git(['merge', '--no-edit', 'origin/main'], worktree);
  } catch {
    writeFileSync(join(worktree, 'shared.txt'), 'resolved\n');
    project.git(['add', '-A'], worktree);
    project.git(['commit', '--quiet', '--no-edit'], worktree);
  }
  project.git(['push', '--quiet', 'origin', 'HEAD'], worktree);

  assert.match(run(project, script).action.reason, /ready for review/);
  project.cleanup();
});

test('checks failing on the whole group pause the run', () => {
  const project = new Project({
    issues: [issue(1)],
    checks: 'test ! -f FAIL && test ! -f BREAKS_WHOLE_GROUP',
  });
  const { action } = run(project, {
    1: {
      approver(p, info) {
        agents.approver(p, info);
        pushToBase(p, 'BREAKS_WHOLE_GROUP', 'x\n');
      },
    },
  });
  assert.match(action.reason, /checks failed on the whole group/);
  assert.equal(project.gitHub().prs.length, 0);
  project.cleanup();
});

test('a finisher that isn\'t ready stops the PR', () => {
  const project = new Project({ issues: [issue(1)] });
  const { action } = run(project, {
    'group-1': { finisher: (p, info) => agents.finisher(p, info, 'BLOCKED') },
  });
  assert.match(action.reason, /the finisher says it isn't ready/);
  assert.equal(project.gitHub().prs.length, 0);
  project.cleanup();
});

test('a group the finisher blocked can be fixed through feedback, and then gets its PR', () => {
  const project = new Project({ issues: [issue(1), issue(2, { blockedBy: [1] })] });
  let finishes = 0;
  const script = {
    'group-1': {
      finisher(p, info) {
        finishes += 1;
        agents.finisher(p, info, finishes === 1 ? 'BLOCKED' : 'READY');
      },
    },
  };
  const blocked = run(project, script).action;
  assert.match(blocked.reason, /the finisher says it isn't ready/);
  assert.match(blocked.reason, /\/masna:feedback/);

  // Running again without a fix can't help, and says the same thing.
  assert.match(run(project, script).action.reason, /the finisher says it isn't ready/);
  assert.equal(finishes, 1);

  const reply = project.masna(['feedback', '2'], 'Add the missing header to the handler.');
  assert.match(reply, /saved as job g1-f1/);
  assert.match(readFileSync(join(project.jobFolder('g1-f1'), 'feedback.md'), 'utf8'), /missing header/);

  const { action } = run(project, script);
  assert.match(action.reason, /PR #900 is ready for review/);
  assert.equal(finishes, 2);
  assert.equal(project.gitHub().prs.length, 1);
  assert.equal(project.job('g1-f1').stage, 'landed');
  project.cleanup();
});

test('feedback on a landed issue is still refused while its group is under way', () => {
  const project = new Project({ issues: [issue(1), issue(2, { blockedBy: [1] })] });
  const { action } = run(project, { 2: { builder: () => 'crash' } });
  assert.equal(action.action, 'crash');
  const refused = project.masnaRaw(['feedback', '1'], 'Change it.');
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /#1 has landed/);
  assert.doesNotMatch(refused.stdout, /PR #\?/);
  project.cleanup();
});

test('once the group below merges, a stacked group moves onto the base branch', () => {
  const project = new Project({
    milestones,
    issues: [issue(1, { milestone: 1 }), issue(2, { milestone: 2 }), issue(3, { milestone: 2 })],
  });
  run(project);

  // Partway through group 2, a person merges group 1's PR into main.
  let merged = false;
  const script = {
    2: {
      approver(p, info) {
        agents.approver(p, info);
        p.git(['fetch', '--quiet', 'origin']);
        p.git(['merge', '--quiet', '--no-edit', `origin/${GROUP_1}`]);
        p.git(['push', '--quiet', 'origin', 'main']);
        p.updateGitHub((state) => { state.prs[0].state = 'MERGED'; });
        merged = true;
      },
    },
  };
  const { action } = run(project, script);
  assert.equal(merged, true);
  assert.match(action.reason, /group 2: PR/);
  const second = project.gitHub().prs.find((pr) => pr.headRefName === GROUP_2);
  assert.equal(second.baseRefName, 'main');
  assert.equal(project.group(2).parent.kind, 'base');
  project.cleanup();
});

test('feedback on a group PR is its own job, and merges forward into later groups', () => {
  const project = new Project({ milestones, issues: [issue(1, { milestone: 1 }), issue(2, { milestone: 2 })] });
  run(project);
  run(project);

  const reply = project.masna(['feedback', '900'], 'Rename the button.');
  assert.match(reply, /g1-f1/);
  assert.equal(project.job('g1-f1').stage, 'build');
  assert.match(readFileSync(join(project.jobFolder('g1-f1'), 'feedback.md'), 'utf8'), /Rename the button/);

  const before = project.gitHub().calls.length;
  const { orchestrator, action } = run(project, {
    'g1-f1': { builder: (p, info) => agents.builder(p, info, 'renamed.txt') },
  });
  assert.equal(action.action, 'done');
  assert.equal(project.job('g1-f1').stage, 'landed');
  assert.ok(orchestrator.actions.some((step) => step.action === 'spawn' && step.agents[0].prompt.includes('feedback.md')));

  assert.deepEqual(landedOnGroup(project, GROUP_1), ['Masna-Job: g1-f1', 'Masna-Issue: 1']);
  assert.ok(project.remote(['ls-tree', '-r', '--name-only', GROUP_2]).includes('renamed.txt'));
  // It went through the normal stages, and created no new PR.
  assert.equal(project.gitHub().prs.length, 2);
  assert.ok(project.gitHub().calls.length > before);
  assert.deepEqual(project.view().groups[0].feedback_jobs.map((job) => [job.id, job.stage]), [['g1-f1', 'landed']]);
  project.cleanup();
});

test('an open PR stacked on a merged group moves to the base branch', () => {
  const project = new Project({ milestones, issues: [issue(1, { milestone: 1 }), issue(2, { milestone: 2 })] });
  run(project);
  run(project);
  assert.equal(project.gitHub().prs[1].baseRefName, GROUP_1);

  project.git(['fetch', '--quiet', 'origin']);
  project.git(['merge', '--quiet', '--no-edit', `origin/${GROUP_1}`]);
  project.git(['push', '--quiet', 'origin', 'main']);
  project.updateGitHub((state) => { state.prs[0].state = 'MERGED'; });

  assert.equal(run(project).action.action, 'done');
  assert.equal(project.gitHub().prs[1].baseRefName, 'main');
  project.cleanup();
});

test('a stuck feedback job can be sent back by its id', () => {
  const project = new Project({ issues: [issue(1)] });
  run(project);
  project.masna(['feedback', '900'], 'Rename the button.');

  const reject = (p, info) => agents.approver(p, info, 'REJECT');
  run(project, { 'g1-f1': { approver: reject } });
  assert.equal(project.job('g1-f1').stage, 'needs-human');

  project.masna(['feedback', 'g1-f1'], 'It should say Save.');
  assert.equal(project.job('g1-f1').stage, 'build');
  run(project);
  assert.equal(project.job('g1-f1').stage, 'landed');
  project.cleanup();
});

test('feedback is refused where it can\'t apply', () => {
  const project = new Project({ issues: [issue(1), issue(2)] });
  const refused = (number, text = 'Do more.') => {
    const result = project.masnaRaw(['feedback', String(number)], text);
    assert.equal(result.status, 1);
    return result.stdout;
  };
  run(project);

  assert.match(refused(1), /has landed: send feedback on group PR #900/);
  assert.match(refused(555), /no job for #555/);
  assert.match(refused(900, '   '), /no feedback text/);
  assert.match(refused('../../etc'), /isn't an issue, PR or job/);

  project.updateGitHub((state) => { state.prs[0].state = 'MERGED'; });
  assert.match(refused(900), /is merged/);
  project.cleanup();
});

test('the worktree is reused between issues, and setup runs for each one', () => {
  const project = new Project({
    issues: [issue(1), issue(2)],
    setup: 'echo run >> /dev/null; mkdir -p node_modules; echo x >> node_modules/.count',
    checks: 'test -d node_modules',
  });
  writeFileSync(join(project.root, '.gitignore'), `${readFileSync(join(project.root, '.gitignore'), 'utf8')}node_modules/\n`);
  project.git(['add', '-A']);
  project.git(['commit', '--quiet', '-m', 'Ignore dependencies']);
  project.git(['push', '--quiet', 'origin', 'main']);

  assert.match(run(project).action.reason, /ready for review/);
  const worktree = join(project.root, project.group(1).worktree);
  const count = readFileSync(join(worktree, 'node_modules/.count'), 'utf8').trim().split('\n').length;
  // Baseline, then setup and gate for each of two issues, then the group's gate.
  assert.ok(count >= 6, `setup ran ${count} times`);
  project.cleanup();
});

test('a preview starts for screen reviewers, and stops afterwards', () => {
  const preview = 'exec node -e "require(\'http\').createServer((q,s)=>s.end(\'ok\')).listen(process.env.PORT,\'127.0.0.1\')"';
  const project = new Project({ issues: [issue(1)], preview });
  let url = null;
  const { action } = run(project, {
    1: {
      builder: (p, info) => agents.builder(p, info, 'web/a.txt'),
      'reviewer-ui': (p, info) => {
        url = info.preview;
        agents.reviewer(p, info);
      },
      'reviewer-code': (p, info) => {
        assert.equal(info.preview, undefined);
        agents.reviewer(p, info);
      },
    },
  });
  assert.match(action.reason, /ready for review/);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const pid = JSON.parse(readFileSync(join(project.jobFolder(1), 'job.json'), 'utf8')).preview;
  assert.equal(pid, null);
  project.cleanup();
});

test('with no preview, screen reviewers are told so', () => {
  const project = new Project({ issues: [issue(1)] });
  let told = null;
  run(project, {
    1: {
      builder: (p, info) => agents.builder(p, info, 'web/a.txt'),
      'reviewer-ui': (p, info) => {
        told = info.preview;
        agents.reviewer(p, info);
      },
    },
  });
  assert.equal(told, 'none');
  project.cleanup();
});
