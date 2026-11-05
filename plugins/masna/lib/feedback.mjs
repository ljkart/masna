import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.mjs';
import { logEvent } from './events.mjs';
import { nowIso } from './fsutil.mjs';
import { GitHub } from './github.mjs';
import { jobDir } from './project.mjs';
import { ACTIVE_STAGES, checkMove, listGroups, listJobs, loadJob, saveJob } from './state.mjs';

const refuse = (message) => ({ ok: false, message });

function saveFeedback(folder, text) {
  mkdirSync(folder, { recursive: true });
  appendFileSync(join(folder, 'feedback.md'), `## Feedback from the operator, ${nowIso()}\n\n${text.trim()}\n\n`);
}

function reopenIssueJob(root, job, text) {
  const verdict = checkMove(job.stage, 'build', { feedback: true });
  if (!verdict.ok) return refuse(verdict.reason);
  const config = loadConfig(root);
  if (job.kind === 'issue') new GitHub(root).removeLabel(job.number, config.needs_human_label);

  const folder = jobDir(root, job.id);
  saveFeedback(folder, text);
  rmSync(join(folder, 'decision.md'), { force: true });
  const build = join(folder, 'build.md');
  if (existsSync(build)) renameSync(build, join(folder, 'build.previous.md'));

  logEvent(root, 'stage', { job: job.id, from: job.stage, to: 'build', feedback: true });
  Object.assign(job, { stage: 'build', round: 1, gate_fixes: 0, agents: {}, reason: null, origin: null });
  saveJob(root, job);
  return { ok: true, message: `#${job.number ?? job.id} goes back to the builder on the next run` };
}

function createGroupJob(root, group, text) {
  if (group.pr) {
    const state = new GitHub(root).pullRequestState(group.pr.number);
    if (state !== 'OPEN') return refuse(`PR #${group.pr.number} is ${state.toLowerCase()}, so it can't take feedback`);
  }

  const taken = listJobs(root).filter((job) => job.kind === 'group-feedback' && job.group === group.number).length;
  const id = `g${group.number}-f${taken + 1}`;
  saveFeedback(jobDir(root, id), text);
  saveJob(root, {
    id,
    kind: 'group-feedback',
    title: null,
    group: group.number,
    branch: `masna/group-fix/${group.number}-${taken + 1}`,
    stage: 'build',
    round: 1,
    gate_fixes: 0,
    agents: {},
    created_at: nowIso(),
  });
  logEvent(root, 'stage', { job: id, from: null, to: 'build', feedback: true });
  const owner = group.pr ? `PR #${group.pr.number}` : `group ${group.number}`;
  return { ok: true, message: `feedback on ${owner} saved as job ${id}, for the next run` };
}

// `target` is an issue number, a group PR number, or a job id such as g1-f1.
export function giveFeedback(root, target, text) {
  if (!text?.trim()) return refuse('no feedback text');
  if (!/^(\d+|g\d+-f\d+)$/.test(target)) return refuse(`"${target}" isn't an issue, PR or job`);
  const groups = listGroups(root);

  const group = groups.find((candidate) => String(candidate.pr?.number) === target);
  if (group) return createGroupJob(root, group, text);

  const job = loadJob(root, target);
  if (!job) return refuse(`no job for #${target}, and it isn't an open group PR`);
  if (job.stage === 'landed') {
    const owner = groups.find((candidate) => candidate.number === job.group);
    if (owner?.pr) return refuse(`#${target} has landed: send feedback on group PR #${owner.pr.number} instead`);
    // The finisher blocked this group, so no PR will come until the problem is fixed.
    if (owner?.state === 'finishing') return createGroupJob(root, owner, text);
    return refuse(`#${target} has landed, and its group has no PR yet: send feedback once it has one`);
  }
  if (ACTIVE_STAGES.includes(job.stage)) return refuse(`#${target} is still being worked on (${job.stage})`);
  if (job.stage !== 'needs-human') return refuse(`#${target} is ${job.stage}`);
  return reopenIssueJob(root, job, text);
}
