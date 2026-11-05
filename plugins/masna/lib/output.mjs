// Parsers for the one file each agent writes. A parser returns null for anything
// malformed, and the engine treats that the same as a missing file.

function field(text, name) {
  const match = text?.match(new RegExp(`^${name}:[ \\t]*(.+?)[ \\t]*$`, 'm'));
  return match ? match[1] : null;
}

function oneOf(value, allowed) {
  return allowed.includes(value) ? value : null;
}

export function commitMatches(written, actual) {
  return Boolean(written) && written.length >= 7 && actual.startsWith(written);
}

export function parseBuild(text) {
  const status = oneOf(field(text, 'STATUS'), ['READY', 'BLOCKED']);
  return status ? { status } : null;
}

export function parseVerdict(text) {
  const verdict = oneOf(field(text, 'VERDICT'), ['PASS', 'CHANGES']);
  const commit = field(text, 'COMMIT');
  return verdict && commit ? { verdict, commit } : null;
}

export function parseDecision(text) {
  const decision = oneOf(field(text, 'DECISION'), ['APPROVE', 'REJECT', 'DECISION-NEEDED']);
  const commit = field(text, 'COMMIT');
  return decision && commit ? { decision, commit } : null;
}

export function parseChecks(text) {
  const result = oneOf(field(text, 'RESULT'), ['PASS', 'FAIL', 'ERROR']);
  const commit = field(text, 'COMMIT');
  return result && commit ? { result, commit, reason: field(text, 'REASON') } : null;
}

export function parseGroup(text) {
  const status = oneOf(field(text, 'STATUS'), ['READY', 'BLOCKED']);
  const commit = field(text, 'COMMIT');
  return status && commit ? { status, commit } : null;
}
