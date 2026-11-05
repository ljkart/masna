# Masna: build plan

Masna (Arabic for "factory") is a Claude Code plugin that turns a queue of GitHub issues into reviewed code. It takes one issue at a time, builds it, runs the project's checks, reviews it from several angles in parallel, fixes what the reviewers find, and moves on until the queue is empty.

This plan stands on its own, so a new session can build from it without other context.

- **Repo:** `ljkart/masna`, public
- **Licence:** MIT
- **Status:** planned; the repo exists with only a licence, nothing built

## 1. Goals

1. Run unattended through a queue of issues that depend on each other.
2. Install into any project with two commands and one setup step.
3. Let scripts decide what happens next, and use agents only for judgement.
4. Survive a crash or a full context without losing work.
5. Never merge to the base branch, deploy, or publish sensitive findings.
6. Show what a run is doing, live, without affecting it.

## 2. Not in version 0.1

- Parallel builds. Reviews run in parallel, builds don't.
- Cost tracking or a spend cap.
- A hosted or shared dashboard, or controls in the dashboard. The local, read-only one is in scope.
- Running in CI or the cloud, or restarting without a person.
- One pull request per issue. Added when a real project needs it.
- Deciding whether an issue is worth building. Issues are expected to be triaged already.

## 3. Origins and licence rules

The software-factory pattern is common. One public example, `zazencodes/zazencodes-season-3`, informed this design and is credited in the README. It's GPLv3, with an earlier version under no licence.

- **Don't copy its code, prompts or file text, and don't keep it open while building.** Work from this plan.
- Everything in this repo is written from scratch, so it can ship under MIT.

## 4. How a project uses it

```bash
claude plugin marketplace add ljkart/masna
claude plugin install masna@ljkart --scope project
```

Then in Claude Code:

```text
/masna:init                  inspect the project, write .masna/, create labels, run the checks once
/masna:run                   work through the queue; run it again to resume
/masna:status                what's running, finished, stuck or waiting
/masna:feedback <n> <text>   send a stuck issue or an open group PR back for more work
/masna:doctor                check tools, auth, config, labels and branch protection
/masna:dashboard             open a live view of the queue and the current run in a browser
```

## 5. The loop

```text
Next unblocked issue in the current group
   ↓
Builder (fresh agent, on masna/issue/<n> from the group branch)
   ↓
Gate: the project's checks and protected paths ──fail──→ builder (limited retries)
   ↓ pass
Route: changed files choose the reviewers
   ↓
Reviewers in parallel; wait for all
   ↓ changes wanted → builder → gate → reviewers needing a re-run (limited rounds)
   ↓ all pass
Approver: are the acceptance criteria really met?
   ↓ yes                                    ↓ no, or a business decision
Squash into group branch,                   Flag needs-human, skip everything
close issue, post verdicts                  that depends on it, carry on
   ↓
Group finished → whole-group review → project checklist → open PR → pause
```

A **group** is one GitHub milestone. Its PR is the point where a person reviews the work.

## 6. Key design decisions

### The engine decides, and the skill only carries it out

`/masna:run` is deliberately thin. It runs `masna begin` once, then runs `masna next`, does exactly what the JSON says, and repeats.

```json
{ "action": "spawn",
  "run": "r7",
  "agents": [
    { "type": "masna:reviewer-security", "model": "opus", "prompt": "Job: 12. Job folder: ... Worktree: ... Round: 2." },
    { "type": "masna:reviewer-code", "model": "sonnet", "prompt": "..." }
  ],
  "report": "#12: gate passed, reviewing (security, code)" }
```

Actions are `spawn`, `exec`, `wait`, `pause` and `done`. Quick scripted work (routing, state moves, landing) runs inside `masna next`. The orchestrator never writes code, edits state or chooses a stage, and it never reads agents' output. That keeps its context small for a long run.

### Slow scripts run in the background

A foreground Bash call has a time limit, and project checks can run longer. So `masna next` never runs `setup.sh` or `checks.sh` itself. It returns an `exec` action, which the skill runs as background Bash:

```json
{ "action": "exec", "run": "r7", "command": "masna gate --job 12 --run r7", "report": "#12: running checks" }
```

Claude Code wakes the orchestrator when the command exits, and it calls `masna next` again. `masna gate` enforces `gate_timeout_minutes` by killing the process group, and a timeout is recorded as a failed gate. Commands in `exec` are always `masna` subcommands built by the engine.

