import { connect } from 'node:net';

// Resolves true once something listens on 127.0.0.1:port, or false after timeoutMs, so a broken
// service can't block the ones after it.
export function waitForPort(port, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => (Date.now() > until ? resolve(false) : setTimeout(attempt, 250)));
    };
    attempt();
  });
}
