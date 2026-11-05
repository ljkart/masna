// Stops the current `masna next` and tells the orchestrator to pause, with the reason.
export class PauseError extends Error {}

// A network or GitHub failure. It pauses the run and never blames the issue.
export class InfraError extends PauseError {}
