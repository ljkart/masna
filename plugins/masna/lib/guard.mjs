import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { agentOutput } from './agents.mjs';
import { customReviewers, normalizeConfig } from './config.mjs';
import { logEvent } from './events.mjs';
import { readJson, readText } from './fsutil.mjs';
import { currentBranch, tryGit } from './git.mjs';
import { configFile, findRoot, groupDir, jobDir, worktreesDir } from './project.mjs';
import { matchesAny } from './route.mjs';
import { readRun, runIsActive, touchRun } from './run.mjs';
import { simpleCommands, writeTargets } from './shell.mjs';

const FILE_TOOLS = { Edit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path' };
const SAFE_DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);
const SEES_SCREENS = ['masna:reviewer-ui', 'masna:reviewer-ux'];
const FORCE_FLAGS = /^(-f|--force|--force-with-lease.*|--force-if-includes|--mirror)$/;

const allow = { allow: true };
const block = (reason) => ({ allow: false, reason });

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

// Real path of a file that may not exist yet: resolve the nearest existing folder.
// A dangling symlink is followed too, since writing through it creates its target.
export function realPath(path) {
  let current = path;
  const missing = [];
  for (let hops = 0; !existsSync(current); hops += 1) {
    if (hops > 256) throw new Error(`too many links resolving ${path}`);
    if (isSymlink(current)) {
      current = resolve(dirname(current), readlinkSync(current));
    } else {
      const parent = dirname(current);
      if (parent === current) break;
      missing.unshift(current.slice(parent.length + 1));
      current = parent;
    }
  }
  return join(realpathSync(current), ...missing);
}

const isInside = (folder, path) => path === folder || path.startsWith(folder + sep);

