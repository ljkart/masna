# Masna: design record

What was tested, and what it means for the design. The plan is in [PLAN.md](PLAN.md).

## M0 spikes

Tested against Claude Code 2.1.318. Results come from running `test/spikes/`, unless noted.

| # | Question | Answer | Evidence |
|---|---|---|---|
| S1 | Is `bin/masna` on the Bash `PATH` inside background plugin agents? | Not tested yet | |
| S2 | Does the guard hook fire inside plugin agents, with `agent_type` as `masna:<name>`? | Not tested yet | |
| S3 | Does `dontAsk` plus allow rules carry over to background agents, and do they keep `Bash`, `Edit` and `Write`? | Not tested yet | |
| S4 | Can the Agent tool set a plugin agent's model? | Not tested yet | |
| S6 | Does the orchestrator survive compaction mid-run, using only `masna next` and the run id? | Not tested yet | |
| S7 | Does a plugin's `hooks.json` receive `SubagentStart` and `SubagentStop` for plugin agents, including failed background ones? | Not tested yet | |
| S8 | Does background Bash wake the orchestrator when it exits, under `dontAsk`? | Not tested yet | |
| S9 | Does a guard exit code of 2 block MCP tools and `NotebookEdit` inside plugin agents? | Not tested yet | |
| S10 | Can a skill start a detached local server that outlives the session, under `dontAsk` and with sandboxing on? | Not tested yet | |
