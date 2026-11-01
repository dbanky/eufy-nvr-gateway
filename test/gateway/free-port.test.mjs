import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { isPortFree, freePort } from '../../src/gateway/free-port.mjs';

const listen = () => new Promise((resolve) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => resolve(server));
});

describe('internal ports that another program on the host already uses', () => {
  test('a port someone listens on is not free; once they stop, it is', async () => {
    const server = await listen();
    const { port } = server.address();
    assert.equal(await isPortFree(port), false);
    await new Promise((r) => server.close(r));
    assert.equal(await isPortFree(port), true);
  });

  test('the configured port when it is free', async () => {
    assert.equal(await freePort(28554, { isFree: async () => true }), 28554);
  });

  test('the next free port when the configured one is taken', async () => {
    const taken = new Set([18554, 18555]);
    assert.equal(await freePort(18554, { isFree: async (p) => !taken.has(p) }), 18556);
  });

  test('null when none in the range is free', async () => {
    assert.equal(await freePort(18554, { range: 3, isFree: async () => false }), null);
  });

  test('with a real listener in the way', async () => {
    const server = await listen();
    const { port } = server.address();
    const chosen = await freePort(port);
    assert.notEqual(chosen, port);
    assert.ok(chosen > port);
    server.close();
  });
});