### State lives in files, and `next` works it out from them

`masna next` works out what to do from the job files, so running it twice is safe.

### Runs, not sessions, decide whether an agent is alive

A resumed session may keep its id even though its agents are gone, so a session id can't reliably show whether an agent is still running. Instead, `masna begin` creates a run id and writes it to `.masna/run.json`, and every `next` call passes it with `--run`. Each spawned agent is recorded with its run and start time.

`begin` refuses to start if another run has a heartbeat from the last 15 minutes, unless given `--takeover`. Engine commands and guard calls refresh the heartbeat. `next` refuses a run id that isn't the current one, so a replaced orchestrator can't keep acting.

A plugin `SubagentStop` hook records that an agent ended. Builds are serial and each agent type runs once per job, so the agent type and the active job identify the output file. `next` then decides:

| Agent's state | Result |
|---|---|
| Valid output for the current commit | Move on |
| Started by an earlier run, no valid output | Start it again |
| Ended, output missing or malformed | Start it once more, then `needs-human` |
| Not ended, within `agent_timeout_minutes` | `wait` |
| Not ended, past `agent_timeout_minutes` | `pause`, with the reason |

### Outages pause the run; they don't blame the issue

If usage limits or an API outage killed agents, the retry rule above would mark every issue in the queue as stuck. So two agents in a row ending without valid output produce `pause`, leave the job where it is and don't use up its retry. Failed `git` or `gh` network calls also produce `pause`. Only problems with the work move a job to `needs-human`.

### Stages and evidence

Stages, with moves refused unless the evidence exists:

```text
build → gate → review → approve → landing → landed
```

Any stage can move to `needs-human`, and `needs-human` returns to `build` through feedback. An issue closed or unlabelled by a person mid-job moves to `cancelled`, checked before each builder and before landing. The branch is kept.

Evidence required:

| Move | Requires |
|---|---|
| `build → gate` | `build.md` says READY, clean worktree, commits ahead of the group branch |
| `gate → review` | `checks.md` says PASS for the current commit |
| `gate → build` | `checks.md` says FAIL for the current commit, within `max_gate_fixes` for this round |
| `review → approve` | A valid PASS from every required reviewer that still holds (see below) |
| `review → build` | A valid verdict from every required reviewer, at least one CHANGES, within `max_rounds` |
| `approve → landing` | `decision.md` says APPROVE |
| `approve → needs-human` | `decision.md` says REJECT or DECISION-NEEDED |
| `landing → landed` | Commit with an `Masna-Issue: <n>` trailer on the remote group branch, issue closed, verdicts posted |

Going over a limit moves the job to `needs-human`. Feedback resets its counters.

Each landing step checks whether it's already done, using the trailer, so a crash between pushing and closing the issue is safe to resume.

### The checks must pass before a group starts

If the base branch is already failing, every builder would burn its retries on a problem it didn't cause. `masna gate --baseline` runs the checks on the new group branch before the first issue. A failure produces `pause`.

### Every builder round is a fresh agent

Builders aren't resumed with `SendMessage`. A new builder reads the issue, `build.md`, `git log` and the findings. This keeps context clean, works across sessions, and avoids relying on resuming named plugin agents, which the docs don't clearly cover.

### Checks can't be changed by the branch they judge

The gate runs the base branch's `.masna/checks.sh` (from `git show origin/<base>:.masna/checks.sh`), inside the worktree. The engine lives in the plugin cache, outside the repo. The gate also fails a branch that changes a protected path.

The engine reads `.masna/config.json` from `origin/<base>` too, so a branch can't change its own routing or limits.

The branch's own code still runs during the checks, through its tests and scripts. The gate removes `GH_TOKEN`, `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` from that environment, but it can't remove access to a keyring. This is one more reason `README.md` recommends sandboxing.

### Reviewers are chosen by changed files, not by an agent

`reviewers` maps path patterns to reviewers. A file gets the reviewers of every pattern it matches, not only the first. A re-run covers reviewers that asked for changes, plus any whose matched files changed since they passed.

Each verdict is tied to a commit. A PASS still holds on a later commit only if `git diff <verdict commit> <current commit>` touches none of that reviewer's matched files. The engine works this out, so an old pass can't be reused for code the reviewer hasn't seen.

### Agent files are generic, and project rules live in the project

