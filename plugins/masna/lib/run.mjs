import { existsSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { logEvent } from './events.mjs';
import { nowIso, readJson, writeJson } from './fsutil.mjs';
import { eventsFile, masnaDir, runFile } from './project.mjs';

const HEARTBEAT_MINUTES = 15;
const EVENT_LOGS_KEPT = 3;

export const readRun = (root) => readJson(runFile(root));
export const saveRun = (root, run) => writeJson(runFile(root), run);

// The file's modified time is the heartbeat, so hooks can refresh it without
// rewriting the file and racing with `masna next`.
export function touchRun(root) {
  try {
    const now = new Date();
    utimesSync(runFile(root), now, now);
  } catch {
    // No run file means no run to keep alive.
  }
}

export function lastActivity(root) {
  try {
    return statSync(runFile(root)).mtimeMs;
  } catch {
    return null;
  }
}

export function heartbeatIsRecent(root, now = Date.now()) {
  const last = lastActivity(root);
  return last !== null && now - last < HEARTBEAT_MINUTES * 60_000;
}

export function runIsActive(root) {
  return readRun(root)?.state === 'running' && heartbeatIsRecent(root);
}

function rotateEventLog(root, previousId) {
  if (!previousId || !existsSync(eventsFile(root))) return;
  renameSync(eventsFile(root), join(masnaDir(root), `events.${previousId}.jsonl`));
  const logs = readdirSync(masnaDir(root))
    .filter((name) => /^events\.r\d+\.jsonl$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
  for (const name of logs.slice(EVENT_LOGS_KEPT)) rmSync(join(masnaDir(root), name));
}

export function beginRun(root, { takeover = false } = {}) {
  const previous = readRun(root);
  if (previous?.state === 'running' && heartbeatIsRecent(root) && !takeover) {
    return {
      action: 'pause',
      reason: `run ${previous.id} is active: wait for it, or use --takeover if it has died`,
      report: `run ${previous.id} is already active`,
    };
  }
  const counter = (previous?.counter ?? 0) + 1;
  const run = {
    id: `r${counter}`,
    counter,
    state: 'running',
    started_at: nowIso(),
    failures: 0,
    active: null,
    reason: null,
  };
  rotateEventLog(root, previous?.id);
  saveRun(root, run);
  logEvent(root, 'run', { run: run.id, state: 'running', takeover });
  return { action: 'started', run: run.id, report: `run ${run.id} started` };
}
