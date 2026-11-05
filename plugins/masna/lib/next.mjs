import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideAgent, writeMarker } from './agents.mjs';
import { loadConfig, reviewerAgent } from './config.mjs';
import { InfraError, PauseError } from './errors.mjs';
import { logEvent } from './events.mjs';
import { nowIso, readText, writeJson } from './fsutil.mjs';
import { gateIsRunning } from './gate.mjs';
import {
  changedBetween,
  changedSince,
  commitsAhead,
  git,
  gitRemote,
  head,
  isDirty,
  mergeInto,
  branchExists,
  switchBranch,
} from './git.mjs';
import { GitHub } from './github.mjs';
import { land } from './land.mjs';
import { commitMatches, parseBuild, parseChecks, parseDecision, parseGroup, parseVerdict } from './output.mjs';
import { startPreview, stopPreview } from './preview.mjs';
import { groupDir, jobDir, queueFile, worktreesDir } from './project.mjs';
import {
  classify,
  editedAfterLabel,
  orderMilestones,
  parseIssue,
  renderIssueData,
  trustedComments,
} from './queue.mjs';
import { passStillHolds, route } from './route.mjs';
import { readRun, saveRun, touchRun } from './run.mjs';
import { ACTIVE_STAGES, checkMove, listGroups, listJobs, loadGroup, saveGroup, saveJob } from './state.mjs';

const MAX_STEPS = 200;
const MAX_EXECS_PER_RUN = 3;
const SKIP_GROUP = Symbol('skip group');

const jobLabel = (job) => (job.kind === 'issue' ? `#${job.number}` : job.id);
const slugify = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'group';

// ---- Context: what one `masna next` call shares ----------------------------

function createContext(root, run, config) {
  const ctx = {
    root,
    run,
    config,
    gh: new GitHub(root),
    active: run.active,
    cachedQueue: null,
    jobs: () => listJobs(root),
    invalidateQueue() {
      ctx.cachedQueue = null;
    },
    queue() {
      if (!ctx.cachedQueue) ctx.cachedQueue = fetchQueue(ctx);
      return ctx.cachedQueue;
    },
  };
  return ctx;
}

function fetchQueue(ctx) {
  const { gh, config, root } = ctx;
  const milestones = gh.milestones();
  const issues = gh.queuedIssues(config.queue_label).filter((issue) => issue.milestone !== null);
  const known = new Set(issues.map((issue) => issue.number));
  const landed = new Set(ctx.jobs().filter((job) => job.stage === 'landed' && job.kind === 'issue').map((job) => job.number));

  const external = new Map();
  for (const issue of issues) {
    const parsed = parseIssue(issue.body);
    for (const blocker of parsed.ok ? parsed.blockedBy : []) {
      if (known.has(blocker) || external.has(blocker)) continue;
      if (landed.has(blocker)) external.set(blocker, { landed: true, state: 'CLOSED', stateReason: 'COMPLETED' });
      else {
        const { state, stateReason } = gh.issue(blocker);
        external.set(blocker, { state, stateReason });
      }
    }
  }
  writeJson(queueFile(root), {
    updated_at: nowIso(),
    milestones,
    issues,
    external: [...external.entries()],
  });
  return { milestones, issues, external };
}

// ---- Actions ---------------------------------------------------------------

const pause = (reason) => ({ action: 'pause', reason, report: `paused: ${reason}` });
const waiting = (report) => ({ action: 'wait', report });

function moveJob(ctx, job, to, evidence = {}) {
  const verdict = checkMove(job.stage, to, evidence);
  if (!verdict.ok) throw new Error(`#${job.id}: move refused: ${verdict.reason}`);
  logEvent(ctx.root, 'stage', { run: ctx.run.id, job: job.id, from: job.stage, to });
  job.stage = to;
  // A stage move means an agent's work was accepted, so this isn't an outage.
  ctx.run.failures = 0;
  saveJob(ctx.root, job);
}

function markStuck(ctx, job, reason) {
  if (job.kind === 'issue') ctx.gh.addLabel(job.number, ctx.config.needs_human_label);
  stopPreview(job.preview);
  job.preview = null;
  job.reason = reason;
  logEvent(ctx.root, 'stage', { run: ctx.run.id, job: job.id, from: job.stage, to: 'needs-human', reason });
  job.stage = 'needs-human';
  saveJob(ctx.root, job);
  ctx.invalidateQueue();
}