Each reviewer reads `.masna/rules/<reviewer>.md` from the project. Nothing project-specific goes in the plugin. A project can add reviewers by defining them in `.claude/agents/` and listing them in its config.

### Dependencies come from the issues

The queue is open issues with the queue label, in the current milestone, whose `## Blocked by` issues are all landed or closed as completed. Ties go to the lowest issue number. If an issue is stuck, everything that depends on it, directly or indirectly, is skipped and reported.

The current milestone is the first open one with queued issues, ordered by due date, then number.

Issues in a milestone are the only ones eligible, so a labelled parent PRD outside any milestone is never picked up. These go to `needs-human`, with the reason:

- An issue that can't be parsed
- A blocker closed as not planned
- A blocker that's still open and outside the queue, which would otherwise wait forever
- A dependency cycle

### Group branches keep one review point per group

`masna/group/<milestone number>-<slug>` starts from the base branch, or from the previous group's branch if that hasn't merged yet (a stacked PR). Using the number keeps the name valid and unique whatever the milestone's title. Issues are squashed in, giving one commit per issue. The engine closes each issue when it lands, because GitHub only auto-closes on merge to the default branch.

If a person asks for changes to an earlier group, its branch is merged forward into later groups. Nothing is force-pushed. `pause_after_group` defaults to `true`.

A group finishes when it has no runnable issues left:

- **Everything landed:** open the PR, then follow `pause_after_group`.
- **Some landed, some stuck or skipped:** open the PR marked partial, listing the stuck and skipped issue numbers. Always pause, and don't start the next group until a person has dealt with them.
- **Nothing landed:** open no PR, and pause.

### Keeping up with the base branch

The base branch can move during a group. Before opening a group PR, the engine merges `origin/<base>` into the group branch and runs the gate. It does the same for a stacked group once the group below it has merged. A conflict produces `needs-human`.

Squash-merging a group PR makes these later merges conflict, because the stacked branch still holds the original commits. `README.md` recommends merge commits for group PRs, and `doctor` warns if the repo allows only squash merges.

### Feedback on a group PR is its own job

Jobs belong to issues, so `masna feedback` on a PR number creates a job `g<milestone>-f<k>`. It branches from the group branch, and the feedback is its acceptance criteria. It goes through the normal stages, including gate and reviewers, then squashes into the group branch and merges forward into later groups.

Feedback comes only from the operator, so PR comments aren't read automatically in 0.1. Feedback on a landed issue is refused, and the message names its group PR.

### Worktrees live inside the project

One worktree per group at `.masna/worktrees/<group>`, gitignored and reused between issues so dependencies aren't reinstalled. Staying inside the project avoids permission prompts for outside folders. Claude Code's `isolation: worktree` isn't used, because it starts from the default branch.

An earlier issue may have changed dependencies, so `setup.sh` runs at the start of every issue and must be safe to repeat. A new issue starts with a clean tree, keeping ignored files. A restarted builder keeps whatever the crashed one left.

`/masna:init` warns if a project's tools scan these folders.

### One shared preview per review round

If `.masna/preview.sh` exists, the engine starts it once per review round on a free port, passes the URL to UI and UX reviewers, and stops it afterwards. Without it, those reviewers read code only and must say the screens weren't checked.

### Public output is minimal

Many adopters will have public repos, and a security finding posted to an issue is a public disclosure. GitHub comments carry verdicts, commit and criteria only. **Findings, logs and agent text stay in `.masna/jobs/`.** Group PR bodies are limited in the same way.

### The dashboard only reads

`/masna:dashboard` opens a local page showing what's queued, blocked, being worked on, stuck and done, updating as the run moves. It has no controls: changes still go through `/masna:run` and `/masna:feedback`.

```text
Masna · run r7 ● running · last activity 4s ago        Group 3: Checkout · 3 of 7 landed
─────────────────────────────────────────────────────────────────────────────────────
Queued        Blocked          In progress      Stuck            Landed
#18 #20       #19 (needs #16)  #16 review       #14 max rounds   #11 #12 #13

#16 Add refund endpoint · round 2 · gate fixes 0
build ✓ → gate ✓ → review ● → approve → landing

reviewer-security   running   3m 12s   last tool: Bash, 6s ago
reviewer-code       PASS      a1b2c3d

11:42:07  gate passed       11:38:51  builder finished       11:21:03  reviewer-code: CHANGES
```

Selecting an issue shows its verdicts, findings and the end of its checks log. Other groups and their PR links are one click away.

