import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, motionMessages } from '../../src/onvif/event-messages.mjs';

test('durations: PT60S, PT1M, PT1H30M', () => {
  assert.equal(parseDuration('PT60S', 0), 60000);
  assert.equal(parseDuration('PT1M', 0), 60000);
  assert.equal(parseDuration('PT1H30M', 0), 5400000);
  assert.equal(parseDuration(null, 1234), 1234);
});

test('a motion change is one message per motion topic, with the time it changed', () => {
  const [cell, alarm] = motionMessages(true, Date.parse('2026-10-31T12:00:00Z'), 'Changed');
  assert.match(cell, /tns1:RuleEngine\/CellMotionDetector\/Motion/);
  assert.match(cell, /Name="IsMotion" Value="true"/);
  assert.match(alarm, /tns1:VideoSource\/MotionAlarm/);
  assert.match(alarm, /Name="State" Value="true"/);
  assert.match(cell, /UtcTime="2026-10-31T12:00:00.000Z" PropertyOperation="Changed"/);
});
