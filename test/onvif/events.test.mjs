import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MotionEvents } from '../../src/onvif/events.mjs';

const BASE = 'http://192.168.1.51:8000';
const create = '<s:Body><tev:CreatePullPointSubscription><tev:InitialTerminationTime>PT2M</tev:InitialTerminationTime></tev:CreatePullPointSubscription></s:Body>';
const pull = (timeout = 'PT1M', limit = 10) => `<s:Body><tev:PullMessages><tev:Timeout>${timeout}</tev:Timeout><tev:MessageLimit>${limit}</tev:MessageLimit></tev:PullMessages></s:Body>`;
const idFrom = (body) => /subscription\/(\w+)</.exec(body)[1];
const motionValues = (body) => [...body.matchAll(/Name="IsMotion" Value="(\w+)"/g)].map((m) => m[1]);

describe('motion events (PullPoint, what UniFi Protect uses)', () => {
  test('a new subscription first reports the current state', async () => {
    const events = new MotionEvents({ baseUrl: BASE });
    const created = await events.handle('CreatePullPointSubscription', create);
    assert.match(created.body, /<wsa:Address>http:\/\/192\.168\.1\.51:8000\/onvif\/subscription\/\w+<\/wsa:Address>/);
    const first = await events.handle('PullMessages', pull(), idFrom(created.body));
    assert.match(first.body, /PropertyOperation="Initialized"/);
    assert.deepEqual(motionValues(first.body), ['false']);
  });

  test('both motion topics are sent: CellMotionDetector (IsMotion) and MotionAlarm (State)', async () => {
    const events = new MotionEvents({ baseUrl: BASE });
    const id = idFrom((await events.handle('CreatePullPointSubscription', create)).body);
    const { body } = await events.handle('PullMessages', pull(), id);
    assert.match(body, /tns1:RuleEngine\/CellMotionDetector\/Motion/);
    assert.match(body, /tns1:VideoSource\/MotionAlarm/);
    assert.match(body, /Name="State" Value="false"/);
  });

  test('a waiting pull returns as soon as motion starts', async () => {
    const events = new MotionEvents({ baseUrl: BASE });
    const id = idFrom((await events.handle('CreatePullPointSubscription', create)).body);
    await events.handle('PullMessages', pull(), id);                // the Initialized messages
    const waiting = events.handle('PullMessages', pull(), id);
    events.setMotion(true);
    const { body } = await waiting;
    assert.match(body, /PropertyOperation="Changed"/);
    assert.deepEqual(motionValues(body), ['true']);
  });

  test('a pull with nothing to report ends empty after its timeout', async () => {
    const events = new MotionEvents({ baseUrl: BASE });
    const id = idFrom((await events.handle('CreatePullPointSubscription', create)).body);
    await events.handle('PullMessages', pull(), id);                // the Initialized messages
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const waiting = events.handle('PullMessages', pull('PT5S'), id);
      await Promise.resolve();                                       // let the pull start waiting
      mock.timers.tick(5000);
      const { body } = await waiting;
      assert.doesNotMatch(body, /NotificationMessage/);
      assert.match(body, /<tev:PullMessagesResponse>/);
    } finally {
      mock.timers.reset();
    }
  });

  test('several subscriptions each get every change (clients keep more than one)', async () => {
    const events = new MotionEvents({ baseUrl: BASE });
    const a = idFrom((await events.handle('CreatePullPointSubscription', create)).body);
    const b = idFrom((await events.handle('CreatePullPointSubscription', create)).body);
    events.setMotion(true);
    for (const id of [a, b]) assert.deepEqual(motionValues((await events.handle('PullMessages', pull(), id)).body), ['false', 'true']);
  });

  test('unchanged motion sends nothing new', async () => {
    const events = new MotionEvents({ baseUrl: BASE });
    const id = idFrom((await events.handle('CreatePullPointSubscription', create)).body);
    events.setMotion(false);
    assert.deepEqual(motionValues((await events.handle('PullMessages', pull(), id)).body), ['false']);
  });

  test('subscriptions expire unless renewed; unsubscribed or unknown ones are refused', async () => {
    let now = 0;
    const events = new MotionEvents({ baseUrl: BASE, now: () => now });
    const id = idFrom((await events.handle('CreatePullPointSubscription', create)).body);
    now += 60000;
    await events.handle('Renew', '<s:Body><wsnt:Renew><wsnt:TerminationTime>PT2M</wsnt:TerminationTime></wsnt:Renew></s:Body>', id);
    now += 100000;
    events.expire();
    assert.ok(await events.handle('PullMessages', pull('PT0S'), id), 'renewed: still there');
    await events.handle('Unsubscribe', '<s:Body><wsnt:Unsubscribe/></s:Body>', id);
    await assert.rejects(events.handle('PullMessages', pull(), id), /unknown or expired subscription/);
  });

  test('event properties list the two motion topics', async () => {
    const { body } = await new MotionEvents({ baseUrl: BASE }).handle('GetEventProperties', '');
    assert.match(body, /<tns1:RuleEngine><CellMotionDetector><Motion wstop:topic="true">/);
    assert.match(body, /<tns1:VideoSource><MotionAlarm wstop:topic="true">/);
  });
});

