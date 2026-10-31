// Motion events for one camera, the way UniFi Protect (≥ 7.1) reads them to record third-party
// cameras only on motion: PullPoint subscriptions that clients long-poll with PullMessages.
// "Motion" here means: the camera is waking up or live.
//
// Each change is sent on both common motion topics, so clients that know either one react:
//   tns1:RuleEngine/CellMotionDetector/Motion   Data IsMotion
//   tns1:VideoSource/MotionAlarm                Data State

import { randomUUID } from 'node:crypto';
import { valueOf } from './xml.mjs';

const DIALECT = 'http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet';
const TEV = 'http://www.onvif.org/ver10/events/wsdl';
const WSN = 'http://docs.oasis-open.org/wsn/bw-2';
const MAX_SUBSCRIPTIONS = 20;
const MAX_QUEUE = 50;            // messages kept per subscription that nobody pulls
const MAX_PULL_MS = 60000;
const DEFAULT_LIFETIME_MS = 120000;

// xs:duration (PT60S, PT1M, PT1H30M) or an absolute xs:dateTime, in ms from now.
export function parseDuration(value, fallback, now = Date.now()) {
  if (!value) return fallback;
  const m = /^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value.trim());
  if (m) return ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000;
  const t = Date.parse(value);
  return Number.isNaN(t) ? fallback : Math.max(t - now, 1000);
}

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
    const value = String(this.motion), time = new Date(this.changedAt).toISOString();
    const message = (topic, source, data) => `<wsnt:NotificationMessage><wsnt:Topic Dialect="${DIALECT}">${topic}</wsnt:Topic>`
      + `<wsnt:Message><tt:Message UtcTime="${time}" PropertyOperation="${operation}"><tt:Source>${source}</tt:Source>`
      + `<tt:Data>${data}</tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>`;
    return [
      message('tns1:RuleEngine/CellMotionDetector/Motion',
        '<tt:SimpleItem Name="VideoSourceConfigurationToken" Value="video_src_config"/>'
        + '<tt:SimpleItem Name="VideoAnalyticsConfigurationToken" Value="video_analytics_config"/>'
        + '<tt:SimpleItem Name="Rule" Value="MotionDetectorRule"/>',
        `<tt:SimpleItem Name="IsMotion" Value="${value}"/>`),
      message('tns1:VideoSource/MotionAlarm',
        '<tt:SimpleItem Name="Source" Value="video_src"/>',
        `<tt:SimpleItem Name="State" Value="${value}"/>`),
    ];
  }
}

const answer = (action, body) => ({ action, body });

function eventProperties() {
  const describe = (source, data) => `<tt:MessageDescription IsProperty="true"><tt:Source>${source}</tt:Source><tt:Data>${data}</tt:Data></tt:MessageDescription>`;
  return '<tev:GetEventPropertiesResponse>'
    + '<tev:TopicNamespaceLocation>http://www.onvif.org/onvif/ver10/topics/topicns.xml</tev:TopicNamespaceLocation>'
    + '<wsnt:FixedTopicSet>true</wsnt:FixedTopicSet><wstop:TopicSet>'
    + '<tns1:RuleEngine><CellMotionDetector><Motion wstop:topic="true">'
    + describe('<tt:SimpleItemDescription Name="VideoSourceConfigurationToken" Type="tt:ReferenceToken"/>'
      + '<tt:SimpleItemDescription Name="VideoAnalyticsConfigurationToken" Type="tt:ReferenceToken"/>'
      + '<tt:SimpleItemDescription Name="Rule" Type="xs:string"/>',
      '<tt:SimpleItemDescription Name="IsMotion" Type="xs:boolean"/>')
    + '</Motion></CellMotionDetector></tns1:RuleEngine>'
    + '<tns1:VideoSource><MotionAlarm wstop:topic="true">'
    + describe('<tt:SimpleItemDescription Name="Source" Type="tt:ReferenceToken"/>',
      '<tt:SimpleItemDescription Name="State" Type="xs:boolean"/>')
    + '</MotionAlarm></tns1:VideoSource></wstop:TopicSet>'
    + `<wsnt:TopicExpressionDialect>${DIALECT}</wsnt:TopicExpressionDialect>`
    + '<wsnt:TopicExpressionDialect>http://docs.oasis-open.org/wsn/t-1/TopicExpression/Concrete</wsnt:TopicExpressionDialect>'
    + '<tev:MessageContentFilterDialect>http://www.onvif.org/ver10/tev/messageContentFilter/ItemFilter</tev:MessageContentFilterDialect>'
    + '<tev:MessageContentSchemaLocation>http://www.onvif.org/onvif/ver10/schema/onvif.xsd</tev:MessageContentSchemaLocation>'
    + '</tev:GetEventPropertiesResponse>';
}
