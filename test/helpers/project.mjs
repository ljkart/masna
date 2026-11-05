import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../plugins/masna/bin/masna', import.meta.url));
const FAKE_BIN = fileURLToPath(new URL('./bin', import.meta.url));
chmodSync(join(FAKE_BIN, 'gh'), 0o755);

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
const LABEL = 'ready-for-agent';
const LABELED_AT = '2026-01-10T00:00:00Z';

export function issueBody(blockedBy = []) {
  const blocked = blockedBy.length ? blockedBy.map((n) => `- #${n}`).join('\n') : 'None';
  return `## What to build\nA small change.\n\n## Acceptance criteria\n- [ ] It works\n\n## Blocked by\n${blocked}\n`;
}

export function issue(number, { blockedBy = [], milestone = 1, title = `Issue ${number}`, ...rest } = {}) {
  return {
    number,
    title,
    body: issueBody(blockedBy),
    state: 'OPEN',
    stateReason: '',
    milestone: milestone === null ? null : { number: milestone, title: `Milestone ${milestone}` },
    labels: [{ name: LABEL }],
    author: { login: 'alice' },
    comments: [],
    labeledAt: LABELED_AT,
    ...rest,
  };
}

const DEFAULT_CONFIG = {
  base_branch: 'main',
  reviewers: {
    'api/**': ['code', 'security'],
    'web/**': ['code', 'ui'],
    '**': ['code'],
  },
  models: { builder: 'opus', code: 'sonnet' },
};

export class Project {
  constructor({
    issues = [],
    milestones = [{ number: 1, title: 'Milestone 1' }],
    config = {},
    checks = 'test ! -f FAIL',
    setup = 'true',
    preview = null,
  } = {}) {
    this.dir = realpathSync(mkdtempSync(join(tmpdir(), 'masna-test-')));
    this.origin = join(this.dir, 'origin.git');
    this.root = join(this.dir, 'project');
    this.statePath = join(this.dir, 'gh.json');
    this.env = {
      ...process.env,
      ...IDENTITY,
      PATH: `${FAKE_BIN}:${process.env.PATH}`,
      FAKE_GH_STATE: this.statePath,
    };
    this.setGitHub({
      milestones: milestones.map((milestone) => ({ due_on: null, ...milestone })),
      issues,
      prs: [],
      calls: [],
      failOn: [],
      operator: 'owner',
      writers: ['owner'],
      nextNumber: 900,
    });

    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch', 'main', this.origin], { env: this.env });
    execFileSync('git', ['clone', '--quiet', this.origin, this.root], { env: this.env, stdio: 'ignore' });
    this.git(['checkout', '--quiet', '-B', 'main']);

    mkdirSync(join(this.root, '.masna'), { recursive: true });
    const file = (name, text) => writeFileSync(join(this.root, name), `${text}\n`);
    file('.masna/config.json', JSON.stringify({ ...DEFAULT_CONFIG, ...config }, null, 2));
    file('.masna/checks.sh', checks);
    file('.masna/setup.sh', setup);
    if (preview) file('.masna/preview.sh', preview);
    file('.gitignore', [
      '.masna/jobs/', '.masna/worktrees/', '.masna/run.json', '.masna/events*.jsonl', '.masna/queue.json',
    ].join('\n'));
    file('README.md', 'A project.');
    this.git(['add', '-A']);
    this.git(['commit', '--quiet', '-m', 'Start']);
    this.git(['push', '--quiet', '-u', 'origin', 'main']);
  }

  git(args, cwd = this.root) {
    return execFileSync('git', args, { cwd, env: this.env, encoding: 'utf8' }).trim();
  }

  // The state of the bare remote, which is what really left the machine.
  remote(args) {
    return execFileSync('git', args, { cwd: this.origin, env: this.env, encoding: 'utf8' }).trim();
  }

  gitHub() {
    return JSON.parse(readFileSync(this.statePath, 'utf8'));
  }

  setGitHub(state) {
    writeFileSync(this.statePath, JSON.stringify(state, null, 2));
  }

  updateGitHub(change) {
    const state = this.gitHub();
    change(state);
    this.setGitHub(state);
  }

  masnaRaw(args, input = '', cwd = this.root) {
    return spawnSync(BIN, args, { cwd, env: this.env, input, encoding: 'utf8' });
  }

