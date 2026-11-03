// The running transcoders: one per camera and kind, shared, alive while anyone uses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TranscoderPool } from '../../src/rtsp/transcoder-pool.mjs';

// Stand-in transcoders that record how they were made, started and stopped.
function pool() {
  const made = [];
  const transcoderImpl = (opts) => {
    const t = Object.assign(new EventEmitter(), { opts, started: 0, stopped: 0 });
    t.start = async () => { t.started++; };
    t.stop = () => { t.stopped++; };
    made.push(t);
    return t;
  };
  const cameras = new Map([['garden', { name: 'garden', width: 2880, height: 1616 }]]);
  return { pool: new TranscoderPool({ cameras, transcoderImpl }), made };
}
const publication = (name = 'garden') => ({ name });
const ignore = () => {};

test('the first viewer starts a transcoder for the camera and kind', () => {
  const { pool: p, made } = pool();
  const garden = publication();
  p.lease(garden, 'mjpeg', ignore);
  assert.equal(made.length, 1);
  assert.equal(made[0].opts.kind, 'mjpeg');
  assert.equal(made[0].opts.publication, garden);
  assert.equal(made[0].started, 1);
});

test('the JPEG\'s size follows the camera\'s shape; a camera it doesn\'t know gets the default', () => {
  const { pool: p, made } = pool();
  p.lease(publication('garden'), 'mjpeg', ignore);
  p.lease(publication('shed'), 'mjpeg', ignore);
  assert.deepEqual(made[0].opts.size, { width: 640, height: 360 });
  assert.equal(made[1].opts.size, undefined);
});

test('more viewers of the same kind share it; another kind gets its own', () => {
  const { pool: p, made } = pool();
  const garden = publication();
  p.lease(garden, 'mjpeg', ignore);
  p.lease(garden, 'mjpeg', ignore);
  p.lease(garden, 'pcmu', ignore);
  assert.deepEqual(made.map((t) => t.opts.kind), ['mjpeg', 'pcmu']);
});

test('each viewer hears the packets until it lets go', () => {
  const { pool: p, made } = pool();
  const garden = publication();
  const a = [], b = [];
  const releaseA = p.lease(garden, 'mjpeg', (packet) => a.push(packet[0]));
  p.lease(garden, 'mjpeg', (packet) => b.push(packet[0]));
  made[0].emit('packet', Buffer.from([1]), true);
  releaseA();
  made[0].emit('packet', Buffer.from([2]), true);
  assert.deepEqual(a, [1]);
  assert.deepEqual(b, [1, 2]);
});

test('it stops with its last viewer, and the next viewer starts a new one', () => {
  const { pool: p, made } = pool();
  const garden = publication();
  const releaseA = p.lease(garden, 'mjpeg', ignore);
  const releaseB = p.lease(garden, 'mjpeg', ignore);
  releaseA();
  releaseA();   // twice: still counted once
  assert.equal(made[0].stopped, 0, 'still watched');
  releaseB();
  assert.equal(made[0].stopped, 1);
  p.lease(garden, 'mjpeg', ignore);
  assert.equal(made.length, 2);
});

test('a new stream of the camera (new codec) gets a new transcoder; the old one stops at once', () => {
  const { pool: p, made } = pool();
  const releaseOld = p.lease(publication(), 'mjpeg', ignore);
  p.lease(publication(), 'mjpeg', ignore);
  assert.equal(made.length, 2);
  assert.equal(made[0].stopped, 1);
  releaseOld();
  assert.equal(made[1].stopped, 0, 'the old stream\'s viewer leaving doesn\'t stop the new one');
});