function isCancelled(ctx, job) {
  if (job.kind !== 'issue') return false;
  const issue = ctx.gh.issue(job.number);
  return issue.state === 'CLOSED' || !issue.labels.includes(ctx.config.queue_label);
}

function cancel(ctx, job) {
  stopPreview(job.preview);
  job.preview = null;
  moveJob(ctx, job, 'cancelled');
  ctx.invalidateQueue();
}

function archiveBuild(root, job) {
  const folder = jobDir(root, job.id);
  const file = join(folder, 'build.md');
  if (existsSync(file)) renameSync(file, join(folder, 'build.previous.md'));
}

function agentEntry(ctx, type, modelKey, prompt) {
  const model = ctx.config.models[modelKey];
  return model ? { type, model, prompt } : { type, prompt };
}

// Prompts carry only paths and numbers, never issue text.
function basePrompt(ctx, job, group, extra) {
  const folder = jobDir(ctx.root, job.id);
  const worktree = join(ctx.root, group.worktree);
  return `Job: ${job.id}. Job folder: ${folder}. Worktree: ${worktree}. Round: ${job.round}. ${extra}`;
}

// Runs a script through the orchestrator as background Bash, or returns its result.
function gateStep(ctx, holder, { name, folder, file, commit, retryOn, command, report }) {
  const result = parseChecks(readText(file));
  const fresh = result && (commit === null || commitMatches(result.commit, commit));
  const staleRun = holder.gate_runs?.[name] !== ctx.run.id;
  if (fresh && !(retryOn.includes(result.result) && staleRun)) return { result };
  if (gateIsRunning(folder)) return { action: waiting(report) };

  holder.execs ??= {};
  const record = holder.execs[name];
  const count = record?.run === ctx.run.id ? record.count + 1 : 1;
  if (count > MAX_EXECS_PER_RUN) {
    throw new PauseError(`${name} was started ${MAX_EXECS_PER_RUN} times without a result: check the orchestrator can run masna`);
  }
  holder.execs[name] = { run: ctx.run.id, count };
  holder.gate_runs = { ...holder.gate_runs, [name]: ctx.run.id };
  return { action: { action: 'exec', command, report } };
}

// ---- Stages ----------------------------------------------------------------

async function advanceBuild(ctx, job, group) {
  const { root, run, config } = ctx;
  const folder = jobDir(root, job.id);
  const worktree = join(root, group.worktree);
  switchBranch(worktree, job.branch, group.branch);

  const setup = gateStep(ctx, job, {
    name: 'setup',
    folder,
    file: join(folder, 'setup.md'),
    commit: null,
    retryOn: ['FAIL', 'ERROR'],
    command: `masna gate --job ${job.id} --setup --run ${run.id}`,
    report: `${jobLabel(job)}: preparing the worktree`,
  });
  if (setup.action) {
    saveJob(root, job);
    ctx.active = job.id;
    return setup.action;
  }
  if (setup.result.result !== 'PASS') {
    saveJob(root, job);
    throw new PauseError(`${jobLabel(job)}: setup failed on a clean tree: ${setup.result.reason}`);
  }

  const build = parseBuild(readText(join(folder, 'build.md')));
  if (build?.status === 'BLOCKED') {
    markStuck(ctx, job, 'the builder says it\'s blocked');
    return null;
  }
  const clean = !isDirty(worktree);
  const ahead = commitsAhead(worktree, group.branch) > 0;
  if (build?.status === 'READY' && clean && ahead) {
    moveJob(ctx, job, 'gate', { buildReady: true, clean, commitsAhead: ahead });
    return null;
  }

  const decision = decideAgent({
    holder: job,
    folder,
    short: 'builder',
    key: `round-${job.round}-fix-${job.gate_fixes}`,
    run,
    timeoutMinutes: config.agent_timeout_minutes,
  });
  saveJob(root, job);
  ctx.active = job.id;

  if (decision.pause) throw new PauseError(decision.pause);
  if (decision.stuck) {
    markStuck(ctx, job, decision.stuck);
    return null;
  }
  if (decision.wait) return waiting(`${jobLabel(job)}: building`);

  if (isCancelled(ctx, job)) {
    cancel(ctx, job);
    return null;
  }
  // A job reopened by feedback may be behind work that landed since.
  if (!mergeInto(worktree, group.branch)) {
    markStuck(ctx, job, `conflict merging ${group.branch} into ${job.branch}`);
    return null;
  }
  const issueFile = job.kind === 'issue' ? join(folder, 'issue.md') : join(folder, 'feedback.md');
  return {
    action: 'spawn',
    agents: [agentEntry(ctx, 'masna:builder', 'builder', basePrompt(
      ctx,
      job,
      group,
      `Work file: ${issueFile}. Output: ${join(folder, 'build.md')}.`,
    ))],
    report: `${jobLabel(job)}: building, round ${job.round}`,
  };
}

