# Masna: design record

What was tested, and what it means for the design. The plan is in [PLAN.md](PLAN.md).

## M0 spikes

Tested on 2026-11-05 against Claude Code 2.1.318 on macOS, using `test/spikes/run.sh`. All runs used `claude -p`, so M2 confirms S3 and S8 in an interactive session.

| # | Question | Answer | Evidence |
|---|---|---|---|
| S1 | Is `bin/masna` on the Bash `PATH` inside background plugin agents? | **Yes** | A background agent ran the bare command `probe-bin` and got its output |
| S2 | Does the guard hook fire inside plugin agents, with `agent_type` as `masna:<name>`? | **Yes** | Each tool call logged `agent_type: probe:worker`, and exit 2 stopped `echo BLOCKME`. In the main session, `agent_type` is absent |
| S3 | Does `dontAsk` plus allow rules carry over to background agents, and do they keep `Bash`, `Edit` and `Write`? | **Yes**, once rules are loaded | Allowed `Bash`, `Edit` and `Write` calls ran. `touch`, which had no rule, was denied at once with no hang |
| S4 | Can the Agent tool set a plugin agent's model? | **Yes** | The worker has no model set. Asked for `haiku`, all 14 of its responses came from `claude-haiku-5-5` |
| S6 | Does the orchestrator survive compaction mid-run, using only `masna next` and the run id? | **Moved to M2** | Needs a real orchestrator |
| S7 | Does a plugin's `hooks.json` receive `SubagentStart` and `SubagentStop` for plugin agents, including failed background ones? | **Partly** | Both fire for a normal agent. An agent that failed with HTTP 404 fired `SubagentStart` but never `SubagentStop`, though the orchestrator was told it failed |
| S8 | Does background Bash wake the orchestrator when it exits, under `dontAsk`? | **Yes** | The main agent ended its turn during a 20-second command, then was woken and wrote `woke.txt` |
| S9 | Does a guard exit code of 2 block MCP tools and `NotebookEdit` inside plugin agents? | **Yes** | Both were blocked, with the hook's message returned to the agent |
| S10 | Can a skill start a detached local server that outlives the session, under `dontAsk` and with sandboxing on? | **Without sandboxing only** | Without it, the server still answered after Claude Code exited. With it, `listen` failed with `EPERM` |

## What the results changed

- **Failed agents (S7):** the hook can't be the only signal, so the orchestrator passes `--failed <type>` to `masna next`. Without this, an outage would look like a long wait until `agent_timeout_minutes`.
- **Trusted folders (S3):** on the first run, Claude Code printed `Ignoring 10 permissions.allow entries from .claude/settings.json: this workspace has not been trusted`, and then denied every tool call. Unattended runs need a folder that has been trusted, so `doctor` checks for it. The spikes passed their rules through `--settings` instead, because a throwaway folder is never trusted.
- **Sandboxing (S10):** the dashboard falls back to a command for the person's own terminal. Previews and tests that start a server hit the same limit, and M4 settles the recommended settings.
- **Agent tools (S3):** with no `tools` list, a background agent also has `Agent`, `SendMessage`, `WebFetch` and `WebSearch`, so every Masna agent needs an explicit list.

## M1: the engine

### What agents must write

The engine reads only these fields, and treats anything else as a missing file. M2's agents must follow this.

| Agent | File | Required fields |
|---|---|---|
| `builder` | `build.md` | `STATUS: READY` or `STATUS: BLOCKED`. Also needs a clean worktree and commits ahead of the group branch |
| Reviewers | `review-<name>.md` | `VERDICT: PASS` or `VERDICT: CHANGES`, and `COMMIT: <sha>` for the commit it reviewed |
| `approver` | `decision.md` | `DECISION: APPROVE`, `REJECT` or `DECISION-NEEDED`, and `COMMIT: <sha>` |
| `finisher` | `group.md` | `STATUS: READY` or `STATUS: BLOCKED`, and `COMMIT: <sha>` |

The engine passes each agent its paths in the prompt, in this form: `Job: 12. Job folder: <path>. Worktree: <path>. Round: 2. Commit: <sha>. Base: <branch>. Output: <path>.` A new builder finds the last round's work in `build.previous.md`, reviewer findings in `review-*.md`, the last gate result in `checks.md`, and the operator's words in `feedback.md`.

### Decisions made while building

- **PR text:** the plan had the finisher write it, but that would let agent text into a public PR. The engine writes it, using only issue numbers, commits and states.
- **Whole-group review:** the finisher does this in 0.1, after the group's checks pass. Running every reviewer over the whole group would be stronger but costs far more, so M6 can show whether it's needed.
- **Failures in a row:** a failed agent adds to a count, and two pause the run without using a retry. A new run resets the count. So an agent that's really broken costs one pause, then goes to `needs-human` on the next run, rather than holding up the queue for good.
- **Conflicts on group branches:** these pause the run and name the branch to fix by hand. Running again retries, and finds the merge already done.
- **Title edits:** renaming an issue after labelling counts as an edit, because the title reaches agents too.
- **Uncommitted work:** when a new job needs the worktree, anything a stuck job left uncommitted goes to `git stash`, not away.