**Where the data comes from.** Everything is built from files the engine already keeps, plus three small additions:

- `.masna/events.jsonl`: an append-only log. The engine adds a line for each stage move, verdict and gate result, and hooks add one when an agent starts, ends or uses a tool. Tool lines hold only the agent, tool name and time, never tool input, which could contain secrets.
- `.masna/queue.json`: the last list of issues and blockers from GitHub, written by `masna next`. The dashboard never calls `gh`, so watching can't use up API limits or slow the run.
- `lib/view.mjs`: one function turns these files into the view. `masna status` prints it, `masna status --json` returns it, and the dashboard serves it, so the three can't disagree.

**How it stays live.** `masna dashboard` starts a detached Node server using only `node:http`, records its port and process id in `.masna/dashboard.json`, and returns the URL. Every second it checks the size of the event log, and when it grows, it rebuilds the view and pushes it to the browser through server-sent events. The page is one static HTML file, with no build step or dependencies. Polling one file behaves the same on every OS, unlike recursive file watching.

**What keeps it from affecting the run:**

- Nothing in the loop depends on the dashboard, and the orchestrator never reads it or its data.
- The server never writes run state.
- Failing to write an event never fails a command or blocks a tool. The guard decides first, and a logging error is ignored.
- State files are written to a temp file and renamed, so a reader never sees half a file.

**It's honest about a dead run.** The header shows `running` only while the heartbeat is recent. Otherwise it shows `stalled`, `paused` with the reason, or `idle`. A crashed run must never look active.

**Security.** The page can show private findings, and it renders text an outsider may have written. So:

- It binds to `127.0.0.1` only, and refuses requests whose `Host` header isn't local, which stops DNS rebinding.
- The URL carries a random token created at start, and every request must present it.
- It accepts only `GET`, and sends no CORS headers.
- All issue and agent text is inserted as plain text, never as HTML, under a strict Content-Security-Policy.

### Issue text is data

Issue text reaches agents only through `issue.md`, quoted and marked as data, and only with comments from the issue's author and the operator. Prompts and `report` lines built by the engine never contain issue text, including titles. Only people with triage access can apply the queue label, so `README.md` tells them to read an issue before labelling it.

That review only protects the text the person read, and an author can edit the issue afterwards. So the engine compares the issue's edit time with the label event:

- `issue.md` holds only comments from before the label, plus later ones from people with write access.
- A body edited after the label by someone without write access moves the issue to `needs-human`, and it must be labelled again.
- `issue.md` is a snapshot taken when the job starts, and isn't refreshed during the job.

## 7. Safety

### Guard hook

Plugin agents ignore `hooks` and `permissionMode` in their frontmatter, so the guard is a plugin-level `PreToolUse` hook on `Bash|Edit|Write|NotebookEdit|mcp__.*`. Plugin hooks run wherever the plugin is enabled and fire inside subagents, so:

- It does nothing unless `.masna/config.json` exists in the project.
- It uses `agent_type` from the hook input to apply per-agent rules. Masna's agents and any custom reviewers in the config are always guarded.
- A session with no `agent_type` is guarded only while a run is active. Otherwise, adopting Masna would block a person's own `git push` in ordinary sessions.
- **It fails closed.** A hook that crashes with an ordinary error doesn't block the tool call, so the guard catches every error and exits 2.
- It resolves real paths first, following `..` and symlinks. Patterns in `protected_paths` and `never_touch` match relative to the worktree root, or the project root outside a worktree. Otherwise `.masna/**` would match the builder's entire worktree, which lives under `.masna/`.
- MCP tools are blocked for Masna's agents in 0.1. A connected GitHub MCP server could otherwise merge a PR without any Bash command.

| Who | Blocked |
|---|---|
| Everyone | Pushing the base branch, `gh pr merge`, force pushes, and commands listed in `blocked_commands` |
| Everyone | Writing to paths in `never_touch` |
| Builder | Writing to `protected_paths`, or outside its worktree and `build.md` |
| Reviewers, approver, finisher | Writing anything except their own output file |

Agents also get a `tools` list in their frontmatter, so reviewers have no `Edit` tool.

### Be honest about the limits

The guard is a safety net, not a sandbox. A determined script can get around pattern matching. `/masna:doctor` and the README recommend stronger layers:

