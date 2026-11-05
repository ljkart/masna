import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseBuild, parseDecision, parseGroup, parseVerdict } from '../../plugins/masna/lib/output.mjs';

const pluginFile = (path) => fileURLToPath(new URL(`../../plugins/masna/${path}`, import.meta.url));

function frontmatter(text) {
  const block = text.match(/^---\n([\s\S]*?)\n---\n/)[1];
  return Object.fromEntries(block.split('\n').map((line) => {
    const at = line.indexOf(':');
    return [line.slice(0, at), line.slice(at + 1).trim()];
  }));
}

function agent(name) {
  const text = readFileSync(pluginFile(`agents/${name}.md`), 'utf8');
  const meta = frontmatter(text);
  return { text, meta, tools: meta.tools.split(',').map((tool) => tool.trim()) };
}

const REVIEWERS = ['reviewer-code', 'reviewer-security', 'reviewer-ui', 'reviewer-ux'];
const AGENTS = ['builder', ...REVIEWERS, 'approver', 'finisher'];

test('the plugin has exactly the agents the engine starts', () => {
  const found = readdirSync(pluginFile('agents')).map((file) => file.replace(/\.md$/, '')).sort();
  assert.deepEqual(found, [...AGENTS].sort());
});

// Without a list, a background agent also gets Agent, SendMessage, WebFetch and WebSearch.
for (const name of AGENTS) {
  test(`${name} has a tool list that can't reach outside or start agents`, () => {
    const { meta, tools } = agent(name);
    assert.equal(meta.name, name);
    for (const banned of ['Agent', 'SendMessage', 'WebFetch', 'WebSearch']) {
      assert.equal(tools.includes(banned), false, banned);
    }
    assert.ok(['Read', 'Write', 'Bash'].every((tool) => tools.includes(tool)));
    assert.match(meta.model, /^(sonnet|opus|haiku|fable)$/);
    assert.ok(Number(meta.maxTurns) > 0);
  });
}

test('only the builder can edit', () => {
  assert.ok(agent('builder').tools.includes('Edit'));
  for (const name of [...REVIEWERS, 'approver', 'finisher']) {
    assert.equal(agent(name).tools.includes('Edit'), false, name);
  }
});

// What an agent is told to write has to be what the engine can read.
const outputExample = (text) => text.match(/```markdown\n([\s\S]*?)```/)[1];

test('each agent\'s example output is one the engine accepts', () => {
  assert.equal(parseBuild(outputExample(agent('builder').text))?.status, 'READY');
  for (const name of REVIEWERS) {
    assert.equal(parseVerdict(outputExample(agent(name).text))?.verdict, 'PASS', name);
  }
  assert.equal(parseDecision(outputExample(agent('approver').text))?.decision, 'APPROVE');
  assert.equal(parseGroup(outputExample(agent('finisher').text))?.status, 'READY');
});

test('the builder is pointed at everything a reopened job leaves behind', () => {
  const { text } = agent('builder');
  for (const file of ['feedback.md', 'checks.md', 'checks.log', 'review-*.md', 'build.previous.md']) {
    assert.ok(text.includes(file), file);
  }
});

// Claude Code denies any one command holding both, however the allow rules read.
test('no agent is told to combine cd and git', () => {
  for (const name of AGENTS) {
    const { text } = agent(name);
    assert.equal(/`cd [^`]*&&[^`]*\bgit\b/.test(text), false, name);
    assert.ok(text.includes('git -C <Worktree>'), name);
  }
});

for (const name of ['run', 'status', 'feedback']) {
  test(`/masna:${name} only runs when a person asks`, () => {
    const file = pluginFile(`skills/${name}/SKILL.md`);
    assert.ok(existsSync(file));
    assert.equal(frontmatter(readFileSync(file, 'utf8'))['disable-model-invocation'], 'true');
  });
}

test('/masna:run covers every action the engine can return', () => {
  const skill = readFileSync(pluginFile('skills/run/SKILL.md'), 'utf8');
  const engine = readFileSync(pluginFile('lib/next.mjs'), 'utf8');
  const actions = new Set([...engine.matchAll(/action: '([a-z]+)'/g)].map((match) => match[1]));
  assert.deepEqual([...actions].sort(), ['done', 'exec', 'pause', 'spawn', 'wait']);
  for (const action of actions) assert.ok(skill.includes(`| \`${action}\` |`), action);
  assert.ok(skill.includes('--failed <type>'));
});
