import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, motionEvents, notificationMessage } from '../../src/onvif/event-messages.mjs';

test('durations: PT60S, PT1M, PT1H30M', () => {
  assert.equal(parseDuration('PT60S', 0), 60000);
  assert.equal(parseDuration('PT1M', 0), 60000);
  assert.equal(parseDuration('PT1H30M', 0), 5400000);
  assert.equal(parseDuration(null, 1234), 1234);
});

test('a motion change is one message per motion topic, with the time it changed', () => {
  const [cell, alarm] = motionEvents(true, Date.parse('2026-10-31T12:00:00Z'), 'Changed').map((e) => notificationMessage(e));
  assert.match(cell, /tns1:RuleEngine\/CellMotionDetector\/Motion/);
  assert.match(cell, /Name="IsMotion" Value="true"/);
  assert.match(alarm, /tns1:VideoSource\/MotionAlarm/);
  assert.match(alarm, /Name="State" Value="true"/);
  assert.match(cell, /UtcTime="2026-10-31T12:00:00.000Z" PropertyOperation="Changed"/);
});

test('a pushed message names its subscription and producer, in the schema\'s order', () => {
  const [e] = motionEvents(false, 0, 'Initialized');
  const xml = notificationMessage(e, { subscription: 'http://x/onvif/subscription/1', producer: 'http://x/onvif/events_service' });
  assert.match(xml, /^<wsnt:NotificationMessage><wsnt:SubscriptionReference><wsa:Address>http:\/\/x\/onvif\/subscription\/1<\/wsa:Address><\/wsnt:SubscriptionReference><wsnt:Topic /);
  assert.match(xml, /<\/wsnt:Topic><wsnt:ProducerReference><wsa:Address>http:\/\/x\/onvif\/events_service<\/wsa:Address><\/wsnt:ProducerReference><wsnt:Message>/);
});

test('events carry their items for message content filters', () => {
  const [cell] = motionEvents(true, 0, 'Changed');
  assert.deepEqual(cell.items.find((i) => i.name === 'IsMotion'), { kind: 'SimpleItem', name: 'IsMotion', value: 'true' });
});