  masna(args, input = '') {
    const result = this.masnaRaw(args, input);
    if (result.status !== 0) throw new Error(`masna ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }

  json(args, input) {
    return JSON.parse(this.masna(args, input));
  }

  begin(options = []) {
    return this.json(['begin', ...options]);
  }

  view() {
    return this.json(['status', '--json']);
  }

  jobFolder(id) {
    return join(this.root, '.masna/jobs', String(id));
  }

  job(id) {
    return JSON.parse(readFileSync(join(this.jobFolder(id), 'job.json'), 'utf8'));
  }

  group(number) {
    return JSON.parse(readFileSync(join(this.jobFolder(`group-${number}`), 'group.json'), 'utf8'));
  }

  cleanup() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const field = (prompt, name) => prompt.match(new RegExp(`${name}: ([^ ]+?)\\.(?: |$)`))?.[1];

function promptInfo(prompt) {
  return {
    job: field(prompt, 'Job') ?? `group-${field(prompt, 'Group')}`,
    folder: field(prompt, 'Job folder'),
    worktree: field(prompt, 'Worktree'),
    round: Number(field(prompt, 'Round')),
    commit: field(prompt, 'Commit'),
    output: field(prompt, 'Output'),
    preview: field(prompt, 'Preview'),
  };
}

// What real agents do by default: build a commit, or approve what they're shown.
const defaults = {
  builder(project, info, file = `src/${info.job}.txt`) {
    const path = join(info.worktree, file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, `round ${info.round} at ${Date.now()}\n`);
    project.git(['add', '-A'], info.worktree);
    project.git(['commit', '--quiet', '-m', `Work on ${info.job}`], info.worktree);
    writeFileSync(info.output, 'STATUS: READY\n\n## Evidence\nIt works.\n');
  },
  reviewer(project, info, verdict = 'PASS') {
    writeFileSync(info.output, `VERDICT: ${verdict}\nCOMMIT: ${info.commit}\n\n## Summary\n## Findings\n## Notes\n`);
  },
  approver(project, info, decision = 'APPROVE') {
    writeFileSync(info.output, `DECISION: ${decision}\nCOMMIT: ${info.commit}\n`);
  },
  finisher(project, info, status = 'READY') {
    writeFileSync(info.output, `STATUS: ${status}\nCOMMIT: ${info.commit}\n`);
  },
};

export const agents = defaults;

function defaultAgent(short) {
  if (short === 'builder') return defaults.builder;
  if (short === 'approver') return defaults.approver;
  if (short === 'finisher') return defaults.finisher;
  return defaults.reviewer;
}

// Plays the orchestrator: does exactly what `masna next` says until it pauses or
// finishes. `script[job][agent]` overrides what an agent does, and can return
// 'crash' (never runs), 'no-output' (ends without output) or 'failed' (API failure).
export class Orchestrator {
  constructor(project, script = {}) {
    this.project = project;
    this.script = script;
    this.actions = [];
    this.pendingFailed = [];
    this.run = null;
    this.onStep = null;
  }

  begin(options = []) {
    const started = this.project.begin(options);
    if (started.action === 'started') this.run = started.run;
    return started;
  }

  next() {
    const failed = this.pendingFailed.shift();
    const args = ['next', '--run', this.run];
    if (failed) args.push('--failed', failed);
    const action = this.project.json(args);
    this.actions.push(action);
    this.onStep?.(action);
    return action;
  }

  runAgent(agent) {
    const short = agent.type.replace(/^masna:/, '');
    const info = promptInfo(agent.prompt);
    info.type = agent.type;
    info.prompt = agent.prompt;
    const behaviour = this.script[info.job]?.[short] ?? defaultAgent(short);
    const hook = (kind) => this.project.masna([kind], JSON.stringify({ agent_type: agent.type, cwd: info.worktree }));

    hook('agent-started');
    const outcome = behaviour(this.project, info);
    if (outcome === 'crash') return 'crash';
    if (outcome === 'failed') {
      this.pendingFailed.push(agent.type);
      return 'failed';
    }
    hook('agent-ended');
    return outcome;
  }

  // Returns the first pause or done action, or a 'crash' marker if an agent crashed.
  drive({ maxSteps = 300 } = {}) {
    for (let step = 0; step < maxSteps; step += 1) {
      const action = this.next();
      if (action.action === 'pause' || action.action === 'done') return action;
      if (action.action === 'exec') {
        const result = this.project.masnaRaw(action.command.split(' ').slice(1));
        if (result.status !== 0) throw new Error(`${action.command}: ${result.stderr}`);
      } else if (action.action === 'spawn') {
        const outcomes = action.agents.map((agent) => this.runAgent(agent));
        if (outcomes.includes('crash')) return { action: 'crash', spawned: action };
      } else if (action.action === 'wait') {
        throw new Error(`nothing is running, but next said wait: ${action.report}`);
      } else {
        throw new Error(`unknown action: ${action.action}`);
      }
    }
    throw new Error('the loop didn\'t finish');
  }
}

export const landedOnGroup = (project, branch) => project.remote(['log', branch, '--format=%B'])
  .split('\n')
  .filter((line) => line.startsWith('Masna-'));
