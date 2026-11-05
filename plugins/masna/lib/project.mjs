import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The main checkout, even when called from inside a worktree.
export function findRoot(cwd = process.cwd()) {
  const commonDir = execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
  return realpathSync(dirname(commonDir));
}

export const masnaDir = (root) => join(root, '.masna');
export const configFile = (root) => join(root, '.masna', 'config.json');
export const runFile = (root) => join(root, '.masna', 'run.json');
export const eventsFile = (root) => join(root, '.masna', 'events.jsonl');
export const queueFile = (root) => join(root, '.masna', 'queue.json');
export const jobsDir = (root) => join(root, '.masna', 'jobs');
export const worktreesDir = (root) => join(root, '.masna', 'worktrees');
export const jobDir = (root, id) => join(jobsDir(root), String(id));
export const groupDirName = (number) => `group-${number}`;
export const groupDir = (root, number) => join(jobsDir(root), groupDirName(number));
