import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nowIso } from './fsutil.mjs';

const markerFile = (folder, short, kind) => join(folder, 'agents', `${short}.${kind}`);

export function writeMarker(folder, short, kind) {
  mkdirSync(join(folder, 'agents'), { recursive: true });
  writeFileSync(markerFile(folder, short, kind), nowIso());
}

export const hasMarker = (folder, short, kind) => existsSync(markerFile(folder, short, kind));

function clearMarkers(folder, short) {
  for (const kind of ['started', 'ended', 'failed']) rmSync(markerFile(folder, short, kind), { force: true });
}

// What to do about an agent whose output isn't valid yet. Returns one of:
//   { spawn: true }, { wait: true }, { pause: reason } or { stuck: reason }.
// Two agents in a row ending without valid output look like an outage or a usage
// limit, so that pauses the run and doesn't use up the job's retry.
export function decideAgent({ holder, folder, short, key, run, timeoutMinutes, now = Date.now() }) {
  const record = holder.agents[short];
  const start = (attempts) => {
    clearMarkers(folder, short);
    holder.agents[short] = { key, run: run.id, spawned_at: nowIso(), attempts, counted: false };
    return { spawn: true };
  };

  if (!record || record.key !== key) return start(1);
  if (record.run !== run.id) return start(record.attempts);

  const failed = hasMarker(folder, short, 'failed');
  const ended = hasMarker(folder, short, 'ended');
  if (failed || ended) {
    if (!record.counted) {
      run.failures += 1;
      record.counted = true;
    }
    if (run.failures >= 2) {
      return { pause: `two agents in a row ended without valid output, most recently ${short}: this may be a usage limit or an outage` };
    }
    if (failed) return start(record.attempts);
    if (record.attempts >= 2) return { stuck: `${short} ended twice without a valid output file` };
    return start(record.attempts + 1);
  }

  if (now - Date.parse(record.spawned_at) > timeoutMinutes * 60_000) {
    return { pause: `${short} hasn't finished after ${timeoutMinutes} minutes` };
  }
  return { wait: true };
}
