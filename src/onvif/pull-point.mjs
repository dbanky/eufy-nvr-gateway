// One PullPoint subscription: the event messages waiting for its client, and the one PullMessages
// request that may be waiting for them (a long poll).

const MAX_QUEUE = 50;   // messages kept for a client that stopped pulling

export class Subscription {
  constructor(id, expires) {
    Object.assign(this, { id, expires, queue: [], waiter: null });
  }

  deliver(messages) {
    this.queue.push(...messages);
    this.queue.splice(0, Math.max(0, this.queue.length - MAX_QUEUE));
    this.waiter?.respond();
  }

  // Up to `limit` messages: at once if some are waiting, else when some arrive or the timeout ends
  // (then none). A new pull answers the previous one first: one pull at a time.
  wait(timeoutMs, limit) {
    this.waiter?.respond();
    return new Promise((resolve) => {
      const respond = () => {
        clearTimeout(timer);
        if (this.waiter === waiter) this.waiter = null;
        resolve(this.queue.splice(0, limit));
      };
      const waiter = { respond };
      const timer = setTimeout(respond, timeoutMs);
      if (this.queue.length) return respond();
      this.waiter = waiter;
    });
  }

  // Ends a waiting pull (unsubscribed or expired).
  close() {
    this.waiter?.respond();
  }
}
