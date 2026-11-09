import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { eufyModeName, eufyModeLabel, stationFor, eufyModeOf, setEufyMode, noteEufyMode, eufyModeMemory } from '../../src/switcher/eufy-mode.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toDevice } from '../../src/switcher/bridge/client.mjs';

// A standalone camera (its own station), and a doorbell behind its chime.
const devices = [
  { serial: 'GARDEN', name: 'Garden', station: 'GARDEN', arming: true, eufyMode: 'away' },
  { serial: 'DOOR', name: 'Doorbell', station: 'CHIME', arming: false, eufyMode: null },
  { serial: 'CHIME', name: 'Chime', station: 'CHIME', arming: true, eufyMode: 'home' },
  { serial: 'ORPHAN', name: 'Indoor', station: 'GONE', arming: false },
];

describe('Eufy modes', () => {
  test('a station reports a number; the SDK names it', () => {
    assert.deepEqual([0, 1, 2, 3, 6, 47, 63].map(eufyModeName), ['away', 'home', 'schedule', 'custom1', 'off', 'geo', 'disarmed']);
    assert.equal(eufyModeName('63'), 'disarmed');
    assert.equal(eufyModeName('home'), 'home');
    assert.equal(eufyModeName(undefined), null);
    assert.equal(eufyModeName(99), null);
    assert.equal(eufyModeLabel('custom1'), 'Custom 1');
  });

  test('a camera\'s mode is its own, or its HomeBase\'s or chime\'s', () => {
    assert.equal(stationFor('GARDEN', devices).serial, 'GARDEN');
    assert.equal(stationFor('DOOR', devices).serial, 'CHIME');
    assert.equal(stationFor('ORPHAN', devices), null);
    assert.equal(stationFor('UNKNOWN', devices), null);
    assert.deepEqual(eufyModeOf('DOOR', devices), { mode: 'home', label: 'Home', station: { serial: 'CHIME', name: 'Chime' }, shared: true });
    assert.equal(eufyModeOf('GARDEN', devices).shared, false);
  });

  test('switching sends the SDK\'s armingMode to the station, and reads the list again', async () => {
    const sent = [];
    const later = [];
    const bridge = { devices: structuredClone(devices), request: async (m) => { sent.push(m); return { ok: true }; }, refreshDevices: () => {} };
    const logged = [];
    const station = await setEufyMode({ bridge, serial: 'DOOR', mode: 'disarmed', name: 'front-door', log: (...m) => logged.push(m.join(' ')), schedule: (fn, ms) => later.push(ms) });
    assert.equal(station.serial, 'CHIME');
    assert.deepEqual(sent, [{ cmd: 'device.set', sn: 'CHIME', name: 'armingMode', value: 'disarmed' }]);
    assert.equal(eufyModeOf('DOOR', bridge.devices).mode, 'disarmed');
    assert.deepEqual(later, [5000, 20000]);
    assert.deepEqual(logged, ['front-door Eufy mode Disarmed (on Chime)']);
  });

  test('refuses an unknown mode, an unknown station, and passes on eufy\'s refusal', async () => {
    const bridge = { devices, request: async () => ({ ok: false, error: 'station offline' }), refreshDevices: () => {} };
    await assert.rejects(setEufyMode({ bridge, serial: 'GARDEN', mode: 'party' }), /must be one of "away", "home", "schedule"/);
    await assert.rejects(setEufyMode({ bridge, serial: 'ORPHAN', mode: 'home' }), /not known yet/);
    await assert.rejects(setEufyMode({ bridge, serial: 'GARDEN', mode: 'home', schedule: () => {} }), /station offline/);
  });
});

test('the device list says each device\'s station, whether it has modes, and its mode', () => {
  assert.deepEqual(toDevice({ sn: 'GARDEN', name: 'Garden', capabilities: ['camera', 'arming'], state: { armingMode: 63 } }),
    { serial: 'GARDEN', name: 'Garden', model: undefined, modelName: undefined, battery: null, error: undefined, charging: null, solar: null, station: 'GARDEN', arming: true, eufyMode: 'disarmed' });
  const attached = toDevice({ sn: 'DOOR', station: 'CHIME', capabilities: ['camera'], state: {} });
  assert.deepEqual([attached.station, attached.arming, attached.eufyMode], ['CHIME', false, null]);
});

describe('since when a camera is in its Eufy mode', () => {
  const memory = () => eufyModeMemory(mkdtempSync(join(tmpdir(), 'eufy-mode-')));

  test('a change takes the time it was seen, and is kept', () => {
    const m = memory();
    const cam = { name: 'lingonberry', eufyMode: 'away', eufyModeSince: 1000 };
    assert.equal(noteEufyMode(cam, 'disarmed', { now: 5000, memory: m }), true);
    assert.deepEqual([cam.eufyMode, cam.eufyModeSince], ['disarmed', 5000]);
    assert.deepEqual(m.load(cam), { mode: 'disarmed', since: 5000 });
  });

  test('the same mode again changes nothing', () => {
    const cam = { name: 'lingonberry', eufyMode: 'disarmed', eufyModeSince: 5000 };
    assert.equal(noteEufyMode(cam, 'disarmed', { now: 9000 }), false);
    assert.equal(cam.eufyModeSince, 5000);
  });

  test('after a restart, the saved time stays when the mode is still the same', () => {
    const m = memory();
    m.save({ name: 'lingonberry' }, { mode: 'disarmed', since: 5000 });
    const restarted = { name: 'lingonberry' };   // eufyMode not read yet
    noteEufyMode(restarted, 'disarmed', { now: 90000, memory: m });
    assert.equal(restarted.eufyModeSince, 5000);
  });

  test('after a restart, a mode changed meanwhile counts from when it is first seen', () => {
    const m = memory();
    m.save({ name: 'lingonberry' }, { mode: 'away', since: 5000 });
    const restarted = { name: 'lingonberry' };
    noteEufyMode(restarted, 'disarmed', { now: 90000, memory: m });
    assert.equal(restarted.eufyModeSince, 90000);
  });

  test('an unknown mode has no time, and a damaged file is ignored', () => {
    const cam = { name: 'lingonberry', eufyMode: 'home', eufyModeSince: 5000 };
    noteEufyMode(cam, null, { now: 9000 });
    assert.deepEqual([cam.eufyMode, cam.eufyModeSince], [null, null]);
    const dir = mkdtempSync(join(tmpdir(), 'eufy-mode-'));
    writeFileSync(join(dir, 'eufy-mode-lingonberry.json'), '{"mode":"party","since":1}');
    assert.equal(eufyModeMemory(dir).load({ name: 'lingonberry' }), null);
  });
});