function advanceGate(ctx, job, group) {
  const { root, run, config } = ctx;
  const folder = jobDir(root, job.id);
  const worktree = join(root, group.worktree);
  switchBranch(worktree, job.branch, group.branch);
  const commit = head(worktree);

  const step = gateStep(ctx, job, {
    name: `gate-${commit}`,
    folder,
    file: join(folder, 'checks.md'),
    commit,
    retryOn: ['ERROR'],
    command: `masna gate --job ${job.id} --run ${run.id}`,
    report: `${jobLabel(job)}: running checks`,
  });
  if (step.action) {
    saveJob(root, job);
    ctx.active = job.id;
    return step.action;
  }

  const { result, reason } = step.result;
  if (result === 'ERROR') throw new PauseError(`${jobLabel(job)}: ${reason}`);
  if (result === 'PASS') {
    moveJob(ctx, job, 'review', { checks: 'PASS' });
    return null;
  }
  if (job.gate_fixes >= config.max_gate_fixes) {
    markStuck(ctx, job, `checks still failing after ${config.max_gate_fixes} fixes: ${reason}`);
    return null;
  }
  moveJob(ctx, job, 'build', { checks: 'FAIL', gateFixes: job.gate_fixes, maxGateFixes: config.max_gate_fixes });
  job.gate_fixes += 1;
  archiveBuild(root, job);
  saveJob(root, job);
  return null;
}

function reviewerStatus(ctx, job, name, commit, worktree) {
  const agent = reviewerAgent(name);
  const verdict = parseVerdict(readText(join(jobDir(ctx.root, job.id), agent.file)));
  if (!verdict) return { pending: true, agent };
  if (commitMatches(verdict.commit, commit)) return { verdict: verdict.verdict, agent };
  if (verdict.verdict === 'PASS') {
    const changed = changedBetween(worktree, verdict.commit, commit);
    if (changed && passStillHolds(name, changed, ctx.config.reviewers)) return { verdict: 'PASS', held: true, agent };
  }
  return { pending: true, agent };
}

