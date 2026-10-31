import { spawn } from 'node:child_process';

// A long-running ffmpeg. A closed stdin (the process ended) is not worth crashing over.
// logLevel 'info' also prints the input's description (codec, size), without progress lines.
export function spawnFfmpeg(args, { logLevel = 'error' } = {}) {
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', logLevel, ...(logLevel === 'info' ? ['-nostats'] : []), ...args]);
  child.stdin.on('error', () => {});
  return child;
}

// Runs ffmpeg once, feeds it `input` on stdin, resolves with everything it wrote to stdout.
export function runFfmpeg(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawnFfmpeg(args);
    const out = [];
    let err = '';
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0
      ? resolve(Buffer.concat(out))
      : reject(new Error(`ffmpeg ${code}: ${err.trim().slice(0, 300)}`))));
    child.stdin.end(input ?? null);
  });
}

// ffmpeg input arguments for raw frames of one camera.
export const rawInput = ({ width, height }) => ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${width}x${height}`];
export const frameSize = ({ width, height }) => width * height * 3 / 2;   // yuv420p

// Scale anything to exactly width x height, letterboxed, never stretched.
export const fitFilter = ({ width, height }) =>
  `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;

// Recolour a white RGBA image (the icons) and set its opacity.
export const tint = ([r, g, b], alpha = 1) => `lutrgb=r=${r}:g=${g}:b=${b}:a=val*${alpha}`;

// One raw frame as a JPEG (snapshots, and the last frame kept across restarts).
export function encodeJpeg(cam, frame, file) {
  const out = file ? ['-y', file] : ['-f', 'mjpeg', 'pipe:1'];
  return runFfmpeg([...rawInput(cam), '-i', 'pipe:0', '-frames:v', '1', '-q:v', '3', ...out], frame);
}
