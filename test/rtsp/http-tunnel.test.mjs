import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Base64Stream, httpHead } from '../../src/rtsp/http-tunnel.mjs';

test('base64 that arrives in pieces decodes to the same bytes', () => {
  const text = Buffer.from('DESCRIBE rtsp://x/garden RTSP/1.0\r\nCSeq: 1\r\n\r\n').toString('base64');
  const stream = new Base64Stream();
  const parts = [];
  for (let i = 0; i < text.length; i += 5) parts.push(stream.push(text.slice(i, i + 5)));
  assert.equal(Buffer.concat(parts).toString(), 'DESCRIBE rtsp://x/garden RTSP/1.0\r\nCSeq: 1\r\n\r\n');
});

test('the HTTP head: method and session cookie; what follows is kept', () => {
  const head = httpHead(Buffer.from('POST /garden HTTP/1.0\r\nx-sessioncookie: abc123\r\nContent-Length: 32767\r\n\r\nREVT'));
  assert.equal(head.method, 'POST');
  assert.equal(head.cookie, 'abc123');
  assert.equal(head.rest.toString(), 'REVT');
  assert.equal(httpHead(Buffer.from('GET / HTTP/1.0\r\n')), null);
});
