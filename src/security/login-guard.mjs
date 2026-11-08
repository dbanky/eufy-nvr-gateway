// Slows down password guessing: one guard for every login the gateway checks (the web page and its
// API, RTSP, ONVIF). After `maxFailures` wrong logins from one address within `windowMs`, logins
// from that address are refused for `blockMs`, the right password included, so guessing stops.
//
// Only a wrong password counts, never a request without one: RTSP and ONVIF clients first ask
// without a login, get the challenge, then log in, and a working NVR must never be locked out.
// An expired Digest nonce or a clock that is off doesn't count either.

export const MAX_FAILURES = 10;
export const WINDOW_MS = 5 * 60_000;
export const BLOCK_MS = 5 * 60_000;
const MAX_TRACKED = 10_000;   // addresses remembered at most, so a flood can't eat memory

export function createLoginGuard({ maxFailures = MAX_FAILURES, windowMs = WINDOW_MS, blockMs = BLOCK_MS, now = Date.now, log = () => {} } = {}) {
  const clients = new Map();   // address -> { failures: [times], blockedUntil }

  const entry = (address) => {
    let client = clients.get(address);
    if (!client) {
      if (clients.size >= MAX_TRACKED) clients.delete(clients.keys().next().value);   // the oldest
      client = { failures: [], blockedUntil: 0 };
      clients.set(address, client);
    }
    return client;
  };

  return {
    // Whether logins from this address are refused right now.
    blocked(address) {
      const client = clients.get(clientAddress(address));
      return !!client && client.blockedUntil > now();
    },
    // Seconds until a blocked address may log in again.
    retryAfterS(address) {
      const client = clients.get(clientAddress(address));
      return client ? Math.max(0, Math.ceil((client.blockedUntil - now()) / 1000)) : 0;
    },
    // A wrong password from this address (`what`: which login, for the log).
    failed(address, what) {
      const key = clientAddress(address);
      const client = entry(key);
      const t = now();
      client.failures = client.failures.filter((at) => t - at < windowMs);
      client.failures.push(t);
      if (client.failures.length >= maxFailures && client.blockedUntil <= t) {
        client.blockedUntil = t + blockMs;
        client.failures = [];
        log(`Security: ${maxFailures} wrong logins from ${key} (last: ${what}): refusing its logins for ${Math.round(blockMs / 60_000)} min`);
      }
    },
  };
}

// "::ffff:192.168.1.5" and "192.168.1.5" are the same client.
export const clientAddress = (address) => String(address ?? 'unknown').replace(/^::ffff:/, '');

// For code that may run without a guard (tests, tools): never blocks, counts nothing.
export const noGuard = { blocked: () => false, retryAfterS: () => 0, failed: () => {} };