async function advanceReview(ctx, job, group) {
  const { root, run, config } = ctx;
  const folder = jobDir(root, job.id);
  const worktree = join(root, group.worktree);
  switchBranch(worktree, job.branch, group.branch);
  const commit = head(worktree);

  const required = route(changedSince(worktree, group.branch), config.reviewers);
  const statuses = required.map((name) => ({ name, ...reviewerStatus(ctx, job, name, commit, worktree) }));
  const pending = statuses.filter((status) => status.pending);

  if (pending.length === 0) {
    job.reviewers = required;
    const anyChanges = statuses.some((status) => status.verdict === 'CHANGES');
    if (!anyChanges) {
      stopPreview(job.preview);
      job.preview = null;
      moveJob(ctx, job, 'approve', { allPass: true });
      return null;
    }
    if (job.round >= config.max_rounds) {
      markStuck(ctx, job, `reviewers still want changes after ${config.max_rounds} rounds`);
      return null;
    }
    stopPreview(job.preview);
    job.preview = null;
    moveJob(ctx, job, 'build', { allVerdicts: true, anyChanges, round: job.round, maxRounds: config.max_rounds });
    job.round += 1;
    job.gate_fixes = 0;
    archiveBuild(root, job);
    saveJob(root, job);
    return null;
  }

  const decisions = pending.map((status) => ({
    status,
    decision: decideAgent({
      holder: job,
      folder,
      short: status.agent.short,
      key: commit,
      run,
      timeoutMinutes: config.agent_timeout_minutes,
    }),
  }));
  saveJob(root, job);
  ctx.active = job.id;

  const stuck = decisions.find(({ decision }) => decision.stuck);
  if (stuck) {
    markStuck(ctx, job, stuck.decision.stuck);
    return null;
  }
  const paused = decisions.find(({ decision }) => decision.pause);
  if (paused) throw new PauseError(paused.decision.pause);

  const toStart = decisions.filter(({ decision }) => decision.spawn).map(({ status }) => status);
  if (toStart.length === 0) return waiting(`${jobLabel(job)}: reviewing`);

  const wantsScreens = toStart.some(({ name }) => ['ui', 'ux'].includes(name));
  if (wantsScreens && job.preview?.key !== commit) {
    stopPreview(job.preview);
    const preview = await startPreview({ root, base: config.base_branch, worktree, folder });
    job.preview = { ...preview, key: commit };
    saveJob(root, job);
  }

  return {
    action: 'spawn',
    agents: toStart.map(({ name, agent }) => {
      const screens = ['ui', 'ux'].includes(name) ? ` Preview: ${job.preview?.url ?? 'none'}.` : '';
      return agentEntry(ctx, agent.type, name, basePrompt(
        ctx,
        job,
        group,
        `Commit: ${commit}. Base: ${group.branch}. Output: ${join(folder, agent.file)}.${screens}`,
      ));
    }),
    report: `${jobLabel(job)}: reviewing (${toStart.map(({ name }) => name).join(', ')})`,
  };
}

function advanceApprove(ctx, job, group) {
  const { root, run, config } = ctx;
  const folder = jobDir(root, job.id);
  const worktree = join(root, group.worktree);
  switchBranch(worktree, job.branch, group.branch);
  const commit = head(worktree);

  const decision = parseDecision(readText(join(folder, 'decision.md')));
  if (decision && commitMatches(decision.commit, commit)) {
    if (decision.decision !== 'APPROVE') {
      markStuck(ctx, job, decision.decision === 'REJECT'
        ? 'the approver says the criteria aren\'t met'
        : 'the approver says a person needs to decide');
      return null;
    }
    if (isCancelled(ctx, job)) {
      cancel(ctx, job);
      return null;
    }
    moveJob(ctx, job, 'landing', { decision: 'APPROVE' });
    return null;
  }

  const agent = decideAgent({
    holder: job,
    folder,
    short: 'approver',
    key: commit,
    run,
    timeoutMinutes: config.agent_timeout_minutes,
  });
  saveJob(root, job);
  ctx.active = job.id;
  if (agent.pause) throw new PauseError(agent.pause);
  if (agent.stuck) {
    markStuck(ctx, job, agent.stuck);
    return null;
  }
  if (agent.wait) return waiting(`${jobLabel(job)}: approving`);
  return {
    action: 'spawn',
    agents: [agentEntry(ctx, 'masna:approver', 'approver', basePrompt(
      ctx,
      job,
      group,
      `Commit: ${commit}. Base: ${group.branch}. Output: ${join(folder, 'decision.md')}.`,
    ))],
    report: `${jobLabel(job)}: approving`,
  };
}

function advanceLanding(ctx, job, group) {
  const result = land(ctx, job, group);
  if (result.conflict) {
    markStuck(ctx, job, `conflict squashing into ${group.branch}`);
    return null;
  }
  job.landed_commit = result.commit;
  moveJob(ctx, job, 'landed', { trailerOnRemote: true, issueClosed: true, verdictsPosted: true });
  ctx.invalidateQueue();
  return null;
}

function advanceJob(ctx, job) {
  const group = loadGroup(ctx.root, job.group);
  ensureWorktree(ctx, group);
  switch (job.stage) {
    case 'build': return advanceBuild(ctx, job, group);
    case 'gate': return advanceGate(ctx, job, group);
    case 'review': return advanceReview(ctx, job, group);
    case 'approve': return advanceApprove(ctx, job, group);
    case 'landing': return advanceLanding(ctx, job, group);
    default: throw new Error(`job ${job.id} is in ${job.stage}`);
  }
}

