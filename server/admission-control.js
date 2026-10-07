'use strict';

/**
 * Per-runtime admission control for expensive provider calls. This is not a
 * replacement for a distributed quota; it protects a warm Function instance
 * while the durable queue described in docs/scaling.md absorbs large bursts.
 */
class ConcurrencyGate {
  constructor(limit = 4) {
    this.limit = Math.max(1, Number(limit) || 4);
    this.active = 0;
    this.waiters = [];
  }

  acquire(timeoutMs = 1000) {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.release.bind(this));
    }
    return new Promise(resolve => {
      const waiter = { resolve, timer:null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(null);
      }, Math.max(0, timeoutMs));
      this.waiters.push(waiter);
    });
  }

  release() {
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(this.release.bind(this));
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

function admissionMiddleware(gate, { waitMs = 1000, retryAfterSeconds = 5 } = {}) {
  return async (req, res, next) => {
    const release = await gate.acquire(waitMs);
    if (!release) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error:'AI capacity is busy. Please retry shortly.', code:'ai_capacity_busy' });
    }
    let released = false;
    const done = () => { if (!released) { released = true; release(); } };
    res.once('finish', done);
    res.once('close', done);
    next();
  };
}

module.exports = { ConcurrencyGate, admissionMiddleware };