function pushProblem(words, { baseBranch, branchIn }) {
  const args = words.slice(1);
  if (args.some((arg) => FORCE_FLAGS.test(arg))) return 'force pushes are blocked';
  if (args.includes('--all')) return 'pushing every branch is blocked';
  const positional = args.filter((arg) => !arg.startsWith('-'));
  const refspecs = positional.slice(1);
  if (refspecs.some((refspec) => refspec.startsWith('+'))) return 'force pushes are blocked';

  const pointsAtBase = (name) => name.replace(/^refs\/heads\//, '') === baseBranch;
  const current = () => branchIn();
  if (refspecs.length === 0 && current() === baseBranch) return `pushing ${baseBranch} is blocked`;
  for (const refspec of refspecs) {
    const destination = refspec.includes(':') ? refspec.split(':').pop() : refspec;
    if (pointsAtBase(destination)) return `pushing ${baseBranch} is blocked`;
    if (destination === 'HEAD' && current() === baseBranch) return `pushing ${baseBranch} is blocked`;
  }
  return null;
}

function commandProblem(command, context) {
  const { words, name } = command;
  if (name === 'git') {
    let index = 1;
    while (words[index]?.startsWith('-')) {
      index += ['-C', '-c', '--git-dir', '--work-tree'].includes(words[index]) ? 2 : 1;
    }
    if (words[index] === 'push') return pushProblem(words.slice(index), context);
  }
  if (name === 'gh') {
    const args = words.filter((word, i) => !word.startsWith('-') && !['-R', '--repo'].includes(words[i - 1]));
    if (args[1] === 'pr' && args[2] === 'merge') return 'gh pr merge is blocked';
    if (args[1] === 'api' && args.some((arg) => /\/(pulls\/\d+\/merge|merges|git\/refs)\b/.test(arg))) {
      return 'merging or moving branches through gh api is blocked';
    }
  }
  return null;
}

function relativeToWorkspace(path, { root, worktreeRoots }) {
  const worktree = worktreeRoots.find((folder) => isInside(folder, path));
  if (worktree) return relative(worktree, path).split(sep).join('/');
  if (isInside(root, path)) return relative(root, path).split(sep).join('/');
  return null;
}

// What each kind of agent may write, as a function from path to a problem or null.
function pathProblem(path, context) {
  const { config, agent, root } = context;
  if (SAFE_DEVICES.has(path)) return null;
  const rel = relativeToWorkspace(path, context);

  if (rel !== null && matchesAny(config.never_touch, rel)) return `${rel} is in never_touch`;
  if (!agent) return null;

  if (agent.kind === 'builder') {
    if (path === agent.ownFile) return null;
    if (!agent.worktree || !isInside(agent.worktree, path)) {
      return 'the builder can only write inside its worktree, and its build.md';
    }
    if (matchesAny(config.protected_paths, rel)) return `${rel} is a protected path`;
    return null;
  }
  if (agent.screens && isInside(agent.screens, path)) return null;
  if (path !== agent.ownFile) return `${agent.short} can only write its own output file`;
  return root ? null : 'no project';
}

function resolveTarget(target, cwd) {
  if (cwd === null) return null;
  if (target.includes('$') || target.includes('`') || target.includes('*')) return null;
  const expanded = target.startsWith('~') ? null : target;
  return expanded === null ? null : realPath(resolve(cwd, expanded));
}

// Where a command leaves the shell, or null if a pattern check can't tell.
function folderAfter(command, cwd) {
  if (command.name !== 'cd') return cwd;
  const target = command.words.slice(1).filter((word) => !word.startsWith('-')).pop();
  return target === undefined ? null : resolveTarget(target, cwd);
}

// Claude Code refuses these beside a cd, however the allow rules read, and its message
// blames Bash as a whole. Refusing them here tells the agent what to send instead.
function cdProblem(commands) {
  if (!commands.some(({ name }) => name === 'cd')) return null;
  const refused = commands.filter(({ name }) => name !== 'cd').some((command) => command.name === 'git'
    || command.words.slice(1).some((word) => /(^|\/)\.\.(\/|$)/.test(word))
    || writeTargets(command).some((target) => !SAFE_DEVICES.has(target)));
  return refused
    ? 'Claude Code refuses a call with cd beside git, .. or a write. Bash still works: send this again with absolute paths and git -C <folder>, and no cd'
    : null;
}

// Decides one tool call. Pure apart from reading the file system for real paths.
export function decide({ toolName, toolInput, cwd, context }) {
  const { agent, config } = context;

  if (toolName.startsWith('mcp__')) {
    return agent ? block('MCP tools are blocked for Masna\'s agents') : allow;
  }

  if (FILE_TOOLS[toolName]) {
    const file = toolInput[FILE_TOOLS[toolName]];
    if (!file) return block(`${toolName} without a path`);
    const problem = pathProblem(realPath(resolve(cwd, file)), context);
    return problem ? block(problem) : allow;
  }

  if (toolName === 'Bash') {
    const text = toolInput.command ?? '';
    for (const entry of config.blocked_commands) {
      if (text.includes(entry)) return block(`"${entry}" is in blocked_commands`);
    }
    const commands = simpleCommands(text);
    const refused = agent ? cdProblem(commands) : null;
    if (refused) return block(refused);
    let folder = cwd;
    for (const command of commands) {
      const problem = commandProblem(command, context);
      if (problem) return block(problem);
      for (const target of writeTargets(command)) {
        const path = resolveTarget(target, folder);
        if (path === null) {
          if (agent) return block(`can't tell where "${target}" points`);
        } else {
          const pathIssue = pathProblem(path, context);
          if (pathIssue) return block(pathIssue);
        }
      }
      folder = folderAfter(command, folder);
    }
  }
  return allow;
}

function describeAgent(agentType, root, config, run) {
  const short = agentType?.startsWith('masna:') ? agentType.slice('masna:'.length) : agentType;
  const isMasna = agentType?.startsWith('masna:') || customReviewers(config).includes(agentType);
  if (!isMasna) return null;

  const active = run?.active ?? null;
  const job = active && !active.startsWith('group-') ? readJson(join(jobDir(root, active), 'job.json')) : null;
  const groupNumber = job?.group ?? (active?.startsWith('group-') ? Number(active.slice('group-'.length)) : null);
  const group = groupNumber === null ? null : readJson(join(groupDir(root, groupNumber), 'group.json'));
  const folder = active ? join(root, '.masna', 'jobs', active) : null;

  if (short === 'builder') {
    return {
      kind: 'builder',
      short,
      ownFile: folder ? join(folder, 'build.md') : null,
      worktree: group?.worktree ? realPath(join(root, group.worktree)) : null,
    };
  }
  return {
    kind: short === 'approver' || short === 'finisher' ? short : 'reviewer',
    short,
    ownFile: folder ? join(folder, agentOutput(short).file) : null,
    screens: folder && SEES_SCREENS.includes(agentType) ? join(folder, 'screens') : null,
  };
}

function guardConfig(root) {
  const local = normalizeConfig(readJson(configFile(root)));
  const shown = tryGit(root, ['show', `origin/${local.base_branch}:.masna/config.json`]);
  return shown.ok ? normalizeConfig(JSON.parse(shown.stdout)) : local;
}

function worktreeRootsOf(root) {
  const folder = worktreesDir(root);
  if (!existsSync(folder)) return [];
  const real = realpathSync(folder);
  const listed = tryGit(root, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return [];
  return listed.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((path) => isInside(real, path));
}

// The hook. Returns a decision, and any error is the caller's cue to block.
export function guardHook(input) {
  const cwd = input.cwd ?? process.cwd();
  const inRepo = tryGit(cwd, ['rev-parse', '--git-dir']);
  if (!inRepo.ok) return allow;

  const root = findRoot(cwd);
  if (readText(configFile(root)) === null) return allow;

  const agentType = input.agent_type;
  const unguardedSession = !agentType && !runIsActive(root);
  if (unguardedSession) return allow;

  const config = guardConfig(root);
  const run = readRun(root);
  const agent = agentType ? describeAgent(agentType, root, config, run) : null;
  if (!agent && !runIsActive(root)) return allow;

  const decision = decide({
    toolName: input.tool_name,
    toolInput: input.tool_input ?? {},
    cwd,
    context: {
      root,
      config,
      agent,
      worktreeRoots: worktreeRootsOf(root),
      baseBranch: config.base_branch,
      branchIn: () => currentBranch(cwd),
    },
  });

  // Tool lines hold only who, which tool and when: tool input could contain secrets.
  touchRun(root);
  logEvent(root, 'tool', {
    agent: agent?.short ?? 'orchestrator',
    tool: input.tool_name,
    blocked: !decision.allow,
  });
  return decision;
}
