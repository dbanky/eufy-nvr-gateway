// Every state shown on the stream has its own icon, drawn from assets/icons, and the web page knows it too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { STATES } from '../../src/overlay/design.mjs';
import { icon } from '../../src/switcher/web/static/icons.js';

test('each state has an icon of its own on the stream and on the web page', () => {
  const icons = Object.values(STATES).map((s) => s.icon);
  assert.equal(new Set(icons).size, icons.length, 'colour never carries meaning alone: one icon per state');
  for (const [kind, { icon: name }] of Object.entries(STATES)) {
    assert.ok(existsSync(new URL(`../../assets/icons/${name}.svg`, import.meta.url)), `assets/icons/${name}.svg for ${kind}`);
    assert.match(icon(kind), /<svg/, `web icon for ${kind}`);
  }
});
