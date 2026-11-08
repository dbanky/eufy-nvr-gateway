import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLoginGuard, clientAddress } from '../../src/security/login-guard.mjs';

function guardAt(start = 1_000_000) {
  const clock = { t: start };
  const logged = [];
  const guard = createLoginGuard({ maxFailures: 3, windowMs: 60_000, blockMs: 120_000, now: () => clock.t, log: (m) => logged.push(m) });
  return { guard, clock, logged };
}

describe('the login guard', () => {
  test('blocks an address after too many wrong logins, and says so once', () => {
    const { guard, logged } = guardAt();
    guard.failed('192.168.1.20', 'web page');
    guard.failed('192.168.1.20', 'RTSP');
    assert.equal(guard.blocked('192.168.1.20'), false);
    guard.failed('192.168.1.20', 'ONVIF');
    assert.equal(guard.blocked('192.168.1.20'), true);
    assert.equal(guard.retryAfterS('192.168.1.20'), 120);
    assert.deepEqual(logged, ['Security: 3 wrong logins from 192.168.1.20 (last: ONVIF): refusing its logins for 2 min']);
  });

  test('forgets wrong logins older than the window', () => {
    const { guard, clock } = guardAt();
    guard.failed('192.168.1.20', 'web page');
    guard.failed('192.168.1.20', 'web page');
    clock.t += 61_000;
    guard.failed('192.168.1.20', 'web page');
    assert.equal(guard.blocked('192.168.1.20'), false);
  });

  test('lets the address in again when the block is over', () => {
    const { guard, clock } = guardAt();
    for (let i = 0; i < 3; i++) guard.failed('192.168.1.20', 'RTSP');
    clock.t += 120_001;
    assert.equal(guard.blocked('192.168.1.20'), false);
    guard.failed('192.168.1.20', 'RTSP');   // a fresh count, not blocked again at once
    assert.equal(guard.blocked('192.168.1.20'), false);
  });

  test('keeps addresses apart, and IPv4-mapped IPv6 is the same address', () => {
    const { guard } = guardAt();
    for (let i = 0; i < 3; i++) guard.failed('::ffff:192.168.1.20', 'RTSP');
    assert.equal(guard.blocked('192.168.1.20'), true);
    assert.equal(guard.blocked('192.168.1.21'), false);
    assert.equal(clientAddress('::ffff:10.0.0.1'), '10.0.0.1');
  });
});
