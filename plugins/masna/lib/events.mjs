import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { nowIso } from './fsutil.mjs';
import { eventsFile } from './project.mjs';

// The event log only feeds the dashboard and the pilot's record, so failing to
// write it must never fail a command or block a tool.
export function logEvent(root, type, details = {}) {
  try {
    const path = eventsFile(root);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ at: nowIso(), type, ...details })}\n`);
  } catch {
    // Deliberately ignored: see above.
  }
}

export function readEvents(root) {
  try {
    return readFileSync(eventsFile(root), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
