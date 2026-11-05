const compiled = new Map();

function toRegExp(pattern) {
  if (compiled.has(pattern)) return compiled.get(pattern);
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (pattern.slice(i) === '/**') {
      // `a/**` covers the folder itself too, so `rm -rf a` can't get past it.
      source += '(?:/.*)?';
      break;
    } else if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const regExp = new RegExp(`^${source}$`);
  compiled.set(pattern, regExp);
  return regExp;
}

export function matchGlob(pattern, path) {
  return toRegExp(pattern).test(path);
}

export function matchesAny(patterns, path) {
  return patterns.some((pattern) => matchGlob(pattern, path));
}

// A file gets the reviewers of every pattern it matches, not only the first.
// A change matching nothing still gets the code reviewer.
export function route(files, reviewers) {
  const chosen = new Set();
  for (const file of files) {
    for (const [pattern, names] of Object.entries(reviewers)) {
      if (matchGlob(pattern, file)) names.forEach((name) => chosen.add(name));
    }
  }
  if (chosen.size === 0) chosen.add('code');
  return [...chosen].sort();
}

function patternsFor(name, reviewers) {
  return Object.entries(reviewers)
    .filter(([, names]) => names.includes(name))
    .map(([pattern]) => pattern);
}

// A pass holds on a later commit only if nothing that reviewer covers has changed.
export function passStillHolds(name, changedFiles, reviewers) {
  const patterns = patternsFor(name, reviewers);
  return !changedFiles.some((file) => matchesAny(patterns, file));
}
