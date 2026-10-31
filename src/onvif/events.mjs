// Motion events for one camera, the way UniFi Protect (≥ 7.1) reads them to record third-party
// cameras only on motion: PullPoint subscriptions that clients long-poll with PullMessages.
// "Motion" here means: the camera is waking up or live. The messages themselves: event-messages.mjs;
// one subscription's queue and long poll: pull-point.mjs.

import { randomUUID } from 'node:crypto';
import { valueOf } from './xml.mjs';
import { parseDuration, motionMessages, eventProperties } from './event-messages.mjs';
import { Subscription } from './pull-point.mjs';

const TEV = 'http://www.onvif.org/ver10/events/wsdl';
const WSN = 'http://docs.oasis-open.org/wsn/bw-2';
const MAX_SUBSCRIPTIONS = 20;
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
    this.subscriptions = new Map();   // id -> Subscription
  }

  setMotion(motion) {
    if (motion === this.motion) return;
    this.motion = motion;
    this.changedAt = this.now();
    for (const sub of this.subscriptions.values()) sub.deliver(this.messages('Changed'));
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
        sub.deliver(this.messages('Initialized'));
        return answer(`${TEV}/PullPointSubscription/SetSynchronizationPointResponse`, '<tev:SetSynchronizationPointResponse/>');
      default:
        return null;
    }
  }

  subscribe(lifetime) {
    if (this.subscriptions.size >= MAX_SUBSCRIPTIONS) this.drop(this.subscriptions.keys().next().value);   // oldest
    const sub = new Subscription(randomUUID().replaceAll('-', ''), this.now() + parseDuration(lifetime, DEFAULT_LIFETIME_MS, this.now()));
    this.subscriptions.set(sub.id, sub);
    sub.deliver(this.messages('Initialized'));   // clients start from the current state
    return sub;
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
