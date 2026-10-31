// What a camera's stream says about it: { kind, title, detail }. `kind` picks the overlay design
// (see overlay/design.mjs); title and detail are the label's two lines. Pure.

export const WAKE_REASONS = {
  motion: 'Motion detected',
  personDetected: 'Person detected',
  vehicleDetected: 'Vehicle detected',
  petDetection: 'Pet detected',
  strangerDetected: 'Stranger detected',
  doorbellPress: 'Doorbell pressed',
  manual: 'Requested on the web page',
};

// Doorbell models (T82xx) can still be woken by a ring when the battery is low.
const isDoorbell = (model) => /^T82/.test(model ?? '');

// cam:     the camera's current facts (state, times, battery, picture)
// offline: null, or 'login' / 'connection' when eufy events can't arrive
// The checks run in order of importance: the first that applies wins.
export function viewFor(cam, { offline, now, time }) {
  // The live hold is counted in seconds (30 s after the last detection), so its end shows them too.
  if (cam.state === 'LIVE') return { kind: 'live', title: 'Live', detail: `until ${time.hms(cam.deadline)}` };
  if (cam.state === 'WAKING') {
    return { kind: 'waking', title: 'Waking up', detail: `${WAKE_REASONS[cam.wakeReason] ?? 'Waking'} · ${time.hm(cam.wakeAt)}` };
  }
  if (offline) {
    return { kind: 'offline', title: 'Offline', detail: offline === 'login' ? 'eufy login needed · see web page' : 'Reconnecting to eufy' };
  }
  if (!cam.picture) return { kind: 'nopicture', title: 'No picture yet', detail: 'Appears after the first event' };

  const knownTime = !cam.pictureFromEvent && cam.lastLiveAt;   // eufy's stored event image has no time
  if (cam.failedAt) {
    return { kind: 'nowake', title: 'Didn’t wake up', detail: `${time.hm(cam.failedAt)} · picture from ${knownTime ? time.hm(cam.lastLiveAt) : 'the last event'}` };
  }
  if (cam.battery != null && cam.battery < cam.minBatteryPct) {
    return { kind: 'lowbattery', title: `Sleeping · battery ${cam.battery} %`,
      detail: isDoorbell(cam.model) ? 'Wakes only for the doorbell' : 'Wakes only on request' };
  }
  return { kind: 'asleep', title: 'Sleeping', detail: knownTime ? time.since(cam.lastLiveAt, now) : 'picture from the last event' };
}

// Equal keys mean the same picture: no need to render again.
export const viewKey = (v) => `${v.kind}|${v.title}|${v.detail}`;