// Work already under way goes first, so builds stay one at a time.
function pickJob(ctx) {
  const active = ctx.jobs().filter((job) => ACTIVE_STAGES.includes(job.stage));
  const started = active.filter((job) => job.stage !== 'build' || job.agents.builder);
  const pool = started.length ? started : active;
  return pool.sort((a, b) => a.created_at.localeCompare(b.created_at))[0] ?? null;
}

// ---- Groups ----------------------------------------------------------------

function stackParent(ctx) {
  const open = listGroups(ctx.root)
    .filter((group) => group.pr)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  for (const group of open) {
    if (ctx.gh.pullRequestState(group.pr.number) === 'OPEN') {
      return { kind: 'group', group: group.number, branch: group.branch };
    }
  }
  return { kind: 'base' };
}

const parentRef = (ctx, group) => (group.parent.kind === 'group' ? group.parent.branch : `origin/${ctx.config.base_branch}`);
const prBase = (ctx, group) => (group.parent.kind === 'group' ? group.parent.branch : ctx.config.base_branch);

function createGroup(ctx, milestone) {
  const slug = slugify(milestone.title);
  const group = {
    number: milestone.number,
    title: milestone.title,
    branch: `masna/group/${milestone.number}-${slug}`,
    worktree: `.masna/worktrees/${milestone.number}-${slug}`,
    parent: stackParent(ctx),
    state: 'baseline',
    agents: {},
    created_at: nowIso(),
  };
  saveGroup(ctx.root, group);
  logEvent(ctx.root, 'group', { run: ctx.run.id, group: group.number, state: group.state });
  return group;
}

function ensureWorktree(ctx, group) {
  const worktree = join(ctx.root, group.worktree);
  if (existsSync(join(worktree, '.git'))) return worktree;
  mkdirSync(worktreesDir(ctx.root), { recursive: true });
  git(ctx.root, ['worktree', 'prune']);
  if (branchExists(ctx.root, group.branch)) {
    git(ctx.root, ['worktree', 'add', '--quiet', worktree, group.branch]);
  } else {
    git(ctx.root, ['worktree', 'add', '--quiet', '-b', group.branch, worktree, parentRef(ctx, group)]);
  }
  return worktree;
}

// Once the group below has merged, this group builds on the base branch instead.
function syncStacked(ctx, group) {
  if (group.parent.kind !== 'group') return;
  const parent = loadGroup(ctx.root, group.parent.group);
  if (!parent?.pr || ctx.gh.pullRequestState(parent.pr.number) !== 'MERGED') return;

  const worktree = join(ctx.root, group.worktree);
  switchBranch(worktree, group.branch);
  if (!mergeInto(worktree, `origin/${ctx.config.base_branch}`)) {
    throw new PauseError(`group ${group.number} conflicts with ${ctx.config.base_branch}: merge it into ${group.branch} by hand and push, then run again`);
  }
  gitRemote(worktree, ['push', '--quiet', 'origin', group.branch]);
  group.parent = { kind: 'base' };
  if (group.pr) ctx.gh.editPullRequest(group.pr.number, { base: ctx.config.base_branch });
  saveGroup(ctx.root, group);
}

function issueJobs(ctx, groupNumber) {
  return ctx.jobs().filter((job) => job.kind === 'issue' && job.group === groupNumber);
}

function newJob(group, issue, stage, extra = {}) {
  return {
    id: String(issue.number),
    kind: 'issue',
    number: issue.number,
    title: issue.title,
    group: group.number,
    branch: `masna/issue/${issue.number}`,
    stage,
    round: 1,
    gate_fixes: 0,
    agents: {},
    created_at: nowIso(),
    ...extra,
  };
}

function stopAtQueue(ctx, group, issue, reason) {
  const job = newJob(group, issue, 'needs-human', { origin: 'queue', reason });
  ctx.gh.addLabel(issue.number, ctx.config.needs_human_label);
  saveJob(ctx.root, job);
  logEvent(ctx.root, 'stage', { run: ctx.run.id, job: job.id, from: null, to: 'needs-human', reason });
  ctx.invalidateQueue();
}

