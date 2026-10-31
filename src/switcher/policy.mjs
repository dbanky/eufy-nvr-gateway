// When a camera wakes up and when it goes back to sleep. Pure decisions, no side effects.

export const CAMERA_DEFAULTS = {
  width: 1920, height: 1080, fps: 15, bitrateKbps: 4400,   // set to the camera's native size: no downscaling
  triggers: ['motion', 'personDetected', 'vehicleDetected', 'petDetection', 'strangerDetected', 'doorbellPress'],
  holdMs: 30000,              // stay live until this long after the last detection
  ringHoldMs: 120000,         // ...and this long after a doorbell press
  maxLiveMs: 0,               // optional cap per session from the first live frame; 0 = none
  firstFrameTimeoutMs: 60000, // give up if the camera hasn't sent a picture by then
  restartGapMs: 15000,        // minimum pause between sessions
  maxReconnects: 2,           // re-open the feed if it drops mid-session
  minBatteryPct: 15,          // below this only a doorbell press or a manual request wakes it
};

// A doorbell press and a request from the web page always wake the camera.
const isVip = (kind) => kind === 'doorbellPress' || kind === 'manual';

// What to do with a trigger:
//   { action: 'wake', holdUntil }    start a session
//   { action: 'extend', holdUntil }  already awake: stay live longer
//   { action: 'ignore', reason }
export function decideTrigger(cam, kind, now) {
  const holdUntil = now + (kind === 'doorbellPress' ? cam.ringHoldMs : cam.holdMs);
  if (cam.state !== 'IDLE') return { action: 'extend', holdUntil: Math.max(cam.deadline, holdUntil) };
  if (!isVip(kind)) {
    if (cam.battery != null && cam.battery < cam.minBatteryPct) return { action: 'ignore', reason: `battery ${cam.battery}%` };
    if (now - cam.lastStop < cam.restartGapMs) return { action: 'ignore', reason: 'restart gap' };
  }
  return { action: 'wake', holdUntil };
}

// Why an active session should end now, or null to keep going.
export function stopReason(cam, now) {
  if (cam.state === 'WAKING' && now - cam.sessionStart > cam.firstFrameTimeoutMs) return 'no video from camera';
  if (cam.state !== 'IDLE' && now > cam.deadline) return 'hold time over';
  if (cam.state === 'LIVE' && cam.maxLiveMs > 0 && now - cam.liveStart > cam.maxLiveMs) return 'max live time';
  return null;
}

// The hold time counts from the first live frame, not from the trigger: waking can take a minute.
export const deadlineWhenLive = (cam, liveStart) => Math.max(cam.deadline, liveStart + cam.holdMs);

export const shouldReconnect = (cam, now) => now < cam.deadline && cam.reconnects < cam.maxReconnects;
