// A small reader for shell commands, good enough for pattern checks. It isn't a
// full parser: the guard is a safety net, not a sandbox.

const WRAPPERS = new Set(['sudo', 'command', 'env', 'time', 'exec', 'nohup', 'nice', 'xargs']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

// Splits into words and redirect targets, respecting quotes, and starts a new
// segment at each ; && || | & or newline.
export function parseSegments(command) {
  const segments = [];
  let segment = { words: [], redirects: [] };
  let word = '';
  let inWord = false;
  let quote = null;
  let redirectNext = false;

  const endWord = () => {
    if (!inWord) return;
    if (redirectNext) {
      segment.redirects.push(word);
      redirectNext = false;
    } else {
      segment.words.push(word);
    }
    word = '';
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    redirectNext = false;
    if (segment.words.length || segment.redirects.length) segments.push(segment);
    segment = { words: [], redirects: [] };
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && i + 1 < command.length) {
        i += 1;
        word += command[i];
      } else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
    } else if (char === '\\' && i + 1 < command.length) {
      i += 1;
      if (command[i] !== '\n') {
        word += command[i];
        inWord = true;
      }
    } else if (char === ' ' || char === '\t') {
      endWord();
    } else if (char === ';' || char === '\n' || char === '|') {
      endSegment();
    } else if (char === '&') {
      if (command[i + 1] === '>') {
        endWord();
        i += command[i + 2] === '>' ? 2 : 1;
        redirectNext = true;
      } else {
        endSegment();
      }
    } else if (char === '>') {
      if (/^\d+$/.test(word)) {
        word = '';
        inWord = false;
      } else {
        endWord();
      }
      if (command[i + 1] === '>') i += 1;
      if (command[i + 1] === '&') {
        // >&1 and 2>&1 point at another stream, not a file.
        i += 1;
        while (/\d|-/.test(command[i + 1] ?? '')) i += 1;
      } else {
        redirectNext = true;
      }
    } else {
      word += char;
      inWord = true;
    }
  }
  endSegment();
  return segments;
}

// The commands inside $(...) and backticks, which also run.
function substitutions(command) {
  const found = [];
  for (const match of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) found.push(match[1] ?? match[2]);
  return found;
}

function stripWrappers(words) {
  let rest = words;
  while (rest.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest = rest.slice(1);
    else if (WRAPPERS.has(rest[0])) {
      rest = rest.slice(1);
      while (rest[0]?.startsWith('-')) rest = rest.slice(1);
    } else break;
  }
  return rest;
}

// Every simple command that would run, looking inside `bash -c` and `eval`.
export function simpleCommands(command, depth = 0) {
  if (depth > 5) return [{ words: ['__too_deep__'], redirects: [] }];
  const results = [];
  for (const inner of substitutions(command)) results.push(...simpleCommands(inner, depth + 1));

  for (const segment of parseSegments(command)) {
    const words = stripWrappers(segment.words);
    const name = words[0]?.split('/').pop();
    if (SHELLS.has(name)) {
      const flag = words.findIndex((word) => /^-[a-z]*c$/.test(word));
      if (flag >= 0 && words[flag + 1]) {
        results.push(...simpleCommands(words[flag + 1], depth + 1));
        continue;
      }
    }
    if (name === 'eval') {
      results.push(...simpleCommands(words.slice(1).join(' '), depth + 1));
      continue;
    }
    results.push({ words, redirects: segment.redirects, name });
  }
  return results;
}

function positional(words) {
  return words.filter((word) => !word.startsWith('-'));
}

// The paths a command would write to, as far as a pattern check can tell.
export function writeTargets({ words, redirects, name }) {
  const targets = [...redirects];
  const args = words.slice(1);
  if (['rm', 'rmdir', 'touch', 'mkdir', 'mv', 'chmod', 'chown', 'truncate', 'ln', 'tee', 'shred'].includes(name)) {
    let paths = positional(args);
    if (name === 'chmod' || name === 'chown') paths = paths.slice(1);
    targets.push(...paths);
  } else if (name === 'cp' || name === 'install' || name === 'rsync') {
    const paths = positional(args);
    if (paths.length) targets.push(paths[paths.length - 1]);
  } else if (name === 'dd') {
    for (const arg of args) if (arg.startsWith('of=')) targets.push(arg.slice(3));
  } else if ((name === 'sed' || name === 'perl') && args.some((arg) => /^-[a-zA-Z]*i/.test(arg))) {
    const paths = positional(args);
    targets.push(...paths.slice(1));
  }
  return targets;
}
