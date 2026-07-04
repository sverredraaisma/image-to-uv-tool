import { describe, it, expect } from 'vitest';
import { bypassOutputs, findReadyAutoNode, gatherInputs } from './schedule';
import type { DataValue, GraphEdge, NodeRuntime, PortSpec } from '../types';

const edge = (source: string, sh: string, target: string, th: string): GraphEdge => ({
  id: `${source}.${sh}->${target}.${th}`,
  source,
  sourceHandle: sh,
  target,
  targetHandle: th,
});
const txt = (t: string): DataValue => ({ kind: 'text', text: t });

describe('gatherInputs', () => {
  const ports: PortSpec[] = [
    { id: 'in', label: 'in', type: 'text' },
    { id: 'many', label: 'many', type: 'text', multiple: true },
  ];
  const runtime: Record<string, NodeRuntime> = {
    s1: { status: 'upToDate', outputs: { out: txt('one') } },
    s2: { status: 'upToDate', outputs: { out: txt('two') } },
  };
  const edges = [
    edge('s1', 'out', 'n', 'in'),
    edge('s1', 'out', 'n', 'many'),
    edge('s2', 'out', 'n', 'many'),
  ];

  it('takes the first value for a single input and an array for a multiple input', () => {
    const inputs = gatherInputs(ports, edges, runtime, 'n');
    expect(inputs.in).toEqual(txt('one'));
    expect(inputs.many).toEqual([txt('one'), txt('two')]);
  });

  it('yields undefined / empty for unconnected ports', () => {
    const inputs = gatherInputs(ports, [], runtime, 'n');
    expect(inputs.in).toBeUndefined();
    expect(inputs.many).toEqual([]);
  });
});

describe('findReadyAutoNode', () => {
  const auto = (n: { type: string; bypassed?: boolean }) => n.type === 'auto' || n.bypassed === true;
  const rt = (m: Record<string, NodeRuntime['status']>): Record<string, NodeRuntime> =>
    Object.fromEntries(Object.entries(m).map(([k, status]) => [k, { status, outputs: {} }]));

  it('returns an out-of-date auto node with no upstream', () => {
    const nodes = [{ id: 'a', type: 'auto' }];
    expect(findReadyAutoNode(nodes, [], rt({ a: 'outOfDate' }), auto)).toBe('a');
  });

  it('skips up-to-date and manual nodes', () => {
    expect(findReadyAutoNode([{ id: 'a', type: 'auto' }], [], rt({ a: 'upToDate' }), auto)).toBeUndefined();
    expect(
      findReadyAutoNode([{ id: 'b', type: 'manual' }], [], rt({ b: 'outOfDate' }), auto),
    ).toBeUndefined();
  });

  it('treats a bypassed manual node as auto-runnable', () => {
    expect(
      findReadyAutoNode([{ id: 'b', type: 'manual', bypassed: true }], [], rt({ b: 'outOfDate' }), auto),
    ).toBe('b');
  });

  it('waits until upstream nodes are up to date', () => {
    const nodes = [
      { id: 'a', type: 'auto' },
      { id: 'c', type: 'auto' },
    ];
    const edges = [edge('a', 'out', 'c', 'in')];
    // a still out of date -> c not ready, and a itself is returned first
    expect(findReadyAutoNode(nodes, edges, rt({ a: 'outOfDate', c: 'outOfDate' }), auto)).toBe('a');
    // a up to date -> c becomes ready
    expect(findReadyAutoNode(nodes, edges, rt({ a: 'upToDate', c: 'outOfDate' }), auto)).toBe('c');
  });
});

describe('bypassOutputs', () => {
  const img: DataValue = { kind: 'image', width: 1, height: 1, data: new Uint8ClampedArray(4) };

  it('forwards the first type-compatible input to each output', () => {
    const inputs: PortSpec[] = [
      { id: 'a', label: 'a', type: 'text' },
      { id: 'b', label: 'b', type: 'image' },
    ];
    const outputs: PortSpec[] = [{ id: 'out', label: 'out', type: 'image' }];
    const result = bypassOutputs(inputs, outputs, { a: txt('x'), b: img });
    expect(result.out).toBe(img); // image output takes the image input, not the text
  });

  it('accepts an image value for a mask output and leaves unmatched outputs empty', () => {
    const inputs: PortSpec[] = [{ id: 'in', label: 'in', type: 'image' }];
    const outputs: PortSpec[] = [
      { id: 'mask', label: 'mask', type: 'mask' },
      { id: 'text', label: 'text', type: 'text' },
    ];
    const result = bypassOutputs(inputs, outputs, { in: img });
    expect(result.mask).toBe(img);
    expect(result.text).toBeUndefined();
  });
});