describe('motion events (WS-BaseNotification: pushed to the client)', () => {
  const subscribe = (address, filter = '') => `<s:Body><wsnt:Subscribe><wsnt:ConsumerReference><wsa:Address>${address}</wsa:Address></wsnt:ConsumerReference>`
    + `${filter ? `<wsnt:Filter>${filter}</wsnt:Filter>` : ''}<wsnt:InitialTerminationTime>PT1M</wsnt:InitialTerminationTime></wsnt:Subscribe></s:Body>`;

  test('Subscribe sends the current state, then every change, as Notify to the client\'s address', async () => {
    const sent = [];
    const events = new MotionEvents({ baseUrl: BASE, post: async (url, xml) => sent.push({ url, xml }) && true });
    const { body, action } = await events.handle('Subscribe', subscribe('http://192.168.1.10:9000/notify'));
    assert.equal(action, 'http://docs.oasis-open.org/wsn/bw-2/NotificationProducer/SubscribeResponse');
    assert.match(body, /<wsnt:SubscribeResponse><wsnt:SubscriptionReference><wsa:Address>http:\/\/192\.168\.1\.51:8000\/onvif\/subscription\/\w+</);
    events.setMotion(true);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].url, 'http://192.168.1.10:9000/notify');
    assert.match(sent[0].xml, /<wsa:Action>http:\/\/docs\.oasis-open\.org\/wsn\/bw-2\/NotificationConsumer\/Notify<\/wsa:Action>/);
    assert.match(sent[0].xml, /<wsnt:Notify><wsnt:NotificationMessage><wsnt:SubscriptionReference>/);
    assert.deepEqual(motionValues(sent[1].xml), ['true']);
  });

  test('a push subscription has no pull point, and ends with Unsubscribe', async () => {
    const sent = [];
    const events = new MotionEvents({ baseUrl: BASE, post: async (url, xml) => sent.push(xml) && true });
    const id = idFrom((await events.handle('Subscribe', subscribe('http://192.168.1.10:9000/notify'))).body);
    await assert.rejects(events.handle('PullMessages', pull(), id), { code: 'ter:ActionNotSupported' });
    await events.handle('Unsubscribe', '<s:Body><wsnt:Unsubscribe/></s:Body>', id);
    events.setMotion(true);
    assert.equal(sent.length, 1, 'only the first state');
  });

  test('Subscribe needs an http address to send to', async () => {
    await assert.rejects(new MotionEvents({ baseUrl: BASE }).handle('Subscribe', subscribe('mailto:x')), { code: 'ter:InvalidArgVal' });
  });
});

describe('event filters on subscriptions', () => {
  test('a topic filter: only MotionAlarm messages', async () => {
    const events = new MotionEvents({ baseUrl: BASE });
    const filtered = '<s:Body><tev:CreatePullPointSubscription><tev:Filter><wsnt:TopicExpression Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">'
      + 'tns1:VideoSource/MotionAlarm</wsnt:TopicExpression></tev:Filter></tev:CreatePullPointSubscription></s:Body>';
    const id = idFrom((await events.handle('CreatePullPointSubscription', filtered)).body);
    const { body } = await events.handle('PullMessages', pull(), id);
    assert.match(body, /MotionAlarm/);
    assert.doesNotMatch(body, /CellMotionDetector/);
  });

  test('a content filter: only when motion starts', async () => {
    const events = new MotionEvents({ baseUrl: BASE });
    const filtered = '<s:Body><tev:CreatePullPointSubscription><tev:Filter><wsnt:MessageContent Dialect="http://www.onvif.org/ver10/tev/messageContentFilter/ItemFilter">'
      + 'boolean(//tt:SimpleItem[@Name="IsMotion" and @Value="true"])</wsnt:MessageContent></tev:Filter></tev:CreatePullPointSubscription></s:Body>';
    const id = idFrom((await events.handle('CreatePullPointSubscription', filtered)).body);
    events.setMotion(true);
    events.setMotion(false);
    assert.deepEqual(motionValues((await events.handle('PullMessages', pull('PT0S'), id)).body), ['true']);
  });
});
