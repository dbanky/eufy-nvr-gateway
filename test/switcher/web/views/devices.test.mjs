import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devicesSummary, devicesRowsHtml } from '../../../../src/switcher/web/static/devices.js';

const devices = [
  { name: 'front-door', serial: 'T82XXXXXXXXXXXXX', model: 'T8210', modelName: 'Video Doorbell', battery: 90, configured: true },
  { name: 'chime', serial: 'T80XXXXXXXXXXXXX', model: 'T8020', battery: null, configured: false },
];

test('the collapsed list says how many devices there are and how many are not added yet', () => {
  assert.equal(devicesSummary(devices), '2 devices · 1 not added');
  assert.equal(devicesSummary([devices[0]]), '1 device');
  assert.equal(devicesSummary([]), 'none found');
});

test('each device shows whether it is added as a camera, and its serial to copy', () => {
  const html = devicesRowsHtml(devices);
  assert.match(html, /T82XXXXXXXXXXXXX/);
  assert.match(html, /Added/);
  assert.match(html, /Not added/);
});
