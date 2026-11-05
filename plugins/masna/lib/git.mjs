import { spawnSync } from 'node:child_process';
import { InfraError } from './errors.mjs';

export function tryGit(cwd, args, input) {
  const result = spawnSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

export function git(cwd, args, input) {
  const result = tryGit(cwd, args, input);
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

// Commands that use the network. A failure here pauses the run.
export function gitRemote(cwd, args) {
  const result = tryGit(cwd, args);
  if (!result.ok) throw new InfraError(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}

export const head = (cwd) => git(cwd, ['rev-parse', 'HEAD']);
export const currentBranch = (cwd) => git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
export const branchExists = (cwd, branch) =>
  tryGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
export const isDirty = (cwd) => git(cwd, ['status', '--porcelain']) !== '';
export const isAncestor = (cwd, ancestor, descendant) =>
  tryGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]).ok;

export function commitsAhead(cwd, base, tip = 'HEAD') {
  return Number(git(cwd, ['rev-list', '--count', `${base}..${tip}`]));
}

// Files changed by `tip` since it left `base`. Renames show as a delete and an add,
// so a branch can't hide a change to a protected path by renaming it.
export function changedSince(cwd, base, tip = 'HEAD') {
  const mergeBase = git(cwd, ['merge-base', base, tip]);
  return splitLines(git(cwd, ['diff', '--name-only', '--no-renames', mergeBase, tip]));
}

export function changedBetween(cwd, from, to) {
  const result = tryGit(cwd, ['diff', '--name-only', '--no-renames', from, to]);
  return result.ok ? splitLines(result.stdout) : null;
}

function splitLines(text) {
  return text === '' ? [] : text.split('\n');
}

// Moves a worktree to a branch, creating it if needed. Anything uncommitted goes
// to a stash, so a new job starts clean without destroying what the last one left.
export function switchBranch(cwd, branch, startPoint) {
  if (currentBranch(cwd) === branch) return;
  if (isDirty(cwd)) git(cwd, ['stash', 'push', '--include-untracked', '-m', 'masna: left in worktree']);
  if (branchExists(cwd, branch)) {
    git(cwd, ['checkout', '--quiet', branch]);
  } else {
    git(cwd, ['checkout', '--quiet', '-b', branch, startPoint]);
  }
}

// Returns false, with the merge undone, if there's a conflict.
export function mergeInto(cwd, ref) {
  if (isAncestor(cwd, ref, 'HEAD')) return true;
  if (tryGit(cwd, ['merge', '--no-edit', '--quiet', ref]).ok) return true;
  tryGit(cwd, ['merge', '--abort']);
  return false;
}
