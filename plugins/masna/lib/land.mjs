import { join } from 'node:path';
import { PauseError } from './errors.mjs';
import { readText } from './fsutil.mjs';
import { branchExists, git, gitRemote, mergeInto, switchBranch, tryGit } from './git.mjs';
import { jobDir } from './project.mjs';
import { parseDecision, parseVerdict } from './output.mjs';
import { listGroups } from './state.mjs';

const POSTED_MARKER = '<!-- masna:landed -->';

function trailer(job) {
  return job.kind === 'issue' ? `Masna-Issue: ${job.number}` : `Masna-Job: ${job.id}`;
}

function landedCommit(worktree, branch, job) {
  // Anchored, so `Masna-Issue: 1` can't match `Masna-Issue: 12`, or a title quoting one.
  const found = tryGit(worktree, ['log', branch, '--format=%H', '--extended-regexp', `--grep=^${trailer(job)}$`, '-1']);
  return found.ok && found.stdout ? found.stdout : null;
}

function commitMessage(job) {
  const title = (job.title ?? '').replace(/\s+/g, ' ').trim();
  const subject = job.kind === 'issue' ? `#${job.number}: ${title}` : `Group ${job.group} feedback: ${job.id}`;
  return `${subject}\n\n${trailer(job)}\n`;
}

// Only verdicts, the commit and whether criteria were met. Findings, logs and
// agent text stay in .masna/jobs/, because many repos are public.
function verdictsComment(root, job, commit, branch) {
  const folder = jobDir(root, job.id);
  const lines = [`Landed on \`${branch}\` as ${commit}.`, ''];
  for (const name of job.reviewers ?? []) {
    const verdict = parseVerdict(readText(join(folder, `review-${name}.md`)));
    lines.push(`- ${name}: ${verdict?.verdict ?? 'unknown'}`);
  }
  const decision = parseDecision(readText(join(folder, 'decision.md')));
  lines.push(`- acceptance criteria: ${decision?.decision === 'APPROVE' ? 'met' : 'unknown'}`, '', POSTED_MARKER);
  return `${lines.join('\n')}\n`;
}

function mergeForward(root, ctx, group) {
  const groups = listGroups(root);
  for (const later of groups.filter((g) => g.parent?.kind === 'group' && g.parent.group === group.number)) {
    const worktree = join(root, later.worktree);
    switchBranch(worktree, later.branch);
    if (!mergeInto(worktree, group.branch)) {
      throw new PauseError(`group ${group.number} can't merge forward into group ${later.number}: merge ${group.branch} into ${later.branch} by hand and push, then run again`);
    }
    gitRemote(worktree, ['push', '--quiet', 'origin', later.branch]);
    mergeForward(root, ctx, later);
  }
}

// Each step checks whether it's already done, so a crash anywhere in here is safe.
export function land(ctx, job, group) {
  const { root, gh } = ctx;
  const worktree = join(root, group.worktree);
  switchBranch(worktree, group.branch);

  let commit = landedCommit(worktree, group.branch, job);
  if (!commit) {
    const squash = tryGit(worktree, ['merge', '--squash', job.branch]);
    if (!squash.ok) {
      tryGit(worktree, ['reset', '--hard']);
      return { conflict: true };
    }
    git(worktree, ['commit', '--quiet', '--allow-empty', '-F', '-'], commitMessage(job));
    commit = landedCommit(worktree, group.branch, job);
  }

  gitRemote(worktree, ['push', '--quiet', 'origin', group.branch]);

  if (job.kind === 'issue') {
    const issue = gh.issue(job.number);
    if (!issue.comments.some((comment) => comment.body.includes(POSTED_MARKER))) {
      gh.comment(job.number, verdictsComment(root, job, commit, group.branch));
    }
    if (issue.state !== 'CLOSED') gh.closeIssue(job.number);
  } else {
    mergeForward(root, ctx, group);
    switchBranch(worktree, group.branch);
  }

  if (branchExists(worktree, job.branch)) git(worktree, ['branch', '-q', '-D', job.branch]);
  return { commit };
}
