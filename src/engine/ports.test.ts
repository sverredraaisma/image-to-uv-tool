import { describe, it, expect } from 'vitest';
import { nodePorts, portsFromConfig, asPortType } from './ports';
import type { NodeDefinition } from '../types';

const def = (over: Partial<NodeDefinition> = {}): NodeDefinition => ({
  type: 'x',
  label: 'X',
  category: 'Adjust',
  autoRun: true,
  inputs: [{ id: 'in', label: 'In', type: 'image' }],
  outputs: [{ id: 'out', label: 'Out', type: 'image' }],
  defaultConfig: () => ({}),
  compute: () => ({}),
  ...over,
});

describe('nodePorts', () => {
  it('returns the static ports for ordinary nodes', () => {
    const d = def();
    const p = nodePorts({ type: 'x', config: {} }, d);
    expect(p.inputs).toBe(d.inputs);
    expect(p.outputs).toBe(d.outputs);
  });

  it('derives a Pipeline node ports from its config', () => {
    const p = nodePorts(
      {
        type: 'pipeline',
        config: {
          inputs: [{ id: 'a', label: 'Photo', type: 'image' }],
          outputs: [{ id: 'b', label: 'Caption', type: 'text' }],
        },
      },
      def({ type: 'pipeline', inputs: [], outputs: [] }),
    );
    expect(p.inputs).toEqual([{ id: 'a', label: 'Photo', type: 'image', multiple: false, required: false }]);
    expect(p.outputs).toEqual([{ id: 'b', label: 'Caption', type: 'text', multiple: false, required: false }]);
  });

  it('gives a pipelineInput a single typed output named from config', () => {
    const p = nodePorts({ type: 'pipelineInput', config: { name: 'Mask', type: 'mask' } });
    expect(p.inputs).toEqual([]);
    expect(p.outputs).toEqual([{ id: 'out', label: 'Mask', type: 'mask' }]);
  });

  it('gives a pipelineOutput a single typed input, default name + type', () => {
    const p = nodePorts({ type: 'pipelineOutput', config: {} });
    expect(p.outputs).toEqual([]);
    expect(p.inputs).toEqual([{ id: 'in', label: 'Output', type: 'image' }]);
  });
});

describe('portsFromConfig / asPortType', () => {
  it('drops malformed port entries', () => {
    const ports = portsFromConfig([{ id: 'a', label: 'A', type: 'text' }, { id: 5 }, null, 'x']);
    expect(ports).toHaveLength(1);
    expect(ports[0].type).toBe('text');
  });

  it('falls back to image for unknown port types', () => {
    expect(asPortType('bogus')).toBe('image');
    expect(asPortType('stl')).toBe('stl');
  });
});
