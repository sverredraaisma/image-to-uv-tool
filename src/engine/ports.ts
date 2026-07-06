// Per-instance port resolution. Most nodes have fixed ports from their
// definition, but a few derive ports from their config: a Pipeline node exposes
// the inputs/outputs of its subgraph, and the Pipeline Input/Output markers
// carry a user-named port of a chosen type. Everything that needs a node's real
// ports goes through nodePorts() so these dynamic nodes work everywhere edges,
// previews and the scheduler are resolved.

import type { NodeConfig, NodeDefinition, PortSpec, PortType } from '../types';

const PORT_TYPES: readonly PortType[] = ['image', 'mask', 'text', 'stl'];

export function asPortType(v: unknown, fallback: PortType = 'image'): PortType {
  return typeof v === 'string' && (PORT_TYPES as readonly string[]).includes(v) ? (v as PortType) : fallback;
}

/** Validate an array of PortSpec-shaped objects stored in config. */
export function portsFromConfig(v: unknown): PortSpec[] {
  if (!Array.isArray(v)) return [];
  const out: PortSpec[] = [];
  for (const raw of v) {
    const p = raw as {
      id?: unknown;
      label?: unknown;
      type?: unknown;
      multiple?: unknown;
      required?: unknown;
    };
    if (typeof p?.id !== 'string' || typeof p?.label !== 'string') continue;
    out.push({
      id: p.id,
      label: p.label,
      type: asPortType(p.type),
      multiple: !!p.multiple,
      required: !!p.required,
    });
  }
  return out;
}

const named = (config: NodeConfig, fallback: string): string => {
  const n = config.name;
  return typeof n === 'string' && n.trim() ? n : fallback;
};

export interface ResolvedPorts {
  inputs: PortSpec[];
  outputs: PortSpec[];
}

/**
 * The actual input/output ports of a node instance. Falls back to the static
 * definition ports for ordinary nodes.
 */
export function nodePorts(node: { type: string; config: NodeConfig }, def?: NodeDefinition): ResolvedPorts {
  switch (node.type) {
    case 'pipeline':
      return { inputs: portsFromConfig(node.config.inputs), outputs: portsFromConfig(node.config.outputs) };
    case 'pipelineInput':
      return {
        inputs: [],
        outputs: [{ id: 'out', label: named(node.config, 'Input'), type: asPortType(node.config.type) }],
      };
    case 'pipelineOutput':
      return {
        inputs: [{ id: 'in', label: named(node.config, 'Output'), type: asPortType(node.config.type) }],
        outputs: [],
      };
    default:
      return { inputs: def?.inputs ?? [], outputs: def?.outputs ?? [] };
  }
}
