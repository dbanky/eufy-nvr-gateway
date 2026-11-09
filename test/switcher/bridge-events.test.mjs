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

test('a station reporting a new Eufy mode makes the gateway read the device list again', async () => {
  const { EventEmitter } = await import('node:events');
  const { connectBridgeEvents } = await import('../../src/switcher/bridge-events.mjs');
  const bridge = new EventEmitter();
  let refreshed = 0;
  bridge.refreshDevices = () => { refreshed++; };
  connectBridgeEvents(bridge, [], () => {});
  bridge.emit('device-event', { serial: 'CHIME', event: 'armingModeChanged', message: {} });   // a chime: no camera
  assert.equal(refreshed, 1);
});

test('the device list gives each camera its Eufy mode, also one set on its chime', () => {
  const bridge = new EventEmitter();
  bridge.refreshDevices = () => {};
  const garden = { serial: 'GARDEN' }, door = { serial: 'DOOR' }, shed = { serial: 'SHED' };
  connectBridgeEvents(bridge, [garden, door, shed], () => {});
  bridge.emit('devices', [
    { serial: 'GARDEN', station: 'GARDEN', arming: true, eufyMode: 'disarmed' },
    { serial: 'DOOR', station: 'CHIME', arming: false },
    { serial: 'CHIME', station: 'CHIME', arming: true, eufyMode: 'home' },
  ]);
  assert.deepEqual([garden.eufyMode, door.eufyMode, shed.eufyMode], ['disarmed', 'home', null]);
});