// The person who labelled an issue reviewed its text then, so later edits by
// someone without write access mean it has to be reviewed and labelled again.
function startJob(ctx, group, issue) {
  const { gh, config, root } = ctx;
  const meta = gh.labelEvents(issue.number, config.queue_label);
  const edited = meta.edits.some((edit) => editedAfterLabel({
    lastEditedAt: edit.at,
    labeledAt: meta.labeledAt,
    editorHasWrite: gh.hasWriteAccess(edit.by),
  }));
  const previous = ctx.jobs().find((job) => job.kind === 'issue' && job.number === issue.number);
  if (edited) {
    if (previous?.stage !== 'needs-human') {
      stopAtQueue(ctx, group, issue, 'edited after it was labelled: read it and label it again');
    }
    return false;
  }
  if (previous?.stage === 'needs-human') gh.removeLabel(issue.number, config.needs_human_label);
  rmSync(jobDir(root, issue.number), { recursive: true, force: true });

  const comments = trustedComments({
    comments: issue.comments,
    issueAuthor: issue.author,
    labeledAt: meta.labeledAt,
    hasWrite: (login) => gh.hasWriteAccess(login),
  });
  const folder = jobDir(root, issue.number);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'issue.md'), renderIssueData({ issue, comments }));
  const job = newJob(group, issue, 'build');
  saveJob(root, job);
  logEvent(root, 'stage', { run: ctx.run.id, job: job.id, from: null, to: 'build' });
  ctx.invalidateQueue();
  return true;
}

function pullRequestText(group, landed, unresolved) {
  const partial = unresolved.length > 0;
  const lines = [
    `Reviewed by Masna, one issue at a time. Findings are kept with the project, not here.`,
    '',
    '**Landed:**',
    ...landed.map((job) => `- #${job.number} (${job.landed_commit})`),
  ];
  if (partial) {
    lines.push('', '**Not included:**', ...unresolved.map((item) => `- #${item.number}: ${item.state}`));
  }
  return {
    title: `${partial ? '[partial] ' : ''}${group.title}`,
    body: `${lines.join('\n')}\n`,
  };
}

function openOrUpdatePullRequest(ctx, group, landed, unresolved) {
  const { gh } = ctx;
  const text = pullRequestText(group, landed, unresolved);
  const worktree = join(ctx.root, group.worktree);
  gitRemote(worktree, ['push', '--quiet', 'origin', group.branch]);

  const existing = gh.pullRequestForBranch(group.branch);
  let pr;
  if (existing?.state === 'OPEN') {
    gh.editPullRequest(existing.number, text);
    pr = { number: existing.number, url: existing.url };
  } else {
    pr = gh.createPullRequest({ base: prBase(ctx, group), head: group.branch, ...text });
  }
  group.pr = { ...pr, partial: unresolved.length > 0 };
  group.pr_landed = landed.length;
  group.state = 'open';
  saveGroup(ctx.root, group);
  logEvent(ctx.root, 'group', { run: ctx.run.id, group: group.number, state: 'open', pr: pr.number });
  return pr;
}

