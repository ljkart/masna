import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.mjs';
import { logEvent } from './events.mjs';
import { readJson, writeAtomic } from './fsutil.mjs';
import { changedSince, head, tryGit } from './git.mjs';
import { groupDir, jobDir } from './project.mjs';
import { matchesAny } from './route.mjs';
import { readRun, touchRun } from './run.mjs';
import { loadGroup, loadJob } from './state.mjs';

const SECRETS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

function gateEnvironment() {
  const env = { ...process.env };
  for (const name of SECRETS) delete env[name];
  return env;
}

export function gateIsRunning(folder) {
  const lock = readJson(join(folder, 'gate.lock'));
  if (!lock) return false;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Scripts always come from the base branch, so a branch can't change what judges it.
function scriptFromBase(root, base, name) {
  const shown = tryGit(root, ['show', `origin/${base}:.masna/${name}`]);
  return shown.ok ? shown.stdout : null;
}

function runScript({ script, folder, name, cwd, timeoutMs }) {
  const scriptPath = join(folder, `${name}.script.sh`);
  writeFileSync(scriptPath, `${script}\n`);
  const log = openSync(join(folder, `${name}.log`), 'w');
  return new Promise((resolve) => {
    const child = spawn('bash', [scriptPath], {
      cwd,
      env: gateEnvironment(),
      detached: true,
      stdio: ['ignore', log, log],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      closeSync(log);
      resolve({ code: 1, timedOut: false, error: error.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      closeSync(log);
      resolve({ code: timedOut ? 1 : code ?? 1, timedOut });
    });
  });
}

function writeResult(file, result, commit, reason) {
  writeAtomic(file, `RESULT: ${result}\nCOMMIT: ${commit}\nREASON: ${reason}\n`);
}

function protectedChanges(worktree, groupBranch, config) {
  return changedSince(worktree, groupBranch).filter((file) => matchesAny(config.protected_paths, file));
}

// Runs one of: job setup, job gate, group baseline or group gate. It always records
// a result, so the orchestrator only has to wait for the command to exit.
export async function runGate(root, options) {
  const { job: jobId, group: groupNumber, setup, baseline, run: runId } = options;
  const run = readRun(root);
  if (!run || run.id !== runId) return `run ${runId} isn't the current run`;

  const config = loadConfig(root);
  const job = jobId ? loadJob(root, jobId) : null;
  const group = loadGroup(root, job ? job.group : Number(groupNumber));
  if (!group) throw new Error('no such job or group');

  const folder = job ? jobDir(root, job.id) : groupDir(root, group.number);
  const worktree = join(root, group.worktree);
  const output = join(folder, setup ? 'setup.md' : baseline ? 'baseline.md' : 'checks.md');
  const label = setup ? 'setup' : baseline ? 'baseline' : 'checks';
  const lockFile = join(folder, 'gate.lock');
  mkdirSync(folder, { recursive: true });

  if (gateIsRunning(folder)) return 'already running';
  writeAtomic(lockFile, JSON.stringify({ pid: process.pid }));
  const keepAlive = setInterval(() => touchRun(root), 30_000);

  try {
    const commit = head(worktree);
    const timeoutMs = config.gate_timeout_minutes * 60_000;
    const base = config.base_branch;
    const context = { folder, cwd: worktree, timeoutMs };
    const record = (result, reason) => {
      writeResult(output, result, commit, reason);
      logEvent(root, 'gate', { job: job?.id, group: group.number, kind: label, result, commit, reason });
      return `${label}: ${result}`;
    };

    if (job && !setup && !baseline) {
      const changed = protectedChanges(worktree, group.branch, config);
      if (changed.length) return record('FAIL', `changes protected paths: ${changed.join(', ')}`);
    }

    const setupScript = scriptFromBase(root, base, 'setup.sh');
    if (setupScript !== null) {
      const result = await runScript({ ...context, script: setupScript, name: setup ? 'setup' : `${label}-setup` });
      if (result.timedOut) return record('FAIL', 'setup.sh timed out');
      if (result.code !== 0) return record('FAIL', `setup.sh exited with ${result.code}`);
    }
    if (setup) return record('PASS', 'setup passed');

    const checksScript = scriptFromBase(root, base, 'checks.sh');
    if (checksScript === null) return record('ERROR', `.masna/checks.sh isn't on origin/${base}`);

    const result = await runScript({ ...context, script: checksScript, name: label });
    if (result.timedOut) return record('FAIL', `checks.sh timed out after ${config.gate_timeout_minutes} minutes`);
    if (result.code !== 0) return record('FAIL', `checks.sh exited with ${result.code}`);
    return record('PASS', 'checks passed');
  } finally {
    clearInterval(keepAlive);
    rmSync(lockFile, { force: true });
  }
}
