import { describe, it, expect } from 'vitest';
import {
  buildReplicateInput,
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
