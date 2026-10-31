// Test helper: ADTS frames without an encoder.

// An ADTS frame: 7-byte header (no CRC) + payload. profile 1 = AAC-LC, rateIndex 8 = 16 kHz.
export function adtsFrame(payload = Buffer.alloc(10, 0x21), { profile = 1, rateIndex = 8, channels = 1 } = {}) {
  const length = 7 + payload.length;
  const h = Buffer.from([
    0xff, 0xf1,
    (profile << 6) | (rateIndex << 2) | (channels >> 2),
    ((channels & 3) << 6) | (length >> 11),
    (length >> 3) & 0xff,
    ((length & 7) << 5) | 0x1f,
    0xfc,
  ]);
  return Buffer.concat([h, payload]);
}
