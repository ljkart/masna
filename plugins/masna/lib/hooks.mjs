import { join } from 'node:path';
import { hasMarker, writeMarker } from './agents.mjs';
import { customReviewers, readLocalConfig } from './config.mjs';
import { logEvent } from './events.mjs';
import { findRoot, jobsDir } from './project.mjs';
import { readRun, touchRun } from './run.mjs';

function shortName(agentType, config) {
  if (agentType?.startsWith('masna:')) return agentType.slice('masna:'.length);
  return config && customReviewers(config).includes(agentType) ? agentType : null;
}

// Records that an agent started or ended. Builds are serial and each agent type
// runs once per job, so the active job and the agent's type identify it.
// A failure here must never disturb the agent, so errors are ignored by the caller.
export function recordAgent(input, kind) {
  const root = findRoot(input.cwd ?? process.cwd());
  const config = readLocalConfig(root);
  if (!config) return;
  const short = shortName(input.agent_type, config);
  const run = readRun(root);
  if (!short || !run?.active) return;

  const folder = join(jobsDir(root), run.active);
  if (kind === 'started' && hasMarker(folder, short, 'started')) return;
  writeMarker(folder, short, kind);
  touchRun(root);
  logEvent(root, 'agent', { run: run.id, job: run.active, agent: short, state: kind });
}
