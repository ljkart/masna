import { spawnSync } from 'node:child_process';
import { InfraError } from './errors.mjs';

const ISSUE_FIELDS = 'number,title,body,state,stateReason,milestone,labels,author,comments';

const META_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      lastEditedAt
      editor { login }
      timelineItems(itemTypes: [LABELED_EVENT, RENAMED_TITLE_EVENT], last: 100) {
        nodes {
          ... on LabeledEvent { createdAt label { name } }
          ... on RenamedTitleEvent { createdAt actor { login } }
        }
      }
    }
  }
}`;

// All GitHub access goes through `gh`, run from the project. Any failure is
// treated as an outage: it pauses the run and doesn't blame the issue.
export class GitHub {
  constructor(root) {
    this.root = root;
    this.writers = new Map();
  }

  run(args, input) {
    const result = spawnSync('gh', args, {
      cwd: this.root,
      input,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw new InfraError(`gh couldn't run: ${result.error.message}`);
    if (result.status !== 0) {
      const error = new InfraError(`gh ${args.slice(0, 2).join(' ')} failed: ${(result.stderr ?? '').trim()}`);
      error.stderr = result.stderr ?? '';
      throw error;
    }
    return result.stdout;
  }

  json(args) {
    return JSON.parse(this.run(args));
  }

  milestones() {
    return this.json(['api', 'repos/{owner}/{repo}/milestones?state=open&per_page=100']);
  }

  queuedIssues(label) {
    const issues = this.json([
      'issue', 'list', '--state', 'open', '--label', label, '--limit', '1000', '--json', ISSUE_FIELDS,
    ]);
    return issues.map(normalizeIssue);
  }

  issue(number) {
    return normalizeIssue(this.json(['issue', 'view', String(number), '--json', ISSUE_FIELDS]));
  }

  labelEvents(number, label) {
    const data = this.json([
      'api', 'graphql',
      '-f', `query=${META_QUERY}`,
      '-F', 'owner={owner}',
      '-F', 'name={repo}',
      '-F', `number=${number}`,
    ]);
    const issue = data.data.repository.issue;
    const labeled = issue.timelineItems.nodes
      .filter((node) => node.label?.name === label)
      .map((node) => node.createdAt)
      .sort();
    // The title reaches agents too, and a rename doesn't count as a body edit.
    const edits = issue.timelineItems.nodes
      .filter((node) => node.actor)
      .map((node) => ({ at: node.createdAt, by: node.actor.login }));
    if (issue.lastEditedAt) edits.push({ at: issue.lastEditedAt, by: issue.editor?.login ?? null });
    const labeledAt = labeled[labeled.length - 1] ?? null;
    const afterLabel = edits.filter((edit) => labeledAt && edit.at > labeledAt);
    return { labeledAt, edits: afterLabel };
  }

  hasWriteAccess(login) {
    if (!login) return false;
    if (this.writers.has(login)) return this.writers.get(login);
    let allowed = false;
    try {
      const { permission } = this.json(['api', `repos/{owner}/{repo}/collaborators/${login}/permission`]);
      allowed = ['admin', 'write'].includes(permission);
    } catch (error) {
      // A person with no relationship to the repo gets a 403 or 404, not an outage.
      if (!/HTTP 40[34]/.test(error.stderr ?? '')) throw error;
    }
    this.writers.set(login, allowed);
    return allowed;
  }

  addLabel(number, label) {
    this.run(['issue', 'edit', String(number), '--add-label', label]);
  }

  removeLabel(number, label) {
    this.run(['issue', 'edit', String(number), '--remove-label', label]);
  }

  comment(number, body) {
    this.run(['issue', 'comment', String(number), '--body-file', '-'], body);
  }

  closeIssue(number) {
    this.run(['issue', 'close', String(number), '--reason', 'completed']);
  }

  pullRequestForBranch(branch) {
    const found = this.json([
      'pr', 'list', '--head', branch, '--state', 'all', '--limit', '20',
      '--json', 'number,url,state,baseRefName',
    ]);
    return found.find((pr) => pr.state === 'OPEN') ?? found[0] ?? null;
  }

  pullRequestState(number) {
    return this.json(['pr', 'view', String(number), '--json', 'state']).state;
  }

  createPullRequest({ base, head, title, body }) {
    const url = this.run(['pr', 'create', '--base', base, '--head', head, '--title', title, '--body-file', '-'], body).trim();
    return { url, number: Number(url.split('/').pop()) };
  }

  editPullRequest(number, { base, title, body }) {
    const args = ['pr', 'edit', String(number)];
    if (base) args.push('--base', base);
    if (title) args.push('--title', title);
    if (body !== undefined) args.push('--body-file', '-');
    this.run(args, body);
  }
}

function normalizeIssue(issue) {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    stateReason: issue.stateReason ?? '',
    milestone: issue.milestone?.number ?? null,
    labels: (issue.labels ?? []).map((label) => label.name),
    author: issue.author?.login ?? null,
    comments: (issue.comments ?? []).map((comment) => ({
      author: comment.author?.login ?? null,
      createdAt: comment.createdAt,
      body: comment.body,
    })),
  };
}