### How the tests were checked

The integration tests use real git, a fake `gh` and scripted agents. To check they can fail, 18 deliberate breaks were made in the engine, each in its own copy, such as a guard that fails open or a landing that ignores its earlier commit. The tests caught all 18.

Against the real GitHub API, only read calls have been tried: milestones, issue and PR lists, permissions and the GraphQL query. Calls that change GitHub are first used for real in M2's sandbox run.

## M2: agents and skills

### Decisions made while building

- **Screens:** `reviewer-ui` and `reviewer-ux` run `npx playwright screenshot` and save to `<job folder>/screens/`, the one place besides their output file that the guard lets them write. Other reviewers, and custom ones, stay limited to their own file. The guard can't see where `npx` writes, so this location is a convention for that command and a rule for everything else.
- **Following `cd`:** an agent's Bash calls don't keep their folder, so most start with `cd <worktree> &&`. The guard now follows a `cd` within a command, because it resolved later writes against the session's folder before. That wrongly blocked `cd <worktree> && mkdir src/x`, and it let `cd .claude && echo x > settings.json` through from inside a worktree. A `cd` it can't follow, such as `cd "$X"`, blocks later writes by agents.
- **Builder's base:** the builder's prompt now names `Base`, so it can find earlier rounds' commits with `git log <Base>..HEAD`.
- **Reopened issues:** the builder's instructions name `feedback.md`, so feedback on a reopened issue reaches it, though its prompt only names `issue.md`.
- **Rules are for reviewers:** the builder isn't pointed at `.masna/rules/`. The sandbox uses this to force a fix round: a house rule that only the reviewer knows. M6 can show whether builders should read them too, to save rounds.

### What the first real run found

The builder was denied Bash on its first command and stopped as blocked. Tested in a background plugin agent under `dontAsk`, with every part of the command allowed, on Claude Code 2.1.318:

| Command | Result |
|---|---|
| `cd <worktree> && git log` | Denied |
| `cd <worktree> && git add -A && git commit ...` | Denied |
| `cd <worktree> && ls ... \| head` | Allowed |
| `cd <worktree> && npm test` | Allowed |
| `git -C <worktree> log`, `add`, `commit` | Allowed |

So any one command holding both `cd` and `git` is denied, whatever the allow rules say, and the message blames Bash as a whole. The builder's instructions had told it to start every command with `cd`. Agents now use `git -C <Worktree>`, and a test keeps it that way. They also split a denied command and try again before reporting it as blocked. Don't answer this with a blanket `Bash` allow rule: `/masna:init` should keep proposing narrow rules.

### What the second real run found

All three issues landed, with #1 taking the forced fix round, and then the finisher blocked the group. No PR opened, so this run doesn't meet the exit test. It did confirm S3 and S8 in an interactive session: background agents used `Bash`, `Write` and `Edit` under `dontAsk` with narrow allow rules, and background gate commands woke the orchestrator. S6 is still open, because nobody typed `/compact`.

| What happened | Why | What changed |
|---|---|---|
| 20 of 77 agent Bash calls were denied, and two approvers skipped the tests they'd been told to run | Every denied call held `cd`, and none without one was denied. `cd` beside `..` or a write is refused too, not just beside `git`. Instructions alone didn't stop it | The guard refuses those calls for agents and says what to send instead, so an agent no longer reads it as Bash being off. Agents use absolute paths, and `cd` only for a project command alone in its call |
| #2 landed breaking a project rule | The reviewer's only look for the rules was inside a denied command, and it never tried again | The engine names the rules file in the reviewer's prompt |
| Two reviewers ended with their review as a reply and no file, which paused the run | Instructions alone again. The pause blamed a possible outage | A `SubagentStop` check sends an agent back once if its output is missing, stale or has no valid header. Tested with a real background plugin agent |
| The finisher's block had no way out | Feedback on a landed issue pointed at a group PR that didn't exist, and running again read the same result | Feedback on any landed issue in a blocked group becomes a group job. Its commit brings a fresh gate and finisher, then the PR |

The denial data covers one run, and the exact rule inside Claude Code isn't known: one call with `cd` and `../..` was allowed. The guard refuses that shape anyway, which costs an agent one retry.

An agent that ends with no valid output still counts towards the pause meant for outages. The check makes this rare, so that stays as it is until a run shows otherwise.

### The sandbox

`test/sandbox/create.sh <folder>` builds `ljkart/masna-sandbox` from `test/sandbox/project/` and `test/sandbox/issues/`: three dependent issues routed to all four reviewers, the two labels, and a hand-written `.masna/`, because `/masna:init` is M4. It refuses to touch a repo that already exists.

`test/sandbox/reset.sh <clone>` puts the sandbox back to the start for another try, without deleting the repo.

`node test/sandbox/smoke.mjs <owner/repo>` drives the engine against the real GitHub API with scripted agents and no model calls, then removes what it created. It takes a stuck issue through a partial PR, feedback and an edit of that PR. It passed on 2026-11-05, the first real use of the calls that change GitHub.
