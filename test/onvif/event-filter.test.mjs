import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { topicMatches, contentFilter, readFilter, passes } from '../../src/onvif/event-filter.mjs';

const items = [{ kind: 'SimpleItem', name: 'Rule', value: 'MotionDetectorRule' }, { kind: 'SimpleItem', name: 'IsMotion', value: 'true' }];

describe('topic filters', () => {
  test('exact topics, any namespace prefix', () => {
    assert.ok(topicMatches('tns1:RuleEngine/CellMotionDetector/Motion', 'tns1:RuleEngine/CellMotionDetector/Motion'));
    assert.ok(topicMatches('onvif:RuleEngine/CellMotionDetector/Motion', 'tns1:RuleEngine/CellMotionDetector/Motion'));
    assert.ok(!topicMatches('tns1:VideoSource', 'tns1:VideoSource/MotionAlarm'));
  });

  test('alternatives with |, a level with *, everything below with //.', () => {
    assert.ok(topicMatches('tns1:Device/Trigger | tns1:VideoSource/MotionAlarm', 'tns1:VideoSource/MotionAlarm'));
    assert.ok(topicMatches('tns1:RuleEngine/*/Motion', 'tns1:RuleEngine/CellMotionDetector/Motion'));
    assert.ok(topicMatches('tns1:RuleEngine//.', 'tns1:RuleEngine/CellMotionDetector/Motion'));
    assert.ok(!topicMatches('tns1:Device//.', 'tns1:RuleEngine/CellMotionDetector/Motion'));
  });
});

describe('message content filters (ItemFilter)', () => {
  test('a simple item by name and value', () => {
    assert.ok(contentFilter('boolean(//tt:SimpleItem[@Name="IsMotion" and @Value="true"])')(items));
    assert.ok(!contentFilter('boolean(//tt:SimpleItem[@Name="IsMotion" and @Value="false"])')(items));
  });

  test('and, or, not and parentheses', () => {
    assert.ok(contentFilter('not(boolean(//tt:SimpleItem[@Name="State"])) and (boolean(//tt:SimpleItem[@Value="MotionDetectorRule"]) or boolean(//tt:ElementItem))')(items));
  });

  test('something it can\'t read is refused, not ignored', () => {
    assert.throws(() => contentFilter('count(//tt:SimpleItem) > 1'), { code: 'ter:InvalidArgVal' });
  });
});

test('a Filter element: either kind, escaped XML, unknown dialects refused', () => {
  const filter = readFilter('<wsnt:TopicExpression Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet">tns1:VideoSource//.</wsnt:TopicExpression>'
    + '<wsnt:MessageContent Dialect="http://www.onvif.org/ver10/tev/messageContentFilter/ItemFilter">boolean(//tt:SimpleItem[@Name=&quot;State&quot;])</wsnt:MessageContent>');
  assert.ok(passes(filter, { topic: 'tns1:VideoSource/MotionAlarm', items: [{ kind: 'SimpleItem', name: 'State', value: 'true' }] }));
  assert.ok(!passes(filter, { topic: 'tns1:RuleEngine/CellMotionDetector/Motion', items }));
  assert.ok(passes(readFilter(undefined), { topic: 'anything', items: [] }));
  assert.throws(() => readFilter('<TopicExpression Dialect="urn:mine">x</TopicExpression>'), { code: 'ter:InvalidArgVal' });
});
