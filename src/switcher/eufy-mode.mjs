// A camera's Eufy mode (eufy's guard mode: Home, Away, Disarmed, …), read and switched through the
// bundled eufy SDK. The mode belongs to a station: a camera without a HomeBase is its own station; a
// camera behind a HomeBase or a doorbell chime shares that station's mode. The gateway only switches
// it: what each mode does (which triggers record, notify, …) is set in the eufy app, as always.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The SDK's names for eufy's modes, by the number a station reports.
export const EUFY_MODES = { 0: 'away', 1: 'home', 2: 'schedule', 3: 'custom1', 4: 'custom2', 5: 'custom3', 6: 'off', 47: 'geo', 63: 'disarmed' };
export const EUFY_MODE_NAMES = Object.values(EUFY_MODES);
const LABELS = { away: 'Away', home: 'Home', schedule: 'Schedule', custom1: 'Custom 1', custom2: 'Custom 2', custom3: 'Custom 3', off: 'Off', geo: 'Geofencing', disarmed: 'Disarmed' };
export const eufyModeLabel = (mode) => LABELS[mode] ?? String(mode);

// A station's reported value (a number, or already a name) -> the mode's name, or null.
export function eufyModeName(value) {
  if (value == null || value === '') return null;
  if (EUFY_MODE_NAMES.includes(value)) return value;
  return EUFY_MODES[Number(value)] ?? null;
}

// The device whose Eufy mode applies to a camera: the camera itself when it can be armed, else its
// station (HomeBase, chime) from the device list. null while unknown.
export function stationFor(serial, devices) {
  const device = devices.find((d) => d.serial === serial);
  if (!device) return null;
  if (device.arming) return device;
  return devices.find((d) => d.serial === device.station && d.arming) ?? null;
}

// The camera's Eufy mode for the API: { mode, label, station: { serial, name }, shared } or null.
export function eufyModeOf(serial, devices) {
  const station = stationFor(serial, devices);
  if (!station) return null;
  return {
    mode: station.eufyMode,
    label: station.eufyMode ? eufyModeLabel(station.eufyMode) : null,
    station: { serial: station.serial, name: station.name ?? null },
    shared: station.serial !== serial,   // set on a HomeBase or chime: other devices follow it too
  };
}

// Switch a camera's Eufy mode. Resolves with the station it was set on; rejects with a reason.
// The station reports its new mode on its own; the device list is read again to show it.
export async function setEufyMode({ bridge, serial, mode, log = () => {}, name = serial, schedule = setTimeout }) {
  if (!EUFY_MODE_NAMES.includes(mode)) throw new Error(`the Eufy mode must be one of ${EUFY_MODE_NAMES.map((m) => `"${m}"`).join(', ')}`);
  const station = stationFor(serial, bridge.devices ?? []);
  if (!station) throw new Error('its Eufy mode is not known yet (the device list is read after the eufy login)');
  const answer = await bridge.request({ cmd: 'device.set', sn: station.serial, name: 'armingMode', value: mode }, 30000);
  if (answer?.ok === false || answer?.error) throw new Error(answer.error ?? 'eufy refused it');
  log(name, `Eufy mode ${eufyModeLabel(mode)}${station.serial === serial ? '' : ` (on ${station.name ?? station.serial})`}`);
  station.eufyMode = mode;   // shown at once; the stations' own report follows
  for (const ms of [5000, 20000]) schedule(() => bridge.refreshDevices(), ms);
  return station;
}

// Since when a camera has been in its Eufy mode, kept per camera in dataDir (eufy-mode-<name>.json),
// so "Disarmed · since 18:33" survives restarts like the sleeping picture's time does.
const memoryFile = (dataDir, cam) => join(dataDir, `eufy-mode-${cam.name}.json`);

export function eufyModeMemory(dataDir) {
  return {
    load(cam) {
      try {
        const saved = JSON.parse(readFileSync(memoryFile(dataDir, cam), 'utf8'));
        return EUFY_MODE_NAMES.includes(saved.mode) && Number.isFinite(saved.since) ? saved : null;
      } catch {
        return null;
      }
    },
    save(cam, record) {
      try { writeFileSync(memoryFile(dataDir, cam), JSON.stringify(record)); } catch { /* only the time is lost */ }
    },
  };
}

// A camera's Eufy mode, as just read or set. Keeps cam.eufyMode and cam.eufyModeSince (when it went
// into it): a change takes `now`; the first reading after a start takes the saved time when the
// saved mode is the same one (otherwise it changed while the gateway was down: from now on).
export function noteEufyMode(cam, mode, { now = Date.now(), memory = null } = {}) {
  if (cam.eufyModeSince && mode === cam.eufyMode) return false;
  let since = now;
  if (cam.eufyMode === undefined) {
    const saved = memory?.load(cam);
    if (saved && saved.mode === mode) since = saved.since;
  }
  cam.eufyMode = mode;
  cam.eufyModeSince = mode ? since : null;
  if (mode) memory?.save(cam, { mode, since });
  return true;
}