function finishGroup(ctx, group, landed, unresolved) {
  const { root, run, config } = ctx;
  const folder = groupDir(root, group.number);
  const worktree = join(root, group.worktree);
  group.state = 'finishing';
  switchBranch(worktree, group.branch);
  ctx.active = `group-${group.number}`;

  if (!mergeInto(worktree, parentRef(ctx, group))) {
    saveGroup(root, group);
    throw new PauseError(`group ${group.number} conflicts with ${parentRef(ctx, group)}: merge it into ${group.branch} by hand and push, then run again`);
  }
  const commit = head(worktree);

  const step = gateStep(ctx, group, {
    name: `gate-${commit}`,
    folder,
    file: join(folder, 'checks.md'),
    commit,
    retryOn: ['FAIL', 'ERROR'],
    command: `masna gate --group ${group.number} --run ${run.id}`,
    report: `group ${group.number}: running checks`,
  });
  saveGroup(root, group);
  if (step.action) return step.action;
  if (step.result.result !== 'PASS') {
    throw new PauseError(`group ${group.number}: checks failed on the whole group: ${step.result.reason}`);
  }

  const finished = parseGroup(readText(join(folder, 'group.md')));
  if (!finished || !commitMatches(finished.commit, commit)) {
    const agent = decideAgent({
      holder: group,
      folder,
      short: 'finisher',
      key: commit,
      run,
      timeoutMinutes: config.agent_timeout_minutes,
    });
    saveGroup(root, group);
    if (agent.pause) throw new PauseError(agent.pause);
    if (agent.stuck) throw new PauseError(`group ${group.number}: ${agent.stuck}`);
    if (agent.wait) return waiting(`group ${group.number}: finishing`);
    return {
      action: 'spawn',
      agents: [agentEntry(ctx, 'masna:finisher', 'finisher', `Group: ${group.number}. Job folder: ${folder}. Worktree: ${worktree}. Commit: ${commit}. Base: ${parentRef(ctx, group)}. Output: ${join(folder, 'group.md')}.`)],
      report: `group ${group.number}: finishing`,
    };
  }
  if (finished.status !== 'READY') {
    throw new PauseError(`group ${group.number}: the finisher says it isn't ready: see its group.md`);
  }

  const pr = openOrUpdatePullRequest(ctx, group, landed, unresolved);
  ctx.run.failures = 0;
  if (unresolved.length || config.pause_after_group) {
    group.pause_run = run.id;
    group.pause_reason = unresolved.length
      ? `group ${group.number}: PR #${pr.number} is partial. Not included: ${unresolved.map((item) => `#${item.number}`).join(', ')}`
      : `group ${group.number}: PR #${pr.number} is ready for review`;
    saveGroup(root, group);
    return pause(group.pause_reason);
  }
  return null;
}

