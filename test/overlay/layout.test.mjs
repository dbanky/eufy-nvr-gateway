import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { layoutOverlay } from '../../src/overlay/layout.mjs';

// Pretend every character is half as wide as the font size.
const measureText = (font, text, size) => text.length * size * 0.5;
const sleeping = { kind: 'asleep', title: 'Sleeping', detail: 'since 18:33' };
const layout = (view = sleeping, width = 1920, height = 1080) => layoutOverlay({ width, height, view, measureText });
const label = (l) => l.shapes[1];   // shapes: [centre disc, label, icon chip]

describe('the label', () => {
  test('sits in the bottom-left corner, 3.5 % of the height away from both edges', () => {
    const l = label(layout());
    assert.ok(Math.abs(l.x - 37.8) < 0.01);
    assert.ok(Math.abs(1080 - (l.y + l.h) - 37.8) < 0.01);
  });

  test('is as wide as its longer line of text', () => {
    const short = label(layout());
    const long = label(layout({ ...sleeping, detail: 'since yesterday 22:10' }));
    assert.ok(long.w > short.w);
  });

  test('the text starts right of the icon chip', () => {
    const l = layout();
    const chip = l.shapes[2];
    assert.ok(l.texts[0].x > chip.x + chip.w);
  });

  test('everything scales with the frame height: 3K looks like 1080p', () => {
    const hd = label(layout(sleeping, 1920, 1080)), uhd = label(layout(sleeping, 3840, 2160));
    assert.ok(Math.abs(uhd.h - 2 * hd.h) < 0.01);
    assert.ok(Math.abs(uhd.w - 2 * hd.w) < 0.01);
  });
});

describe('the centre mark', () => {
  test('a disc in the middle of the frame with the state icon', () => {
    const l = layout();
    const disc = l.shapes[0];
    assert.equal(disc.x + disc.w / 2, 960);
    assert.equal(disc.y + disc.h / 2, 540);
    assert.equal(l.icons[0].name, 'moon');
  });

  test('waking up adds the spinner (animated in the loop)', () => {
    const l = layout({ kind: 'waking', title: 'Waking up', detail: 'Motion detected · 18:40' });
    assert.equal(l.icons[0].name, 'bolt');
    assert.equal(l.spinner.name, 'ring-arc');
  });

  test('every other state has no spinner', () => {
    assert.equal(layout().spinner, null);
  });
});

describe('no picture yet', () => {
  const l = layout({ kind: 'nopicture', title: 'No picture yet', detail: 'Appears after the first event' });

  test('has no label: the text is centred under the disc instead', () => {
    assert.equal(l.shapes.length, 1);
    assert.equal(l.texts[0].x, 'center');
    assert.ok(l.texts[0].y > l.shapes[0].y + l.shapes[0].h);
  });
});
