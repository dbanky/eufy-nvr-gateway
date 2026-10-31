import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { connectBridgeEvents } from '../../src/switcher/bridge-events.mjs';

function setup() {
  const bridge = new EventEmitter();
  const triggered = [];
  const garden = { name: 'garden', serial: 'T81XXXXXXXXXXXXX', triggers: ['motion', 'doorbellPress'], trigger: (k) => triggered.push(k) };
  connectBridgeEvents(bridge, [garden], () => {});
  return { bridge, garden, triggered };
}

test('a detection the camera listens for wakes it', () => {
  const { bridge, triggered } = setup();
  bridge.emit('device-event', { serial: 'T81XXXXXXXXXXXXX', event: 'motion', message: {} });
  assert.deepEqual(triggered, ['motion']);
});

test("a detection it doesn't listen for (see `triggers`) is ignored", () => {
  const { bridge, triggered } = setup();
  bridge.emit('device-event', { serial: 'T81XXXXXXXXXXXXX', event: 'petDetection', message: {} });
  assert.deepEqual(triggered, []);
});

test('events of devices that are not configured are ignored', () => {
  const { bridge, triggered } = setup();
  bridge.emit('device-event', { serial: 'T82XXXXXXXXXXXXX', event: 'motion', message: {} });
  assert.deepEqual(triggered, []);
});

test('battery levels and models are kept up to date', () => {
  const { bridge, garden } = setup();
  bridge.emit('device-event', { serial: 'T81XXXXXXXXXXXXX', event: 'batteryLevel', message: { to: '42' } });
  assert.equal(garden.battery, 42);
  bridge.emit('devices', [{ serial: 'T81XXXXXXXXXXXXX', model: 'T8170', battery: 41 }]);
  assert.equal(garden.model, 'T8170');
  assert.equal(garden.battery, 41);
});
