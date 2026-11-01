// Motion events for one camera. "Motion" means: the camera is waking up or live.
//
// Both ways ONVIF delivers events (Profile S requires both):
// - PullPoint: CreatePullPointSubscription, then the client long-polls with PullMessages. UniFi
//   Protect (≥ 7.1) reads motion this way, to record third-party cameras only on motion.
// - WS-BaseNotification: Subscribe with the client's address; the device POSTs Notify to it.
// Both take topic and message content filters (event-filter.mjs). The messages: event-messages.mjs;
// one pull subscription's queue and long poll: pull-point.mjs.

import { randomUUID } from 'node:crypto';
import { valueOf, elementsOf, envelope, OnvifFault } from './xml.mjs';
import { parseDuration, motionEvents, notificationMessage, eventProperties } from './event-messages.mjs';
import { readFilter, passes } from './event-filter.mjs';
import { Subscription } from './pull-point.mjs';

const TEV = 'http://www.onvif.org/ver10/events/wsdl';
const WSN = 'http://docs.oasis-open.org/wsn/bw-2';
const MAX_SUBSCRIPTIONS = 20;
const MAX_PULL_MS = 60000;
const DEFAULT_LIFETIME_MS = 120000;
const NOTIFY_TIMEOUT_MS = 5000;

export const eventCapabilities = () => '<tev:Capabilities WSSubscriptionPolicySupport="false" WSPullPointSupport="true" '
  + 'WSPausableSubscriptionManagerInterfaceSupport="false" MaxNotificationProducers="1" MaxPullPoints="20" PersistentNotificationStorage="false"/>';

// Sends one Notify to a client: POST with a SOAP envelope; resolves true if it was taken.
async function postNotify(url, xml) {
  try {
    const res = await fetch(url, { method: 'POST', body: xml, signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
      headers: { 'content-type': 'application/soap+xml; charset=utf-8' } });
    await res.arrayBuffer();
    return res.ok;
  } catch {
    return false;
  }
}

export class MotionEvents {
  // baseUrl: the device's own URL. post(url, xml): how Notify is sent (tests replace it).
  constructor({ baseUrl, now = Date.now, post = postNotify, log = () => {} }) {
    Object.assign(this, { baseUrl, now, post, log });
    this.motion = false;
    this.changedAt = now();
    this.subscriptions = new Map();   // id -> Subscription (pull) or { push: true, ... }
  }

  setMotion(motion) {
    if (motion === this.motion) return;
    this.motion = motion;
    this.changedAt = this.now();
    this.expire();   // push subscriptions nobody renewed get nothing more
    for (const sub of this.subscriptions.values()) this.deliver(sub, 'Changed');
  }

  expire() {
    for (const [id, sub] of this.subscriptions) if (sub.expires < this.now()) this.drop(id);
  }

  // Ends every subscription (the device restarted).
  reset() {
    for (const id of [...this.subscriptions.keys()]) this.drop(id);
  }