- GitHub branch protection or rulesets on the base branch. `doctor` reports if it's missing, and notes that private repos on the free plan can't have it.
- Claude Code's sandboxing.
- A `gh` token with the narrowest access that works.

### Permissions for unattended runs

A prompt nobody answers stops the run, so the recommended mode is `claude --permission-mode dontAsk`, plus allow rules that `/masna:init` proposes in `.claude/settings.json`. Anything not allowed is denied, not left hanging, and the agent reports it. `bypassPermissions` is never recommended. Spike S3 confirms this works.

## 8. Layout

### This repo

```text
.claude-plugin/marketplace.json     marketplace "ljkart", lists plugins/masna
plugins/masna/
  .claude-plugin/plugin.json        name "masna", with a version
  skills/{init,run,status,feedback,doctor,dashboard}/SKILL.md
  agents/{builder,approver,finisher}.md
  agents/{reviewer-code,reviewer-security,reviewer-ui,reviewer-ux}.md
  hooks/hooks.json                  guard (PreToolUse), agent-started (SubagentStart), agent-ended (SubagentStop)
  bin/masna                         on the Bash PATH while enabled
  lib/*.mjs                         queue, state, gate, route, land, guard, github, events, view, dashboard
  dashboard/index.html              the dashboard page
test/                               unit and integration tests
docs/PLAN.md, docs/DESIGN.md
README.md, LICENSE
.github/workflows/ci.yml
```

The engine uses Node 22+ with no npm dependencies, and tests use `node --test`. Adopters need `node`, `git` and `gh`.

### A project using it

```text
.masna/
  config.json        committed
  checks.sh          committed: typecheck, tests, build, rule checks
  setup.sh           committed: prepare a fresh worktree
  preview.sh         committed, optional
  checklist.md       committed, optional: end-of-group tasks
  rules/*.md         committed: what each reviewer enforces here
  run.json           gitignored: current run id and heartbeat
  events.jsonl       gitignored: what happened, for the dashboard and the pilot's record
  queue.json         gitignored: last issue list from GitHub
  dashboard.json     gitignored: dashboard port, process id and token
  jobs/              gitignored
  worktrees/         gitignored
```

```json
{
  "base_branch": "main",
  "queue_label": "ready-for-agent",
  "needs_human_label": "masna:needs-human",
  "pause_after_group": true,
  "max_rounds": 3,
  "max_gate_fixes": 3,
  "gate_timeout_minutes": 30,
  "agent_timeout_minutes": 60,
  "reviewers": {
    "src/api/**": ["code", "security"],
    "src/web/**": ["code", "ui", "ux"],
    "**": ["code"]
  },
  "models": { "builder": "opus", "security": "opus", "approver": "opus", "code": "sonnet", "ui": "sonnet", "ux": "sonnet", "finisher": "sonnet" },
  "protected_paths": [".masna/**", ".claude/**", ".mcp.json", ".github/workflows/**", "**/CLAUDE.md", "**/AGENTS.md"],
  "never_touch": [],
  "blocked_commands": []
}
```

`models` takes aliases only (`sonnet`, `opus`, `haiku`, `fable`), because the Agent tool doesn't accept full model ids.

`CLAUDE.md` and `AGENTS.md` are protected because every agent reads them. A builder that edited them could give instructions to the reviewers judging its work.

## 9. Engine commands

| Command | Does |
|---|---|
| `masna begin [--takeover]` | Starts a run and returns its id, or refuses if another run is active |
| `masna next --run <id>` | Advances what scripts can, then returns the next action as JSON |
| `masna gate --job <id> --run <id>` | Runs setup and checks, and writes `checks.md`; `--baseline` checks a new group branch |
| `masna status [--json]` | Table of groups and issues; a stuck issue shows why |
| `masna dashboard [--port <n>] [--stop]` | Starts the detached dashboard server and prints its URL, or stops it |
| `masna feedback <n>` | Saves feedback from stdin and reopens the job, or creates one for a group PR |
| `masna doctor` | Checks tools, auth, config, labels, branch protection, merge settings and checks on base |
| `masna guard` | The `PreToolUse` hook entry point |
| `masna agent-started` | The `SubagentStart` hook entry point |
| `masna agent-ended` | The `SubagentStop` hook entry point |

Output is one line or small JSON, because detail belongs in files. `status` and `dashboard` are for people, and the orchestrator doesn't call them during a run.

## 10. Agents

Every agent writes one file, replies with one line, and reads the project's `CLAUDE.md` or `AGENTS.md`.

