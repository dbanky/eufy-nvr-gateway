import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pictureFilter, stillCommand } from '../../src/overlay/render-still.mjs';

describe('the sleeping look', () => {
  test('a blur of 10 px at 1080p, scaled with the frame height', () => {
    assert.match(pictureFilter({ height: 1080 }), /gblur=sigma=10\.0/);
    assert.match(pictureFilter({ height: 1620 }), /gblur=sigma=15\.0/);
  });

  test('dimmed and desaturated', () => {
    assert.match(pictureFilter({ height: 1080 }), /y=val\*0\.78/);
  });
});

describe('the ffmpeg command for a still', () => {
  const cam = { name: 'garden', width: 1920, height: 1080 };
  const layout = { icons: [], texts: [] };
  const command = (base) => stillCommand({ cam, base, layout, shapesFile: '/tmp/s.rgba', textFile: () => '/tmp/t.txt' });

  test('the last live frame is piped in raw', () => {
    const raw = Buffer.alloc(1);
    const { args, input } = command({ raw });
    assert.equal(input, raw);
    assert.ok(args.includes('pipe:0'));
  });

  test('a JPEG (from a camera passed through) is piped in as an image', () => {
    const jpeg = Buffer.from([0xff, 0xd8]);
    const { args, input } = command({ jpeg });
    assert.equal(input, jpeg);
    assert.equal(args[args.indexOf('pipe:0') - 2], 'image2pipe');
  });

  test('with no picture: a plain dark background, nothing to blur', () => {
    const { args } = command(null);
    assert.ok(args.some((a) => a.startsWith('color=c=0x15171C')));
    assert.ok(!args.join(' ').includes('gblur'));
  });
});
