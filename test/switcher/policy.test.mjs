import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CAMERA_DEFAULTS, decideTrigger, stopReason, deadlineWhenLive, shouldReconnect } from '../../src/switcher/policy.mjs';

const now = 1_000_000;
const asleep = { ...CAMERA_DEFAULTS, state: 'IDLE', battery: 80, lastStop: 0, deadline: 0 };

describe('a trigger', () => {
  test('wakes a sleeping camera for the hold time', () => {
    assert.deepEqual(decideTrigger(asleep, 'motion', now), { action: 'wake', holdUntil: now + 120000 });
  });

  test('a doorbell press holds for ringHoldMs instead', () => {
    assert.equal(decideTrigger({ ...asleep, ringHoldMs: 300000 }, 'doorbellPress', now).holdUntil, now + 300000);
  });

  test('extends a session that is already running, never shortens it', () => {
    const live = { ...asleep, state: 'LIVE', deadline: now + 500000 };
    assert.deepEqual(decideTrigger(live, 'motion', now), { action: 'extend', holdUntil: now + 500000 });
    assert.deepEqual(decideTrigger({ ...live, deadline: now + 1000 }, 'motion', now), { action: 'extend', holdUntil: now + 120000 });
  });

  test('is ignored below the battery limit…', () => {
    assert.deepEqual(decideTrigger({ ...asleep, battery: 10 }, 'motion', now), { action: 'ignore', reason: 'battery 10%' });
  });

  test('…and right after a session ended (restart gap)', () => {
    assert.deepEqual(decideTrigger({ ...asleep, lastStop: now - 5000 }, 'personDetected', now), { action: 'ignore', reason: 'restart gap' });
  });

  test('a doorbell press and a manual request ignore both limits', () => {
    const tired = { ...asleep, battery: 5, lastStop: now - 1000 };
    assert.equal(decideTrigger(tired, 'doorbellPress', now).action, 'wake');
    assert.equal(decideTrigger(tired, 'manual', now).action, 'wake');
  });
});

describe('a session ends', () => {
  const session = { ...asleep, sessionStart: now - 1000, liveStart: now - 1000, deadline: now + 60000 };

  test('when the camera sends no picture within firstFrameTimeoutMs', () => {
    assert.equal(stopReason({ ...session, state: 'WAKING', sessionStart: now - 61000 }, now), 'no video from camera');
  });

  test('when the hold time is over', () => {
    assert.equal(stopReason({ ...session, state: 'LIVE', deadline: now - 1 }, now), 'hold time over');
  });

  test('at the hard cap, however often it was extended', () => {
    assert.equal(stopReason({ ...session, state: 'LIVE', liveStart: now - 121000, deadline: now + 999999 }, now), 'max live time');
  });

  test('otherwise it keeps going', () => {
    assert.equal(stopReason({ ...session, state: 'LIVE' }, now), null);
    assert.equal(stopReason(asleep, now), null);
  });
});

describe('timing details', () => {
  test('the hold time counts from the first live frame, not from the trigger: waking can take a minute', () => {
    const woke = { ...asleep, deadline: now + 120000 };
    assert.equal(deadlineWhenLive(woke, now + 45000), now + 165000);
  });

  test('a dropped feed is re-opened only within the session and up to maxReconnects', () => {
    const live = { ...asleep, deadline: now + 1000, reconnects: 0 };
    assert.equal(shouldReconnect(live, now), true);
    assert.equal(shouldReconnect({ ...live, reconnects: 2 }, now), false);
    assert.equal(shouldReconnect({ ...live, deadline: now - 1 }, now), false);
  });
});
