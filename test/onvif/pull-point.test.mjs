import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Subscription } from '../../src/onvif/pull-point.mjs';

describe('a PullPoint subscription', () => {
  test('a pull gets what is waiting at once, up to its limit', async () => {
    const sub = new Subscription('a', 0);
    sub.deliver(['1', '2', '3']);
    assert.deepEqual(await sub.wait(60000, 2), ['1', '2']);
    assert.deepEqual(await sub.wait(60000, 2), ['3']);
  });

  test('a waiting pull is answered when messages arrive', async () => {
    const sub = new Subscription('a', 0);
    const waiting = sub.wait(60000, 10);
    sub.deliver(['motion']);
    assert.deepEqual(await waiting, ['motion']);
  });

  test('a second pull answers the first (one pull at a time); closing answers the last', async () => {
    const sub = new Subscription('a', 0);
    const first = sub.wait(60000, 10);
    const second = sub.wait(60000, 10);
    assert.deepEqual(await first, []);
    sub.close();
    assert.deepEqual(await second, []);
  });

  test('keeps only the newest 50 messages for a client that stopped pulling', async () => {
    const sub = new Subscription('a', 0);
    sub.deliver(Array.from({ length: 60 }, (_, i) => String(i)));
    const kept = await sub.wait(0, 100);
    assert.equal(kept.length, 50);
    assert.equal(kept[0], '10');
  });
});