async function advanceGroup(ctx, milestone, existing, issues, external) {
  const { root, run, config } = ctx;
  const group = existing ?? createGroup(ctx, milestone);
  const folder = groupDir(root, group.number);
  ensureWorktree(ctx, group);
  ctx.active = `group-${group.number}`;

  if (group.state === 'baseline') {
    const step = gateStep(ctx, group, {
      name: 'baseline',
      folder,
      file: join(folder, 'baseline.md'),
      commit: null,
      retryOn: ['FAIL', 'ERROR'],
      command: `masna gate --group ${group.number} --baseline --run ${run.id}`,
      report: `group ${group.number}: checking the starting point`,
    });
    saveGroup(root, group);
    if (step.action) return step.action;
    if (step.result.result !== 'PASS') {
      throw new PauseError(`group ${group.number}: the checks already fail before any work: ${step.result.reason}. Fix them on ${config.base_branch}, then run again`);
    }
    group.state = 'active';
    saveGroup(root, group);
    logEvent(root, 'group', { run: run.id, group: group.number, state: 'active' });
  }

  if (group.state !== 'open') syncStacked(ctx, group);

  const jobs = new Map(ctx.jobs().filter((job) => job.kind === 'issue').map((job) => [job.number, job]));
  const classified = classify({ issues, jobs, external });

  for (const item of classified.filter((candidate) => candidate.state === 'needs-human')) {
    const job = jobs.get(item.number);
    if (job?.stage !== 'needs-human') {
      stopAtQueue(ctx, group, issues.find((issue) => issue.number === item.number), item.reason);
    }
  }
  for (const item of classified.filter((candidate) => candidate.state === 'runnable')) {
    if (startJob(ctx, group, issues.find((issue) => issue.number === item.number))) {
      if (group.state === 'open') {
        group.state = 'active';
        saveGroup(root, group);
      }
      return null;
    }
  }

  const fresh = classify({ issues, jobs: new Map(ctx.jobs().filter((job) => job.kind === 'issue').map((job) => [job.number, job])), external });
  const unresolved = fresh.filter((item) => ['stuck', 'needs-human', 'skipped', 'waiting', 'runnable'].includes(item.state));
  const landed = issueJobs(ctx, group.number)
    .filter((job) => job.stage === 'landed')
    .sort((a, b) => a.number - b.number);

  if (group.state === 'open' && landed.length === (group.pr_landed ?? 0)) {
    if (unresolved.length) {
      return pause(`group ${group.number} still has issues to deal with: ${unresolved.map((item) => `#${item.number}`).join(', ')}. Use /masna:feedback, or remove them from the queue`);
    }
    return SKIP_GROUP;
  }

  if (landed.length === 0) {
    if (unresolved.length) {
      return pause(`group ${group.number}: nothing landed. Stuck or skipped: ${unresolved.map((item) => `#${item.number}`).join(', ')}`);
    }
    group.state = 'open';
    group.pr_landed = 0;
    saveGroup(root, group);
    return SKIP_GROUP;
  }

  return finishGroup(ctx, group, landed, unresolved);
}

async function advanceGroups(ctx) {
  // An open PR stacked on a group that has since merged must move to the base
  // branch, or merging it would only land the work in the old group's branch.
  for (const group of listGroups(ctx.root).filter((candidate) => candidate.state === 'open')) {
    syncStacked(ctx, group);
  }
  const { milestones, issues, external } = ctx.queue();
  for (const milestone of orderMilestones(milestones)) {
    const group = loadGroup(ctx.root, milestone.number);
    const mine = issues.filter((issue) => issue.milestone === milestone.number);
    if (!group && mine.length === 0) continue;

    if (group?.state === 'open' && mine.length === 0) {
      const landedCount = issueJobs(ctx, group.number).filter((job) => job.stage === 'landed').length;
      if (landedCount === (group.pr_landed ?? 0)) {
        if (group.pause_run === ctx.run.id) return pause(group.pause_reason);
        continue;
      }
    }

    const result = await advanceGroup(ctx, milestone, group, mine, external);
    if (result === SKIP_GROUP) {
      if (group?.pause_run === ctx.run.id && group.pause_reason) return pause(group.pause_reason);
      continue;
    }
    return result;
  }
  return { action: 'done', report: 'the queue is empty' };
}

// ---- The entry point -------------------------------------------------------

function recordFailedAgent(root, run, type) {
  if (!run.active || !type) return;
  const short = type.startsWith('masna:') ? type.slice('masna:'.length) : type;
  writeMarker(join(root, '.masna', 'jobs', run.active), short, 'failed');
  logEvent(root, 'agent', { run: run.id, job: run.active, agent: short, state: 'failed' });
}

function finish(ctx, action) {
  const { root, run } = ctx;
  run.active = ctx.active;
  run.state = { pause: 'paused', done: 'done' }[action.action] ?? 'running';
  run.reason = action.action === 'pause' ? action.reason : null;
  saveRun(root, run);
  if (action.action === 'spawn') {
    for (const agent of action.agents) {
      logEvent(root, 'agent', { run: run.id, job: run.active, agent: agent.type.replace(/^masna:/, ''), state: 'spawned' });
    }
  }
  if (action.action === 'pause' || action.action === 'done') {
    logEvent(root, 'run', { run: run.id, state: run.state, reason: run.reason });
  }
  return { run: run.id, ...action };
}

export async function next(root, { run: runId, failed }) {
  const run = readRun(root);
  if (!run || run.id !== runId) {
    return {
      action: 'pause',
      run: runId,
      reason: `run ${runId} isn't the current run`,
      report: `stopped: run ${runId} isn't the current run`,
    };
  }
  touchRun(root);
  recordFailedAgent(root, run, failed);

  let ctx = null;
  try {
    gitRemote(root, ['fetch', '--quiet', 'origin']);
    ctx = createContext(root, run, loadConfig(root));
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const job = pickJob(ctx);
      const action = job ? await advanceJob(ctx, job) : await advanceGroups(ctx);
      if (action) return finish(ctx, action);
    }
    throw new PauseError(`stopped after ${MAX_STEPS} steps without an action`);
  } catch (error) {
    ctx ??= { root, run, active: run.active };
    const known = error instanceof PauseError;
    if (!known) logEvent(root, 'error', { run: run.id, message: error.message });
    const reason = error instanceof InfraError
      ? `GitHub or the network failed: ${error.message}`
      : error.message;
    return finish(ctx, pause(reason));
  }
}
