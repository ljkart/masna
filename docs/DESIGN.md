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
