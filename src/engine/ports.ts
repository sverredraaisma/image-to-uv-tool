// Per-instance port resolution. Most nodes have fixed ports from their
// definition, but a few derive ports from their config: a Pipeline node exposes
// the inputs/outputs of its subgraph, and the Pipeline Input/Output markers
// carry a user-named port of a chosen type. Everything that needs a node's real
// ports goes through nodePorts() so these dynamic nodes work everywhere edges,
// previews and the scheduler are resolved.

import type { NodeConfig, NodeDefinition, PortSpec, PortType } from '../types';
import { DEFAULT_GRID, clampGrid, gridCells } from '../lib/lenticular';

const PORT_TYPES: readonly PortType[] = ['image', 'mask', 'text', 'stl', 'sequence'];

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

/** The grid size a node instance is configured for. */
function gridOf(config: NodeConfig): number {
  // Absent or unparseable falls back to the node's own default, not to the
  // minimum — a graph that lost the key must not silently shed ports.
  const raw = typeof config.grid === 'number' ? config.grid : parseFloat(String(config.grid));
  return clampGrid(Number.isFinite(raw) ? raw : DEFAULT_GRID);
}

/**
 * The Lens Grid's inputs: one image per cell of the view grid, in row-major
 * order, each named for where it is viewed from relative to head-on — plus a
 * `views` port that takes the whole grid on one wire, the way the lenticular
 * node takes a whole animation. Neither is marked required on its own, because
 * either route alone is enough; the node checks that at compute time.
 */
export function lensGridInputs(config: NodeConfig): PortSpec[] {
  return [
    { id: 'views', label: 'All views (sequence)', type: 'sequence' as const },
    ...gridCells(gridOf(config)).map((cell) => ({
      id: cell.id,
      label: cell.label,
      type: 'image' as const,
    })),
  ];
}

/** Just the per-cell image ports, in port order. */
export function lensGridCellInputs(config: NodeConfig): PortSpec[] {
  return lensGridInputs(config).filter((p) => p.id !== 'views');
}

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
    // One input per cell of the view grid, named for where it is viewed from.
    case 'lensGrid':
      return { inputs: lensGridInputs(node.config), outputs: def?.outputs ?? [] };
    default:
      return { inputs: def?.inputs ?? [], outputs: def?.outputs ?? [] };
  }
}
