// What a motion event looks like on the wire: the two motion topics, the event properties (which
// topics exist), and ONVIF durations. Pure.
//
// Each change is sent on both common motion topics, so clients that know either one react:
//   tns1:RuleEngine/CellMotionDetector/Motion   Data IsMotion
//   tns1:VideoSource/MotionAlarm                Data State

export const DIALECT = 'http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet';

// xs:duration (PT60S, PT1M, PT1H30M) or an absolute xs:dateTime, in ms from now.
export function parseDuration(value, fallback, now = Date.now()) {
  if (!value) return fallback;
  const m = /^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value.trim());
  if (m) return ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000;
  const t = Date.parse(value);
  return Number.isNaN(t) ? fallback : Math.max(t - now, 1000);
}

// The events for the current motion state: [{ topic, source: [[name, value]], data: [[name, value]],
// time, operation, items }] (items: what message content filters look at).
// operation: 'Initialized' (current state, for a new subscriber) or 'Changed'.
export function motionEvents(motion, changedAt, operation) {
  const value = String(motion), time = new Date(changedAt).toISOString();
  const event = (topic, source, data) => ({ topic, source, data, time, operation,
    items: [...source, ...data].map(([name, v]) => ({ kind: 'SimpleItem', name, value: v })) });
  return [
    event('tns1:RuleEngine/CellMotionDetector/Motion',
      [['VideoSourceConfigurationToken', 'video_src_config'], ['VideoAnalyticsConfigurationToken', 'video_analytics_config'], ['Rule', 'MotionDetectorRule']],
      [['IsMotion', value]]),
    event('tns1:VideoSource/MotionAlarm', [['Source', 'video_src']], [['State', value]]),
  ];
}

const items = (list) => list.map(([name, value]) => `<tt:SimpleItem Name="${name}" Value="${value}"/>`).join('');

// One wsnt:NotificationMessage. A push notification also names its subscription and producer.
export function notificationMessage(e, { subscription = null, producer = null } = {}) {
  const ref = (tag, address) => (address ? `<wsnt:${tag}><wsa:Address>${address}</wsa:Address></wsnt:${tag}>` : '');
  return `<wsnt:NotificationMessage>${ref('SubscriptionReference', subscription)}<wsnt:Topic Dialect="${DIALECT}">${e.topic}</wsnt:Topic>`
    + `${ref('ProducerReference', producer)}<wsnt:Message><tt:Message UtcTime="${e.time}" PropertyOperation="${e.operation}">`
    + `<tt:Source>${items(e.source)}</tt:Source><tt:Data>${items(e.data)}</tt:Data></tt:Message></wsnt:Message></wsnt:NotificationMessage>`;
}

export function eventProperties() {
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
