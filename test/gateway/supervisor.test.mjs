import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { restartDelay, lineSplitter } from '../../src/gateway/supervisor.mjs';

describe('restarting a service that exited', () => {
  test('after a long run: right away (1 s)', () => {
    assert.equal(restartDelay(5 * 60000, 16000), 1000);
  });

  test('when it keeps crashing: twice as long each time', () => {
    assert.equal(restartDelay(2000, 1000), 2000);
    assert.equal(restartDelay(2000, 2000), 4000);
  });

  test('but never longer than 30 s', () => {
    assert.equal(restartDelay(2000, 20000), 30000);
  });
});

describe('log lines of a service', () => {
  test('are passed on whole, even when split across chunks', () => {
    const lines = [];
    const push = lineSplitter((l) => lines.push(l));
    push('first li');
    push('ne\nsecond line\nthi');
    push('rd\n');
    assert.deepEqual(lines, ['first line', 'second line', 'third']);
  });

  test('empty lines are dropped', () => {
    const lines = [];
    lineSplitter((l) => lines.push(l))('a\n\n  \nb\n');
    assert.deepEqual(lines, ['a', 'b']);
  });
});
