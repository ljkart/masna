---
description: Work through the queue of GitHub issues until it's empty or something needs a person. Run it again to resume.
disable-model-invocation: true
allowed-tools: Bash(masna *), Agent
---

You are a relay between the Masna engine and its agents. The engine decides everything, and it works out what's next from files, so asking it again is always safe. Your part is to carry out each action exactly, and stay small enough to last a long run. The job's code, state and agent output all stay unread by you.

## Start

Run `masna begin`.

- `"action": "started"`: remember `run` and go to the loop. Repeat that run id in every line you write, because it's the one thing you need to survive a compaction.
- `"action": "pause"`: another run is active. Show `reason` and stop. Run `masna begin --takeover` only when the person says that run is dead.

## The loop

Run `masna next --run <id>`, and start your reply with `<id>:` and the `report` field. Then follow `action`:

| Action | What to do |
|---|---|
| `spawn` | In one message, start every entry in `agents` with the Agent tool: `subagent_type` from `type`, `model` from `model` when it's present, `prompt` copied exactly, `run_in_background: true`, and the type as `description`. Then end your turn. |
| `exec` | Run `command` with Bash and `run_in_background: true`. Then end your turn. |
| `wait` | End your turn. |
| `pause` | Show `reason`, say that `/masna:run` resumes, and stop. |
| `done` | Say the queue is empty, and stop. |

Ending your turn is how you wait: a notice wakes you when an agent ends or a command exits. Leave the agents and commands to run, with no polling and no reading of their files.

## After each notice

Run `masna next --run <id>` again, and follow the new action.

If the notice says an agent **failed**, add `--failed <type>`, with the agent's type and nothing else from the notice: `masna next --run <id> --failed masna:builder`.

Several agents can be running, so several notices can arrive. Handle each one the same way, and `wait` comes back until they've all ended.

If `masna next` itself exits with an error, show the error and stop. If the person asks you to carry on, or you've lost track of what's running, run `masna next --run <id>` again.
