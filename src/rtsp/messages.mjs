// RTSP on the wire: requests and responses (a start line, headers, an optional body) mixed with
// interleaved binary frames ("$", channel, 16-bit length, data; RFC 2326 section 10.12).
// Pure: bytes in, messages out, and back.

// Reads one direction of an RTSP connection. push(bytes) returns what is now complete:
// { frame: { channel, data } } or { message: { startLine, headers: [[name, value]], body } }.
export class RtspReader {
  constructor({ maxHead = 64 * 1024 } = {}) {
    this.buffer = Buffer.alloc(0);
    this.maxHead = maxHead;
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const out = [];
    for (;;) {
      const item = this.next();
      if (!item) return out;
      out.push(item);
    }
  }

  next() {
    const b = this.buffer;
    if (!b.length) return null;
    if (b[0] === 0x24) {   // '$'
      if (b.length < 4) return null;
      const length = b.readUInt16BE(2);
      if (b.length < 4 + length) return null;
      this.buffer = b.subarray(4 + length);
      return { frame: { channel: b[1], data: b.subarray(4, 4 + length) } };
    }
    const end = b.indexOf('\r\n\r\n');
    if (end < 0) {
      if (b.length > this.maxHead) throw new Error('RTSP message head too long');
      return null;
    }
    const [startLine, ...lines] = b.subarray(0, end).toString('utf8').split('\r\n');
    const headers = lines.filter(Boolean).map((line) => {
      const colon = line.indexOf(':');
      return colon < 0 ? [line.trim(), ''] : [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    });
    const length = Number(header(headers, 'content-length') ?? 0) || 0;
    if (b.length < end + 4 + length) return null;
    this.buffer = b.subarray(end + 4 + length);
    return { message: { startLine, headers, body: b.subarray(end + 4, end + 4 + length) } };
  }
}

export function header(headers, name) {
  const lower = name.toLowerCase();
  return headers.find(([n]) => n.toLowerCase() === lower)?.[1] ?? null;
}

// A copy of the headers with `name` set to value (or removed when value is null).
export function withHeader(headers, name, value) {
  const lower = name.toLowerCase();
  const rest = headers.filter(([n]) => n.toLowerCase() !== lower);
  if (value == null) return rest;
  const at = headers.findIndex(([n]) => n.toLowerCase() === lower);
  rest.splice(at < 0 ? rest.length : at, 0, [name, value]);
  return rest;
}

// Content-Length always matches the body.
export function formatMessage({ startLine, headers, body = Buffer.alloc(0) }) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const all = withHeader(headers, 'Content-Length', data.length ? String(data.length) : null);
  return Buffer.concat([Buffer.from(`${startLine}\r\n${all.map(([n, v]) => `${n}: ${v}\r\n`).join('')}\r\n`), data]);
}

export function formatFrame(channel, data) {
  const head = Buffer.from([0x24, channel, data.length >> 8, data.length & 0xff]);
  return Buffer.concat([head, data]);
}

// "DESCRIBE rtsp://host/garden RTSP/1.0" -> { method, uri }; null for a response.
export function requestLine(startLine) {
  const m = /^([A-Z_]+) (\S+) RTSP\/1\.0$/.exec(startLine);
  return m ? { method: m[1], uri: m[2] } : null;
}

export function response(status, reason, cseq, extra = []) {
  return formatMessage({ startLine: `RTSP/1.0 ${status} ${reason}`, headers: [...(cseq ? [['CSeq', cseq]] : []), ...extra] });
}
