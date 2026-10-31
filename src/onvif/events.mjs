// Motion events for one camera, the way UniFi Protect (≥ 7.1) reads them to record third-party
// cameras only on motion: PullPoint subscriptions that clients long-poll with PullMessages.
// "Motion" here means: the camera is waking up or live. The messages themselves: event-messages.mjs.

import { randomUUID } from 'node:crypto';
import { valueOf } from './xml.mjs';
import { parseDuration, motionMessages, eventProperties } from './event-messages.mjs';

const TEV = 'http://www.onvif.org/ver10/events/wsdl';
const WSN = 'http://docs.oasis-open.org/wsn/bw-2';
const MAX_SUBSCRIPTIONS = 20;
const MAX_QUEUE = 50;            // messages kept per subscription that nobody pulls
const MAX_PULL_MS = 60000;
const DEFAULT_LIFETIME_MS = 120000;

class SubscriptionError extends Error {
  constructor(message) {
    super(message);
    this.code = 'ter:InvalidArgVal';
  }
}

export class MotionEvents {
  constructor({ baseUrl, now = Date.now }) {
    Object.assign(this, { baseUrl, now });
    this.motion = false;
    this.changedAt = now();
    this.subscriptions = new Map();   // id -> { expires, queue, waiter }
  }

  setMotion(motion) {
    if (motion === this.motion) return;
    this.motion = motion;
    this.changedAt = this.now();
    for (const sub of this.subscriptions.values()) this.deliver(sub, this.messages('Changed'));
  }

  expire() {
    for (const [id, sub] of this.subscriptions) if (sub.expires < this.now()) this.drop(id);
  }

  // op on the events service, or on a subscription (id). Resolves { body, action }.
  async handle(op, xml, id) {
    this.expire();
    if (id) {
      const sub = this.subscriptions.get(id);
      if (!sub) throw new SubscriptionError('unknown or expired subscription');
      return this.onSubscription(op, xml, id, sub);
    }
    switch (op) {
      case 'GetServiceCapabilities':
        return answer(`${TEV}/EventPortType/GetServiceCapabilitiesResponse`, '<tev:GetServiceCapabilitiesResponse><tev:Capabilities '
          + 'WSSubscriptionPolicySupport="false" WSPullPointSupport="true" WSPausableSubscriptionManagerInterfaceSupport="false" '
          + 'MaxNotificationProducers="1" MaxPullPoints="20" PersistentNotificationStorage="false"/></tev:GetServiceCapabilitiesResponse>');
      case 'GetEventProperties':
        return answer(`${TEV}/EventPortType/GetEventPropertiesResponse`, eventProperties());
      case 'CreatePullPointSubscription': {
        const sub = this.subscribe(valueOf(xml, 'InitialTerminationTime'));
        return answer(`${TEV}/EventPortType/CreatePullPointSubscriptionResponse`,
          `<tev:CreatePullPointSubscriptionResponse><tev:SubscriptionReference><wsa:Address>${this.baseUrl}/onvif/subscription/${sub.id}</wsa:Address>`
          + `</tev:SubscriptionReference>${this.times(sub, 'wsnt')}</tev:CreatePullPointSubscriptionResponse>`);
      }
      default:
        return null;
    }
  }

  onSubscription(op, xml, id, sub) {
    switch (op) {
      case 'PullMessages': return this.pull(sub, xml);
      case 'Renew':
        sub.expires = this.now() + parseDuration(valueOf(xml, 'TerminationTime'), DEFAULT_LIFETIME_MS, this.now());
        return answer(`${WSN}/SubscriptionManager/RenewResponse`, `<wsnt:RenewResponse>${this.times(sub, 'wsnt', true)}</wsnt:RenewResponse>`);
      case 'Unsubscribe':
        this.drop(id);
        return answer(`${WSN}/SubscriptionManager/UnsubscribeResponse`, '<wsnt:UnsubscribeResponse/>');
      case 'SetSynchronizationPoint':
        this.deliver(sub, this.messages('Initialized'));
        return answer(`${TEV}/PullPointSubscription/SetSynchronizationPointResponse`, '<tev:SetSynchronizationPointResponse/>');
      default:
        return null;
    }
  }

  subscribe(lifetime) {
    if (this.subscriptions.size >= MAX_SUBSCRIPTIONS) this.drop(this.subscriptions.keys().next().value);   // oldest
    const sub = { id: randomUUID().replaceAll('-', ''), queue: [], waiter: null,
      expires: this.now() + parseDuration(lifetime, DEFAULT_LIFETIME_MS, this.now()) };
    this.subscriptions.set(sub.id, sub);
    this.deliver(sub, this.messages('Initialized'));   // clients start from the current state
    return sub;
  }

  // Answers at once if there is something to say, otherwise when motion changes or the timeout ends.
  pull(sub, xml) {
    const timeout = Math.min(parseDuration(valueOf(xml, 'Timeout'), 10000, this.now()), MAX_PULL_MS);
    const limit = Math.max(1, parseInt(valueOf(xml, 'MessageLimit'), 10) || 10);
    sub.expires = Math.max(sub.expires, this.now() + timeout + 30000);   // being polled keeps it alive
    sub.waiter?.respond();                                                // one pull at a time
    return new Promise((resolve) => {
      const respond = () => {
        clearTimeout(timer);
        if (sub.waiter === waiter) sub.waiter = null;
        resolve(answer(`${TEV}/PullPointSubscription/PullMessagesResponse`, '<tev:PullMessagesResponse>'
          + `${this.times(sub, 'tev')}${sub.queue.splice(0, limit).join('')}</tev:PullMessagesResponse>`));
      };
      const waiter = { respond };
      const timer = setTimeout(respond, timeout);
      if (sub.queue.length) return respond();
      sub.waiter = waiter;
    });
  }

  deliver(sub, messages) {
    sub.queue.push(...messages);
    sub.queue.splice(0, Math.max(0, sub.queue.length - MAX_QUEUE));
    sub.waiter?.respond();
  }

  drop(id) {
    this.subscriptions.get(id)?.waiter?.respond();
    this.subscriptions.delete(id);
  }

  times(sub, ns, terminationFirst = false) {
    const current = `<${ns}:CurrentTime>${new Date(this.now()).toISOString()}</${ns}:CurrentTime>`;
    const termination = `<${ns}:TerminationTime>${new Date(sub.expires).toISOString()}</${ns}:TerminationTime>`;
    return terminationFirst ? termination + current : current + termination;
  }

  messages(operation) {
    return motionMessages(this.motion, this.changedAt, operation);
  }
}

const answer = (action, body) => ({ action, body });
