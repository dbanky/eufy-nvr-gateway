import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTimeFormat } from '../../src/switcher/time-format.mjs';

const time = createTimeFormat('Europe/London');
const now = Date.parse('2026-10-30T20:00:00Z');                  // Friday 20:00 in London (GMT)
const at = (iso) => Date.parse(iso);

describe('"Sleeping since …"', () => {
  test('today: just the time', () => {
    assert.equal(time.since(at('2026-10-30T18:33:00Z'), now), 'since 18:33');
  });

  test('yesterday: says so', () => {
    assert.equal(time.since(at('2026-10-29T22:10:00Z'), now), 'since yesterday 22:10');
  });

  test('earlier this week: the weekday', () => {
    assert.equal(time.since(at('2026-10-26T22:10:00Z'), now), 'since Mon 22:10');
  });

  test('a week or more ago: the date only', () => {
    assert.equal(time.since(at('2026-10-12T09:00:00Z'), now), 'since 12 Oct');
  });

  test('"yesterday" is decided in the camera\'s time zone, not UTC', () => {
    // 23:30 UTC on the 29th is already the 30th in Budapest (UTC+1)
    const budapest = createTimeFormat('Europe/Budapest');
    assert.equal(budapest.since(at('2026-10-29T23:30:00Z'), now), 'since 00:30');
  });
});

describe('clock times', () => {
  test('24-hour, in the time zone', () => {
    assert.equal(time.hm(at('2026-10-30T18:05:09Z')), '18:05');
    assert.equal(time.hms(at('2026-10-30T18:05:09Z')), '18:05:09');
  });
});
