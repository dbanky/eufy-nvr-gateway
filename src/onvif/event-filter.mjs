// Event filters of a subscription (Profile S requires both kinds). Pure.
//
// TopicExpression (ConcreteSet dialect): topics separated by "|", each one exact, with "*" for any
//   one level, or ending in "//." for the topic and everything below it:
//     tns1:RuleEngine/CellMotionDetector/Motion | tns1:VideoSource//.
// MessageContent (ItemFilter dialect): XPath-like tests on the message's items:
//     boolean(//tt:SimpleItem[@Name="IsMotion" and @Value="true"])
//   combined with and, or, not(...) and parentheses.

import { OnvifFault } from './xml.mjs';

const TOPIC_DIALECTS = ['http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet', 'http://docs.oasis-open.org/wsn/t-1/TopicExpression/Concrete',
  'http://docs.oasis-open.org/wsn/t-1/TopicExpression/Simple'];
const CONTENT_DIALECT = 'http://www.onvif.org/ver10/tev/messageContentFilter/ItemFilter';

const levels = (topic) => topic.trim().split('/').map((level) => level.replace(/^[\w-]+:/, ''));

// Does the expression select this topic ("tns1:VideoSource/MotionAlarm")?
export function topicMatches(expression, topic) {
  const have = levels(topic);
  return expression.split('|').some((alternative) => {
    let want = alternative.trim();
    const below = want.endsWith('//.');
    if (below) want = want.slice(0, -3);
    const parts = levels(want);
    if (below ? have.length < parts.length : have.length !== parts.length) return false;
    return parts.every((p, i) => p === '*' || p === have[i]);
  });
}

// A predicate over a message's items ([{ kind: 'SimpleItem', name, value }]) from an ItemFilter expression.
export function contentFilter(expression) {
  const tokens = tokenize(expression);
  let at = 0;
  const peek = () => tokens[at];
  const take = (want) => {
    const t = tokens[at++];
    if (want && t !== want) throw invalid(expression);
    return t;
  };
  const primary = () => {
    const t = peek();
    if (t === '(') {
      take('(');
      const inner = or();
      take(')');
      return inner;
    }
    if (t === 'not(') {
      take();
      const inner = or();
      take(')');
      return (items) => !inner(items);
    }
    if (t?.test) return take().test;
    throw invalid(expression);
  };
  const and = () => {
    let left = primary();
    while (peek() === 'and') {
      take();
      const l = left, right = primary();
      left = (items) => l(items) && right(items);
    }
    return left;
  };
  const or = () => {
    let left = and();
    while (peek() === 'or') {
      take();
      const l = left, right = and();
      left = (items) => l(items) || right(items);
    }
    return left;
  };
  const filter = or();
  if (at !== tokens.length) throw invalid(expression);
  return filter;
}

const invalid = (expression) => new OnvifFault('ter:InvalidArgVal', `can't read the message content filter "${expression}"`);

// boolean(//tt:SimpleItem[@Name="X" and @Value="Y"]) becomes one token with a test.
function tokenize(expression) {
  const text = String(expression);
  const re = /\s*(?:(boolean\(\s*\/\/(?:[\w-]+:)?(SimpleItem|ElementItem)(?:\[([^\]]*)\])?\s*\))|(not\()|(\(|\))|(and|or)\b)/y;
  const tokens = [];
  while (text.slice(re.lastIndex).trim()) {
    const m = re.exec(text);
    if (!m) throw invalid(expression);
    tokens.push(m[1] ? { test: itemTest(m[2], m[3], expression) } : m[4] ?? m[5] ?? m[6]);
  }
  return tokens;
}

// [@Name="X" and @Value="Y"]: any item of that kind for which the conditions hold.
function itemTest(kind, condition, expression) {
  const parts = condition ? condition.split(/\s+(and|or)\s+/) : [];
  const checks = [];
  for (let i = 0; i < parts.length; i += 2) {
    const m = /^@(Name|Value)\s*=\s*["']([^"']*)["']$/.exec(parts[i].trim());
    if (!m) throw invalid(expression);
    checks.push({ field: m[1].toLowerCase(), value: m[2], join: parts[i - 1] ?? 'and' });
  }
  return (items) => items.some((item) => item.kind === kind && checks.reduce((ok, c, i) => {
    const hit = item[c.field] === c.value;
    return i === 0 ? hit : c.join === 'and' ? ok && hit : ok || hit;
  }, true));
}

// The filter of a subscription request: { topic: expression | null, content: predicate | null }.
// filterXml: the inner XML of the request's Filter element.
export function readFilter(filterXml) {
  if (!filterXml) return { topic: null, content: null };
  const topic = /<(?:[\w-]+:)?TopicExpression\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?TopicExpression>/.exec(filterXml);
  const content = /<(?:[\w-]+:)?MessageContent\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?MessageContent>/.exec(filterXml);
  const dialect = (attrs) => /Dialect\s*=\s*"([^"]*)"/.exec(attrs)?.[1] ?? null;
  if (topic && dialect(topic[1]) && !TOPIC_DIALECTS.includes(dialect(topic[1]))) {
    throw new OnvifFault('ter:InvalidArgVal', `unknown topic expression dialect ${dialect(topic[1])}`);
  }
  if (content && dialect(content[1]) && dialect(content[1]) !== CONTENT_DIALECT) {
    throw new OnvifFault('ter:InvalidArgVal', `unknown message content dialect ${dialect(content[1])}`);
  }
  const unescape = (s) => s.trim().replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return { topic: topic ? unescape(topic[2]) : null, content: content ? contentFilter(unescape(content[2])) : null };
}

// Does a subscription with this filter get this event ({ topic, items })?
export const passes = (filter, event) => (!filter.topic || topicMatches(filter.topic, event.topic)) && (!filter.content || filter.content(event.items));
