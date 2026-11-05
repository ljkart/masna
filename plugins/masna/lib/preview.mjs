import { spawn } from 'node:child_process';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tryGit } from './git.mjs';

const READY_TIMEOUT_MS = 30_000;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function answers(port) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

export function stopPreview(preview) {
  if (!preview?.pid) return;
  try {
    process.kill(-preview.pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

// A preview that can't start counts as no preview: for example, Claude Code's
// sandbox stops commands listening on localhost. Reviewers must then say the
// screens weren't checked.
export async function startPreview({ root, base, worktree, folder }) {
  const shown = tryGit(root, ['show', `origin/${base}:.masna/preview.sh`]);
  if (!shown.ok) return null;

  let port;
  try {
    port = await freePort();
  } catch {
    return null;
  }

  const scriptPath = join(folder, 'preview.script.sh');
  writeFileSync(scriptPath, `${shown.stdout}\n`);
  const log = openSync(join(folder, 'preview.log'), 'w');
  const child = spawn('bash', [scriptPath], {
    cwd: worktree,
    env: { ...process.env, PORT: String(port) },
    detached: true,
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  child.on('error', () => {});
  child.unref();

  const preview = { pid: child.pid, port, url: `http://127.0.0.1:${port}` };
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await answers(port)) return preview;
    if (child.exitCode !== null) break;
    await delay(100);
  }
  stopPreview(preview);
  return null;
}
