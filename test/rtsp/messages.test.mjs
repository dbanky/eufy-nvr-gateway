import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RtspReader, formatMessage, formatFrame, header, withHeader, requestLine } from '../../src/rtsp/messages.mjs';

test('requests, answers and interleaved frames, however the bytes are cut', () => {
  const bytes = Buffer.concat([
    Buffer.from('RTSP/1.0 200 OK\r\nCSeq: 2\r\nContent-Length: 5\r\n\r\nhello'),
    formatFrame(1, Buffer.from([1, 2, 3])),
    Buffer.from('OPTIONS rtsp://x/garden RTSP/1.0\r\nCSeq: 3\r\n\r\n'),
  ]);
  const reader = new RtspReader();
  const items = [];
  for (const byte of bytes) items.push(...reader.push(Buffer.from([byte])));
  assert.equal(items.length, 3);
  assert.equal(items[0].message.startLine, 'RTSP/1.0 200 OK');
  assert.equal(items[0].message.body.toString(), 'hello');
  assert.deepEqual(items[1].frame, { channel: 1, data: Buffer.from([1, 2, 3]) });
  assert.deepEqual(requestLine(items[2].message.startLine), { method: 'OPTIONS', uri: 'rtsp://x/garden' });
});

test('headers by name, any case; set, replace, remove', () => {
  const headers = [['CSeq', '1'], ['Session', 'A']];
  assert.equal(header(headers, 'cseq'), '1');
  assert.deepEqual(withHeader(headers, 'session', 'B'), [['CSeq', '1'], ['session', 'B']]);
  assert.deepEqual(withHeader(headers, 'Session', null), [['CSeq', '1']]);
  assert.deepEqual(withHeader(headers, 'Transport', 'x'), [['CSeq', '1'], ['Session', 'A'], ['Transport', 'x']]);
});

test('written messages always carry the right Content-Length', () => {
  const out = formatMessage({ startLine: 'RTSP/1.0 200 OK', headers: [['CSeq', '1'], ['Content-Length', '999']], body: Buffer.from('abc') }).toString();
  assert.equal(out, 'RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Length: 3\r\n\r\nabc');
});

test('a head that never ends is refused', () => {
  assert.throws(() => new RtspReader({ maxHead: 10 }).push(Buffer.from('X'.repeat(20))), /too long/);
});
