# Masna

Masna (Arabic for "factory") is a Claude Code plugin that turns a queue of GitHub issues into reviewed code. It takes one issue at a time, builds it, runs the project's checks, reviews it from several angles in parallel, fixes what the reviewers find, and moves on until the queue is empty.

**Status: not ready to use.** The engine is built and tested without any model calls, but the agents and skills that use it aren't written yet. See [the build plan](docs/PLAN.md) and [the recorded design answers](docs/DESIGN.md).

## Install

```bash
claude plugin marketplace add ljkart/masna
claude plugin install masna@ljkart --scope project
```

## Credits

The software-factory pattern is common. One public example, [zazencodes/zazencodes-season-3](https://github.com/zazencodes/zazencodes-season-3), informed this design. No code or text from it is used here.

## Licence

[MIT](LICENSE)