  // op on the events service, or on a subscription (id). Resolves { body, action }.
  async handle(op, xml, id) {
    this.expire();
    if (id) {
      const sub = this.subscriptions.get(id);
      if (!sub) throw new OnvifFault('ter:InvalidArgVal', 'unknown or expired subscription');
      return this.onSubscription(op, xml, id, sub);
    }
    switch (op) {
      case 'GetServiceCapabilities':
        return answer(`${TEV}/EventPortType/GetServiceCapabilitiesResponse`, `<tev:GetServiceCapabilitiesResponse>${eventCapabilities()}</tev:GetServiceCapabilitiesResponse>`);
      case 'GetEventProperties':
        return answer(`${TEV}/EventPortType/GetEventPropertiesResponse`, eventProperties());
      case 'CreatePullPointSubscription': {
        const sub = this.subscribe(xml, null);
        return answer(`${TEV}/EventPortType/CreatePullPointSubscriptionResponse`,
          `<tev:CreatePullPointSubscriptionResponse><tev:SubscriptionReference><wsa:Address>${this.address(sub)}</wsa:Address>`
          + `</tev:SubscriptionReference>${this.times(sub, 'wsnt')}</tev:CreatePullPointSubscriptionResponse>`);
      }
      case 'Subscribe': {
        const consumer = valueOf(elementsOf(xml, 'ConsumerReference')[0], 'Address');
        if (!consumer || !/^https?:\/\//.test(consumer)) throw new OnvifFault('ter:InvalidArgVal', 'Subscribe needs a ConsumerReference with an http address');
        const sub = this.subscribe(xml, consumer);
        return answer(`${WSN}/NotificationProducer/SubscribeResponse`,
          `<wsnt:SubscribeResponse><wsnt:SubscriptionReference><wsa:Address>${this.address(sub)}</wsa:Address></wsnt:SubscriptionReference>`
          + `${this.times(sub, 'wsnt')}</wsnt:SubscribeResponse>`);
      }
      default:
        return null;
    }
  }

  onSubscription(op, xml, id, sub) {
    switch (op) {
      case 'PullMessages':
        if (sub.consumer) throw new OnvifFault('ter:ActionNotSupported', 'this subscription sends Notify; it has no pull point');
        return this.pull(sub, xml);
      case 'Renew':
        sub.expires = this.now() + parseDuration(valueOf(xml, 'TerminationTime'), DEFAULT_LIFETIME_MS, this.now());
        return answer(`${WSN}/SubscriptionManager/RenewResponse`, `<wsnt:RenewResponse>${this.times(sub, 'wsnt', true)}</wsnt:RenewResponse>`);
      case 'Unsubscribe':
        this.drop(id);
        return answer(`${WSN}/SubscriptionManager/UnsubscribeResponse`, '<wsnt:UnsubscribeResponse/>');
      case 'SetSynchronizationPoint':
        this.deliver(sub, 'Initialized');
        return answer(`${TEV}/PullPointSubscription/SetSynchronizationPointResponse`, '<tev:SetSynchronizationPointResponse/>');
      default:
        return null;
    }
  }

  // consumer: the address Notify goes to, or null for a pull point.
  subscribe(xml, consumer) {
    const filter = readFilter(elementsOf(xml, 'Filter')[0]);
    if (this.subscriptions.size >= MAX_SUBSCRIPTIONS) this.drop(this.subscriptions.keys().next().value);   // oldest
    const expires = this.now() + parseDuration(valueOf(xml, 'InitialTerminationTime'), DEFAULT_LIFETIME_MS, this.now());
    const sub = new Subscription(randomUUID().replaceAll('-', ''), expires);
    Object.assign(sub, { filter, consumer });
    this.subscriptions.set(sub.id, sub);
    this.deliver(sub, 'Initialized');   // clients start from the current state
    return sub;
  }

  deliver(sub, operation) {
    const events = motionEvents(this.motion, this.changedAt, operation).filter((e) => passes(sub.filter, e));
    if (!events.length) return;
    if (!sub.consumer) return sub.deliver(events.map((e) => notificationMessage(e)));
    const body = `<wsnt:Notify>${events.map((e) => notificationMessage(e, { subscription: this.address(sub), producer: `${this.baseUrl}/onvif/events_service` })).join('')}</wsnt:Notify>`;
    const xml = envelope(body, { action: `${WSN}/NotificationConsumer/Notify` });
    this.post(sub.consumer, xml).then((ok) => {
      if (!ok && !sub.failed) this.log(`ONVIF: couldn't send an event to ${sub.consumer}`);
      sub.failed = !ok;
    });
  }

  // Answers at once if there is something to say, otherwise when motion changes or the timeout ends.
  async pull(sub, xml) {
    const timeout = Math.min(parseDuration(valueOf(xml, 'Timeout'), 10000, this.now()), MAX_PULL_MS);
    const limit = Math.max(1, parseInt(valueOf(xml, 'MessageLimit'), 10) || 10);
    sub.expires = Math.max(sub.expires, this.now() + timeout + 30000);   // being polled keeps it alive
    const messages = await sub.wait(timeout, limit);
    return answer(`${TEV}/PullPointSubscription/PullMessagesResponse`,
      `<tev:PullMessagesResponse>${this.times(sub, 'tev')}${messages.join('')}</tev:PullMessagesResponse>`);
  }

  drop(id) {
    this.subscriptions.get(id)?.close();
    this.subscriptions.delete(id);
  }

  address(sub) {
    return `${this.baseUrl}/onvif/subscription/${sub.id}`;
  }

  times(sub, ns, terminationFirst = false) {
    const current = `<${ns}:CurrentTime>${new Date(this.now()).toISOString()}</${ns}:CurrentTime>`;
    const termination = `<${ns}:TerminationTime>${new Date(sub.expires).toISOString()}</${ns}:TerminationTime>`;
    return terminationFirst ? termination + current : current + termination;
  }
}

const answer = (action, body) => ({ action, body });
