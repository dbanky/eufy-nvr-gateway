// Runs the bundled services as child processes: prefixes their log lines with the service name
// and restarts them when they exit, backing off when one keeps crashing.

import { spawn as nodeSpawn } from 'node:child_process';

// Delay before restarting a service that just exited. A service that ran for a minute gets a
// quick restart; one that crashes right away waits twice as long each time, up to 30 s.
export function restartDelay(uptimeMs, previousDelayMs) {
  if (uptimeMs > 60000) return 1000;
  return Math.min(previousDelayMs * 2, 30000);
}

// Calls onLine for every complete, non-empty line written to a stream.
export function lineSplitter(onLine) {
  let rest = '';
  return (chunk) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop();
    for (const line of lines) if (line.trim()) onLine(line);
  };
}

export class Supervisor {
  constructor({ log, spawn = nodeSpawn, env = process.env, stdout = process.stdout, stderr = process.stderr }) {
    Object.assign(this, { log, spawn, env, stdout, stderr });
    this.children = new Map();
    this.stopping = false;
  }

  // service: { name, cmd, args, cwd, env }
  run(service, delayMs = 1000) {
    const started = Date.now();
    const child = this.spawn(service.cmd, service.args, {
      cwd: service.cwd, env: { ...this.env, ...service.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.children.set(service.name, child);
    child.stdout.on('data', lineSplitter((l) => this.stdout.write(`[${service.name}] ${l}\n`)));
    child.stderr.on('data', lineSplitter((l) => this.stderr.write(`[${service.name}] ${l}\n`)));
    child.on('error', (e) => this.log(`${service.name} failed to start: ${e.message}`));
    child.on('exit', (code, signal) => {
      this.children.delete(service.name);
      if (this.stopping) return;
      const next = restartDelay(Date.now() - started, delayMs);
      this.log(`${service.name} exited (${signal ?? code}), restarting in ${next / 1000} s`);
      setTimeout(() => this.run(service, next), next);
    });
  }

  // SIGTERM everything, exit once all children are gone (or after 5 s).
  shutdown(exit = process.exit) {
    if (this.stopping) return;
    this.stopping = true;
    this.log('stopping…');
    for (const child of this.children.values()) child.kill('SIGTERM');
    setTimeout(() => exit(0), 5000).unref();
    const wait = setInterval(() => {
      if (this.children.size) return;
      clearInterval(wait);
      exit(0);
    }, 100);
  }
}
