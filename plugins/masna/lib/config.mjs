import { readJson } from './fsutil.mjs';
import { PauseError } from './errors.mjs';
import { tryGit } from './git.mjs';
import { configFile } from './project.mjs';

const DEFAULTS = {
  base_branch: 'main',
  queue_label: 'ready-for-agent',
  needs_human_label: 'masna:needs-human',
  pause_after_group: true,
  max_rounds: 3,
  max_gate_fixes: 3,
  gate_timeout_minutes: 30,
  agent_timeout_minutes: 60,
  reviewers: { '**': ['code'] },
  models: {},
  protected_paths: [
    '.masna/**',
    '.claude/**',
    '.mcp.json',
    '.github/workflows/**',
    '**/CLAUDE.md',
    '**/AGENTS.md',
  ],
  never_touch: [],
  blocked_commands: [],
};

// The Agent tool accepts only these, not full model ids.
const MODEL_ALIASES = ['sonnet', 'opus', 'haiku', 'fable'];
const BUILT_IN_REVIEWERS = ['code', 'security', 'ui', 'ux'];

export function normalizeConfig(raw) {
  const config = { ...DEFAULTS, ...raw };
  for (const [key, model] of Object.entries(config.models)) {
    if (!MODEL_ALIASES.includes(model)) {
      throw new Error(`models.${key} must be one of ${MODEL_ALIASES.join(', ')}`);
    }
  }
  return config;
}

export function readLocalConfig(root) {
  const raw = readJson(configFile(root));
  return raw === null ? null : normalizeConfig(raw);
}

// The local file only says which branch is the base. The rules themselves come
// from that branch, so a branch can't change its own routing or limits.
export function loadConfig(root) {
  const local = readLocalConfig(root);
  if (!local) throw new PauseError('.masna/config.json is missing');
  const base = local.base_branch;
  const shown = tryGit(root, ['show', `origin/${base}:.masna/config.json`]);
  if (!shown.ok) {
    throw new PauseError(`.masna/config.json isn't on origin/${base}: commit and push it first`);
  }
  return normalizeConfig(JSON.parse(shown.stdout));
}

export function reviewerAgent(name) {
  const short = BUILT_IN_REVIEWERS.includes(name) ? `reviewer-${name}` : name;
  return {
    name,
    short,
    type: BUILT_IN_REVIEWERS.includes(name) ? `masna:${short}` : name,
    file: `review-${name}.md`,
  };
}

export function customReviewers(config) {
  const names = new Set(Object.values(config.reviewers).flat());
  return [...names].filter((name) => !BUILT_IN_REVIEWERS.includes(name));
}