| Agent | Default model | Writes | Job |
|---|---|---|---|
| `builder` | opus | Code, `build.md` | Tests first, meets every criterion with evidence |
| `reviewer-security` | opus | `review-security.md` | Access control, input, data exposure, secrets, plus project rules |
| `reviewer-code` | sonnet | `review-code.md` | Correctness, scope, simplicity, weakened or skipped tests |
| `reviewer-ui` | sonnet | `review-ui.md` | Visual consistency, overflow, contrast, using the preview |
| `reviewer-ux` | sonnet | `review-ux.md` | Whether the flow works for its users, errors and empty states |
| `approver` | opus | `decision.md` | Spot-checks criteria, stops for business decisions |
| `finisher` | sonnet | `group.md` | End-of-group checklist and PR text |

Reviewer output format, with `CHANGES` only for blocking problems in this change:

```markdown
VERDICT: PASS | CHANGES
COMMIT: <sha>

## Summary
## Findings
## Notes
```

Non-blocking notes are collected into the group PR's private summary in `.masna/jobs/`. They never restart the loop.

## 11. Testing

| Level | How | Runs |
|---|---|---|
| Unit | Issue parsing, queue order, blocked-by chains and cycles, every legal and refused move, route patterns, verdicts holding across commits, guard table, guard failing closed, edits after labelling, the view at each stage including a stalled run | CI |
| Integration | Real git in temp repos, a fake `gh` on `PATH`, scripted fake agents writing files, the whole loop with no model calls | CI |
| Dashboard | Real server on a free port: updates reach the browser stream; wrong `Host`, missing token and non-`GET` requests are refused; a hostile issue title stays plain text | CI |
| Manifest | `claude plugin validate --strict` | CI |
| Reviewer evals | `claude plugin eval` with planted defects and clean diffs | By hand, since it uses tokens |
| End to end | A throwaway sandbox repo with a few real issues | By hand, before each release |

## 12. Milestones

Each one ends with a working result, and the next starts only when its exit test passes.

### M0: Repo and spikes

Add a README stub, CI, and an empty plugin that validates and installs. Then settle what the docs don't. "Docs" below is what the Claude Code docs said when this plan was reviewed against version 2.1.318; each spike still confirms it by testing.

| # | Question | Docs | If the answer is no |
|---|---|---|---|
| S1 | Is `bin/masna` on the Bash `PATH` inside background plugin agents? | On the Bash `PATH` while enabled; subagents not mentioned | Skills and agents get the full path through `${CLAUDE_PLUGIN_ROOT}` |
| S2 | Does the guard hook fire inside plugin agents, with `agent_type` as `masna:<name>`? | Yes, in the form `my-plugin:reviewer` | Stop: the safety design needs rethinking |
| S3 | Does `dontAsk` plus allow rules carry over to background agents, and do they keep `Bash`, `Edit` and `Write`? | Prompts from background agents surface in the main session; the mix with `dontAsk` isn't stated, and they get a smaller tool set | Test `auto`, or foreground agents |
| S4 | Can the Agent tool set a plugin agent's model? | Yes, aliases only | Fixed models in frontmatter for 0.1 |
| S6 | Does the orchestrator survive compaction mid-run, using only `masna next` and the run id it repeats? | Not covered | Shorten runs and rely on resume |
| S7 | Does a plugin's `hooks.json` receive `SubagentStart` and `SubagentStop` for plugin agents, including failed background ones? | The events exist; plugin registration isn't stated | The skill passes `--ended <type>` to `next` when an agent's completion notice arrives, and the dashboard shows the spawn time instead |
| S8 | Does background Bash wake the orchestrator when it exits, under `dontAsk`? | Not covered | `next` starts the gate as a detached process and the skill polls `next` on a delay |
| S9 | Does a guard exit code of 2 block MCP tools and `NotebookEdit` inside plugin agents? | Not covered | Deny those tools through permission rules from `/masna:init` |
| S10 | Can a skill start a detached local server that outlives the session, under `dontAsk` and with sandboxing on? | Not covered | The skill prints the exact command for the person to run in their own terminal |

S5 (a usable session id for skills) is dropped, because run ids replace it. The docs pages reviewed show no session id in Bash or skills.

**Exit:** install works from GitHub on a clean project, and each spike has a recorded answer in `docs/DESIGN.md`.

### M1: Engine, no models

