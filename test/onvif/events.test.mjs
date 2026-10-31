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
