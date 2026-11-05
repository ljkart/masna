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

The engine passes each agent its paths in the prompt, in this form: `Job: 12. Job folder: <path>. Worktree: <path>. Round: 2. Commit: <sha>. Base: <branch>. Output: <path>.` A new builder finds the last round's work in `build.previous.md`, and reviewer findings in `review-*.md`.

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