Build the queue, state, runs, gate, routing, landing, group branches, guard, events, the view behind `masna status`, and `next`, tested with fake agents.

**Exit:** the integration test runs a group of five issues, including a failed gate, a changes-wanted round, a stuck issue with a skipped dependent, and a crash and resume, ending with the right commits, branch and PR calls. It also covers a crash during landing, a second `begin` while a run is active, an agent ending with no output, two such failures in a row pausing the run, and a failing baseline. `masna status --json` matches the expected view at each step.

### M2: Agents and skills

Write the agents, plus `/masna:run`, `status`, `feedback`, then run on the sandbox repo.

**Exit:** a real run finishes three dependent sandbox issues, with one forced fix round, and opens a correct group PR with no help. Interrupting and resuming it loses nothing.

### M3: Dashboard

Build the server, the page and `/masna:dashboard` on top of the view from M1. It comes before setup and the pilot, so those runs can be watched live and their problems seen.

**Exit:** watching a real sandbox run, the page shows each issue moving through its stages within two seconds of the change, including a forced fix round. Killing the run shows `stalled` within the heartbeat window. The same run with and without the dashboard open ends with the same commits and state files, and the dashboard tests pass in CI.

### M4: Setup

Write `/masna:init` and `/masna:doctor`. Init detects commands, drafts rules from the project's docs, shows everything before writing, and doesn't overwrite existing files.

**Exit:** on a project it has never seen, init followed by doctor passes, and the checks pass on the base branch.

### M5: Prove the reviewers

Build evals from planted defects: missing access check, data leak in a response, weakened test, missing error state, off-theme UI. Include clean diffs too.

**Exit:** each reviewer catches its planted defects and passes the clean diffs in repeated runs. Prompts are tuned from the misses, and the results are recorded.

### M6: Pilot

Run on a real private project: one issue first, then read everything it did. Then one full group, with all problems fixed in Masna and not worked around.

**Exit:** the group PR passes the owner's review. The record shows findings per reviewer, false alarms, rounds per issue, time and usage.

### M7: Release 0.1.0

Finish `README.md` (with safety limits and cost warnings up front) and `docs/DESIGN.md`. Scan the full history for private names and secrets, tag with `claude plugin tag`, and test install on a second, different project.

**Exit:** the second project runs an issue using only the README, and anything project-specific that surfaced is fixed.

## 13. Risks

| Risk | Response |
|---|---|
| Reviewers miss real bugs, or raise false alarms that burn rounds | M5 measures it, and people still review each group PR |
| Heavy usage, since a spend cap only exists in `--print` mode | Round limits, `maxTurns`, skipped reviewers, and usage measured in M6 |
| The loop lands bad work that later issues build on | Gate plus approver per issue, whole-group review, pause after the group |
| Usage limits or an outage mark good issues as stuck | Two agent failures in a row pause the run and use up no retries |
| A group PR is rejected, leaving its landed issues closed | Accepted for 0.1: they're closed by the engine with a comment naming the group branch, and a person reopens them |
| The guard gets bypassed | Documented as a safety net, with stronger layers recommended |
| Claude Code changes behaviour | Pin the minimum version, and re-run spikes as tests before each release |
| Private details reach this public repo | Fixtures are invented, and adopter details stay in adopters' repos; M7 scans the history |
| The dashboard exposes private findings or runs hostile text | Loopback only, token, `Host` check, plain-text rendering, strict CSP, all tested in CI |
| Agent activity makes the event log grow | One short line per tool call; a new log per run, keeping the last few |
| Security holes in other people's use | Public output rule, issue text as data, and a clear README warning |

## 14. After 0.1

Add these only when a real project needs them:

- One PR per issue
- Restart without a person through `claude -p`, which also allows `--max-budget-usd`
- Parallel builds for issues that don't overlap
- Dashboard controls, a view across several projects, or a shared or hosted version
- Token usage on the dashboard, read from agent transcripts
- Submitting to Anthropic's plugin directory

## 15. Decisions

Made:

1. **Licence:** MIT.
2. **Repo:** `ljkart/masna` is public and created.

Still needed:

3. **Sandbox repo for M2:** a small throwaway, public or private, to create when M2 starts.
4. **How `reviewer-ui` sees screens:** plugin agents can't declare MCP servers, and the guard blocks MCP tools. The proposed answer is a browser CLI run through Bash, such as `npx playwright screenshot`, with the images read back from the job folder.
