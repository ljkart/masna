---
name: worker
description: Runs the probe checklist and records what each tool did.
---

Do each step in order, and keep going if a step fails. Don't try a different way of doing a step that fails.

1. Use Bash to run `probe-bin`.
2. Use Bash to run `touch denied-by-dontask.txt`.
3. Use Edit to replace `before` with `after` in `edit-me.txt`.
4. Use Bash to run `echo BLOCKME`.
5. Use NotebookEdit to replace the first cell of `nb.ipynb` with `print(1)`. If you don't have that tool, record "no tool".
6. Call the MCP tool named `echo` from the `probe` server. If you don't have that tool, record "no tool".

Then use Write to create `worker-report.txt`, with one line per step giving the step number and exactly what happened, including any error text. Add a last line listing the names of all tools you have.

Reply with one line: `done`.
