'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ConcurrencyGate } = require('../server/admission-control');

test('concurrency gate releases a waiting request when capacity becomes available', async () => {
  const gate = new ConcurrencyGate(1);
  const releaseFirst = await gate.acquire(0);
  const waiting = gate.acquire(100);
  releaseFirst();
  const releaseSecond = await waiting;
  assert.equal(typeof releaseSecond, 'function');
  releaseSecond();
  assert.equal(gate.active, 0);
});

test('concurrency gate rejects a request after its admission deadline', async () => {
  const gate = new ConcurrencyGate(1);
  const release = await gate.acquire(0);
  assert.equal(await gate.acquire(1), null);
  release();
});
