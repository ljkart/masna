import { readEvents } from './events.mjs';
import { readJson } from './fsutil.mjs';
import { queueFile } from './project.mjs';
import { classify, orderMilestones } from './queue.mjs';
import { hasMarker } from './agents.mjs';
import { jobDir, groupDir } from './project.mjs';
import { heartbeatIsRecent, lastActivity, readRun } from './run.mjs';
import { ACTIVE_STAGES, listGroups, listJobs } from './state.mjs';

const RECENT_EVENTS = 20;

function runView(root, now) {
  const run = readRun(root);
  if (!run) return { id: null, state: 'idle', reason: null, last_activity: null };
  let state;
  if (run.state === 'paused') state = 'paused';
  else if (run.state === 'done') state = 'idle';
  else state = heartbeatIsRecent(root, now) ? 'running' : 'stalled';
  const last = lastActivity(root);
  return {
    id: run.id,
    state,
    reason: run.reason ?? null,
    last_activity: last === null ? null : new Date(last).toISOString(),
  };
}

function agentViews(root, holder, folder, events) {
  return Object.entries(holder.agents ?? {}).map(([name, record]) => {
    let state = 'running';
    if (hasMarker(folder, name, 'failed')) state = 'failed';
    else if (hasMarker(folder, name, 'ended')) state = 'ended';
    const lastTool = [...events].reverse().find((event) => event.type === 'tool' && event.agent === name);
    return {
      name,
      state,
      attempts: record.attempts,
      spawned_at: record.spawned_at,
      last_tool: lastTool ? { tool: lastTool.tool, at: lastTool.at } : null,
    };
  });
}

function jobView(job) {
  return {
    id: job.id,
    number: job.number ?? null,
    title: job.title ?? null,
    kind: job.kind,
    stage: job.stage,
    round: job.round,
    gate_fixes: job.gate_fixes,
    reason: job.reason ?? null,
    landed_commit: job.landed_commit ?? null,
  };
}

function issueRows(group, milestoneNumber, queue, jobs) {
  const mine = queue.issues.filter((issue) => issue.milestone === milestoneNumber);
  const jobMap = new Map(jobs.filter((job) => job.kind === 'issue').map((job) => [job.number, job]));
  const classified = classify({ issues: mine, jobs: jobMap, external: new Map(queue.external) });
  const rows = classified.map((item) => {
    const issue = mine.find((candidate) => candidate.number === item.number);
    const job = jobMap.get(item.number);
    return {
      number: item.number,
      title: issue.title,
      state: item.state,
      stage: job?.stage ?? null,
      round: job?.round ?? null,
      reason: item.reason ?? null,
      landed_commit: job?.landed_commit ?? null,
    };
  });
  const shown = new Set(rows.map((row) => row.number));
  for (const job of jobMap.values()) {
    if (job.group === milestoneNumber && !shown.has(job.number) && ['landed', 'cancelled'].includes(job.stage)) {
      rows.push({
        number: job.number,
        title: job.title,
        state: job.stage,
        stage: job.stage,
        round: job.round,
        reason: null,
        landed_commit: job.landed_commit ?? null,
      });
    }
  }
  return rows.sort((a, b) => a.number - b.number);
}

// One function turns the files into the view. `masna status` prints it and
// `masna status --json` returns it, so they can't disagree.
export function buildView(root, now = Date.now()) {
  const queue = readJson(queueFile(root)) ?? { milestones: [], issues: [], external: [] };
  const jobs = listJobs(root);
  const records = listGroups(root);
  const events = readEvents(root);

  const numbers = new Set(orderMilestones(queue.milestones).map((milestone) => milestone.number));
  for (const record of records) numbers.add(record.number);

  const groups = [...numbers]
    .map((number) => {
      const milestone = queue.milestones.find((candidate) => candidate.number === number);
      const record = records.find((candidate) => candidate.number === number);
      const issues = issueRows(record, number, queue, jobs);
      return {
        number,
        title: record?.title ?? milestone?.title ?? null,
        state: record?.state ?? 'not started',
        branch: record?.branch ?? null,
        pr: record?.pr ?? null,
        landed: issues.filter((issue) => issue.state === 'landed').length,
        total: issues.length,
        issues,
        feedback_jobs: jobs.filter((job) => job.kind === 'group-feedback' && job.group === number).map(jobView),
      };
    })
    .filter((group) => group.total > 0 || group.state !== 'not started');

  const activeJob = jobs.find((job) => ACTIVE_STAGES.includes(job.stage) && (job.stage !== 'build' || job.agents.builder))
    ?? jobs.find((job) => ACTIVE_STAGES.includes(job.stage));
  const finishing = records.find((record) => record.state === 'finishing');
  let current = null;
  if (activeJob) {
    current = { ...jobView(activeJob), agents: agentViews(root, activeJob, jobDir(root, activeJob.id), events) };
  } else if (finishing) {
    current = {
      id: `group-${finishing.number}`,
      kind: 'group',
      stage: 'finishing',
      agents: agentViews(root, finishing, groupDir(root, finishing.number), events),
    };
  }

  return {
    run: runView(root, now),
    queue_updated_at: queue.updated_at ?? null,
    groups,
    current,
    events: events.filter((event) => event.type !== 'tool').slice(-RECENT_EVENTS),
  };
}

export function renderStatus(view) {
  const lines = [`run ${view.run.id ?? '-'}: ${view.run.state}${view.run.reason ? ` (${view.run.reason})` : ''}`];
  if (view.current) {
    lines.push(`working on ${view.current.number ? `#${view.current.number}` : view.current.id}: ${view.current.stage}`);
  }
  for (const group of view.groups) {
    const pr = group.pr ? `, PR #${group.pr.number}${group.pr.partial ? ' (partial)' : ''}` : '';
    lines.push('', `group ${group.number}: ${group.landed} of ${group.total} landed, ${group.state}${pr}`);
    for (const issue of group.issues) {
      const detail = issue.reason ? `: ${issue.reason}` : issue.stage && issue.state === 'active' ? ` (${issue.stage})` : '';
      lines.push(`  #${issue.number} ${issue.state}${detail}`);
    }
    for (const job of group.feedback_jobs) {
      lines.push(`  ${job.id} ${job.stage}${job.reason ? `: ${job.reason}` : ''}`);
    }
  }
  if (view.groups.length === 0) lines.push('', 'nothing queued yet');
  return lines.join('\n');
}
