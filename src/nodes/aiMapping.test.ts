import { describe, it, expect } from 'vitest';
import {
  buildReplicateInput,
  coerceScalar,
  MAX_AI_IMAGE_BYTES,
  pickOutput,
  resolveOutputs,
  type AiOutput,
  type AiPort,
  type AiScalar,
} from './aiMapping';
import { createImage } from '../lib/image';
import type { DataValue } from '../types';

const enc = () => 'ENC';
const img = createImage(1, 1, [1, 2, 3, 4]);
const text = (t: string): DataValue => ({ kind: 'text', text: t });

describe('coerceScalar', () => {
  it('coerces number fields to numbers', () => {
    expect(coerceScalar({ kind: 'number', key: 'k', label: 'K' }, '3.5')).toBe(3.5);
  });
  it('coerces boolean fields to booleans', () => {
    expect(coerceScalar({ kind: 'boolean', key: 'k', label: 'K' }, 1)).toBe(true);
    expect(coerceScalar({ kind: 'boolean', key: 'k', label: 'K' }, '')).toBe(false);
  });
  it('passes select/text/colour values through unchanged (e.g. "4:3" stays a string)', () => {
    const sel = { kind: 'select' as const, key: 'aspect_ratio', label: 'Aspect', options: [] };
    expect(coerceScalar(sel, '4:3')).toBe('4:3');
    expect(coerceScalar({ kind: 'text', key: 'k', label: 'K' }, '16:9')).toBe('16:9');
    expect(coerceScalar({ kind: 'color', key: 'k', label: 'K' }, '#ffffff')).toBe('#ffffff');
  });
});

describe('buildReplicateInput', () => {
  const imagePort: AiPort = { id: 'image', label: 'Image', type: 'image', key: 'image', required: true };
  const promptPort: AiPort = { id: 'prompt', label: 'Prompt', type: 'text', key: 'prompt' };

  it('encodes images, sets text, and coerces scalars', () => {
    const scalars: AiScalar[] = [{ field: { kind: 'number', key: 'scale', label: 'Scale' }, default: 4 }];
    const input = buildReplicateInput(
      [imagePort, promptPort],
      scalars,
      { imageKey: 'image', promptKey: 'prompt', prompt: '', scale: '4', extraInputs: '' },
      { image: img, prompt: text('a cat') },
      enc,
    );
    expect(input).toEqual({ image: 'ENC', prompt: 'a cat', scale: 4 });
  });

  it('throws on a missing required input', () => {
    expect(() => buildReplicateInput([imagePort], [], { imageKey: 'image' }, {}, enc)).toThrow(/Image/);
  });

  it('falls back to the inline text value when nothing is wired', () => {
    const input = buildReplicateInput(
      [{ ...promptPort, required: true }],
      [],
      { promptKey: 'prompt', prompt: 'typed' },
      {},
      enc,
    );
    expect(input).toEqual({ prompt: 'typed' });
  });

  it('uses the inline value when the wired text is empty, but the wire when non-empty', () => {
    const empty = buildReplicateInput(
      [promptPort],
      [],
      { promptKey: 'prompt', prompt: 'typed' },
      { prompt: text('') },
      enc,
    );
    expect(empty).toEqual({ prompt: 'typed' });

    const wired = buildReplicateInput(
      [promptPort],
      [],
      { promptKey: 'prompt', prompt: 'typed' },
      { prompt: text('from wire') },
      enc,
    );
    expect(wired).toEqual({ prompt: 'from wire' });
  });

  it('honours the editable input key', () => {
    const input = buildReplicateInput(
      [{ ...imagePort, required: false }],
      [],
      { imageKey: 'input_image' },
      { image: img },
      enc,
    );
    expect(input).toEqual({ input_image: 'ENC' });
  });

  it('merges Extra inputs JSON and rejects invalid JSON', () => {
    expect(buildReplicateInput([], [], { extraInputs: '{"guidance":3.5}' }, {}, enc)).toEqual({ guidance: 3.5 });
    expect(() => buildReplicateInput([], [], { extraInputs: '{bad' }, {}, enc)).toThrow(/JSON/);
  });

  it('omits empty scalars', () => {
    const scalars: AiScalar[] = [{ field: { kind: 'number', key: 'scale', label: 'S' }, default: '' }];
    expect(buildReplicateInput([], scalars, { scale: '' }, {}, enc)).toEqual({});
  });

  it('rejects an encoded image that exceeds the size ceiling with an actionable error', () => {
    const huge = 'data:image/png;base64,' + 'A'.repeat(Math.ceil((MAX_AI_IMAGE_BYTES + 1) / 0.75));
    expect(() =>
      buildReplicateInput([imagePort], [], { imageKey: 'image' }, { image: img }, () => huge),
    ).toThrow(/too large|Resize/i);
  });

  it('accepts an image comfortably under the ceiling', () => {
    const small = 'data:image/png;base64,' + 'A'.repeat(1000);
    expect(buildReplicateInput([imagePort], [], { imageKey: 'image' }, { image: img }, () => small)).toEqual({
      image: small,
    });
  });
});

describe('pickOutput', () => {
  it('selects by array index, object key, or passes through', () => {
    expect(pickOutput(['a', 'b'], { id: 'x', label: 'x', type: 'image', index: 1 })).toBe('b');
    expect(pickOutput({ k: 'v' }, { id: 'x', label: 'x', type: 'image', key: 'k' })).toBe('v');
    expect(pickOutput('z', { id: 'x', label: 'x', type: 'image' })).toBe('z');
  });
});

describe('resolveOutputs', () => {
  const out = (o: Partial<AiOutput>): AiOutput => ({ id: 'out', label: 'o', type: 'image', ...o });

  it('resolves a single default image output', () => {
    expect(resolveOutputs([out({})], 'http://x/a.png', true)).toEqual({ out: { url: 'http://x/a.png' } });
  });

  it('resolves array outputs by index', () => {
    const ports = [out({ id: 'mask', index: 2 })];
    expect(resolveOutputs(ports, ['a', 'b', 'http://x/c.png'], false)).toEqual({
      mask: { url: 'http://x/c.png' },
    });
  });

  it('resolves object outputs by key', () => {
    const ports = [out({ id: 'grey', key: 'grey_depth' })];
    const output = { grey_depth: 'http://x/g.png', color_depth: 'http://x/c.png' };
    expect(resolveOutputs(ports, output, false)).toEqual({ grey: { url: 'http://x/g.png' } });
  });

  it('resolves text outputs', () => {
    expect(resolveOutputs([out({ type: 'text' })], 'a caption', true)).toEqual({ out: { text: 'a caption' } });
  });

  it('maps missing outputs to undefined', () => {
    expect(resolveOutputs([out({})], null, true)).toEqual({ out: undefined });
  });
});
