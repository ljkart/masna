---
description: Send a stuck issue or an open group PR back for more work.
disable-model-invocation: true
argument-hint: <issue or PR number> <what to change>
allowed-tools: Bash(masna feedback *)
---

The person wrote: $ARGUMENTS

The first word is the target: an issue number, a group PR number, or a job id such as `g1-f1`. The rest is the feedback. If either is missing, ask for it, and stop there.

Pass the feedback exactly as written, through a quoted heredoc so the shell leaves it alone:

```bash
masna feedback <target> <<'MASNA_FEEDBACK'
<the feedback>
MASNA_FEEDBACK
```

Show the line it prints. A failure explains why it was refused, so show that as it is. Feedback waits for the next run, so tell the person `/masna:run` picks it up.
