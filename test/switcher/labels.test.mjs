import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { viewFor, viewKey } from '../../src/switcher/labels.mjs';
import { createTimeFormat } from '../../src/switcher/time-format.mjs';

const time = createTimeFormat('UTC');
const now = Date.parse('2026-10-30T20:00:00Z');
const at = (hhmm) => Date.parse(`2026-10-30T${hhmm}:00Z`);

// A camera asleep with a picture from its last live session at 18:33.
const sleeping = {
  state: 'IDLE', picture: { file: 'last.jpg' }, pictureFromEvent: false, lastLiveAt: at('18:33'),
  failedAt: 0, battery: 80, minBatteryPct: 15, model: 'T8170',
};
const label = (cam, offline = null) => viewFor({ ...sleeping, ...cam }, { offline, now, time });

describe('what the stream says about a camera', () => {
  test('asleep: "Sleeping · since 18:33"', () => {
    assert.deepEqual(label({}), { kind: 'asleep', title: 'Sleeping', detail: 'since 18:33' });
  });

  test("asleep on eufy's stored event image, whose time is unknown", () => {
    assert.equal(label({ pictureFromEvent: true }).detail, 'picture from the last event');
  });

  test('waking up: what woke it, and when', () => {
    assert.deepEqual(label({ state: 'WAKING', wakeReason: 'personDetected', wakeAt: at('19:40') }),
      { kind: 'waking', title: 'Waking up', detail: 'Person detected · 19:40' });
    assert.equal(label({ state: 'WAKING', wakeReason: 'doorbellPress', wakeAt: at('19:40') }).detail, 'Doorbell pressed · 19:40');
  });

  test('live: no overlay is drawn, the web page shows until when, to the second', () => {
    assert.deepEqual(label({ state: 'LIVE', deadline: at('19:42') + 35000 }), { kind: 'live', title: 'Live', detail: 'until 19:42:35' });
  });

  test('no picture yet on a fresh install', () => {
    assert.equal(label({ picture: null }).kind, 'nopicture');
  });

  test("didn't wake up: when it tried, and which picture is still shown", () => {
    assert.deepEqual(label({ failedAt: at('19:40') }),
      { kind: 'nowake', title: 'Didn’t wake up', detail: '19:40 · picture from 18:33' });
  });

  test('low battery: says what still wakes it — a doorbell rings, a camera only on request', () => {
    assert.deepEqual(label({ battery: 12, model: 'T8210' }),
      { kind: 'lowbattery', title: 'Sleeping · battery 12 %', detail: 'Wakes only for the doorbell' });
    assert.equal(label({ battery: 12, model: 'T8170' }).detail, 'Wakes only on request');
  });

  test('offline: eufy events cannot arrive, so it would never wake', () => {
    assert.deepEqual(label({}, 'login'), { kind: 'offline', title: 'Offline', detail: 'eufy login needed · see web page' });
    assert.equal(label({}, 'connection').detail, 'Reconnecting to eufy');
  });
});

describe('which label wins when several apply', () => {
  test('live and waking always win: they are what the camera is doing right now', () => {
    assert.equal(label({ state: 'WAKING', wakeReason: 'manual', wakeAt: now, battery: 5 }, 'login').kind, 'waking');
  });

  test('offline beats everything while asleep', () => {
    assert.equal(label({ picture: null, failedAt: now, battery: 5 }, 'login').kind, 'offline');
  });

  test("didn't wake up beats low battery", () => {
    assert.equal(label({ failedAt: now, battery: 5 }).kind, 'nowake');
  });
});

describe('re-rendering', () => {
  test('only a different text means a different picture', () => {
    assert.equal(viewKey(label({})), viewKey(label({})));
    assert.notEqual(viewKey(label({})), viewKey(label({ lastLiveAt: at('18:34') })));
  });
});

describe('a camera whose Eufy mode is Disarmed', () => {
  test('says Disarmed, not Sleeping, and since when, as sleeping does', () => {
    assert.deepEqual(label({ eufyMode: 'disarmed', eufyModeSince: at('19:05') }), { kind: 'disarmed', title: 'Disarmed', detail: 'since 19:05' });
    assert.equal(label({ eufyMode: 'disarmed', eufyModeSince: at('19:05') - 24 * 3600e3 }).detail, 'since yesterday 19:05');
  });

  test('eufy\'s Off mode is not armed either', () => {
    assert.deepEqual(label({ eufyMode: 'off', eufyModeSince: at('07:30') }), { kind: 'disarmed', title: 'Eufy mode Off', detail: 'since 07:30' });
  });

  test('without a known time, it says only that it is the Eufy mode', () => {
    assert.equal(label({ eufyMode: 'disarmed' }).detail, 'Eufy mode');
  });

  test('armed modes still sleep as before', () => {
    for (const mode of ['home', 'away', 'schedule', 'custom1', 'geo', null]) assert.equal(label({ eufyMode: mode }).kind, 'asleep', String(mode));
  });

  test('Disarmed comes before a low battery; live, waking and offline still come first', () => {
    assert.equal(label({ eufyMode: 'disarmed', battery: 5 }).kind, 'disarmed');
    assert.equal(label({ eufyMode: 'disarmed', state: 'LIVE', deadline: at('20:01') }).kind, 'live');
    assert.equal(label({ eufyMode: 'disarmed', state: 'WAKING', wakeReason: 'manual', wakeAt: at('19:59') }).kind, 'waking');
    assert.equal(label({ eufyMode: 'disarmed' }, 'connection').kind, 'offline');
  });
});

describe('a wake-up someone asked for says who asked', () => {
  const waking = (wakeBy) => label({ state: 'WAKING', wakeReason: 'manual', wakeBy, wakeAt: at('19:40') }).detail;
  test('HomeKit\'s live view, the web page, or another program over the API', () => {
    assert.equal(waking('homekit'), 'Live view in HomeKit · 19:40');
    assert.equal(waking('web'), 'Requested on the web page · 19:40');
    assert.equal(waking('api'), 'Requested over the API · 19:40');
    assert.equal(waking(null), 'Requested over the API · 19:40');
  });
});
