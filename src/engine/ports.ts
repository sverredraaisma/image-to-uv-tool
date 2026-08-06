// Per-instance port resolution. Most nodes have fixed ports from their
// definition, but a few derive ports from their config: a Pipeline node exposes
// the inputs/outputs of its subgraph, and the Pipeline Input/Output markers
// carry a user-named port of a chosen type. Everything that needs a node's real
// ports goes through nodePorts() so these dynamic nodes work everywhere edges,
// previews and the scheduler are resolved.

import type { NodeConfig, NodeDefinition, PortSpec, PortType } from '../types';
import {
  DEFAULT_GRID,
  DEFAULT_RADIAL_VIEWS,
  clampGrid,
  clampRadialViews,
  gridCells,
  radialViews,
} from '../lib/lenticular';

const PORT_TYPES: readonly PortType[] = [
  'image',
  'mask',
  'text',
  'stl',
  'sequence',
  'splat',
  'transform',
];

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

/** One grid dimension out of config, clamped. */
function gridAxisOf(value: unknown, fallback: number): number {
  // Absent or unparseable falls back to the node's own default, not to the
  // minimum — a graph that lost the key must not silently shed ports.
  const raw = typeof value === 'number' ? value : parseFloat(String(value));
  return clampGrid(Number.isFinite(raw) ? raw : fallback);
}

/** The columns and rows a node instance is configured for. */
function gridOf(config: NodeConfig): { cols: number; rows: number } {
  const cols = gridAxisOf(config.grid, DEFAULT_GRID);
  // A graph saved before the grid could be oblong has no `gridY`; those were
  // square, so the columns are the right fallback.
  return { cols, rows: gridAxisOf(config.gridY, cols) };
}

/**
 * Largest grid that still gets one port per cell. A 4×4 is sixteen handles on
 * one node and sixteen wires to drag, which is about the limit of something a
 * person would actually do by hand; a 5×5 is twenty-five, and a 15×15 is 225 —
 * a node nobody can read, for a job nobody would do that way. Bigger grids are
 * fed by the `views` sequence alone, which is how a rendered grid arrives
 * anyway.
 */
export const MAX_CELL_PORT_GRID = 4;

/**
 * …and the same limit counted in ports, which is what an oblong grid has to be
 * judged by: 2×8 is as many handles as 4×4, and 3×15 is not a thing to wire.
 */
export const MAX_CELL_PORTS = MAX_CELL_PORT_GRID * MAX_CELL_PORT_GRID;

/**
 * Every cell of the grid, in row-major order and named for where it is viewed
 * from relative to head-on — whether or not it is exposed as a port. This is the
 * order a sequence on `views` is read in, so it is what the node and the editor
 * iterate; {@link lensGridCellInputs} is the subset that has real ports.
 */
export function lensGridCellSlots(config: NodeConfig): PortSpec[] {
  const { cols, rows } = gridOf(config);
  return gridCells(cols, rows).map((cell) => ({
    id: cell.id,
    label: cell.label,
    type: 'image' as const,
  }));
}

/**
 * The Lens Grid's inputs: a `views` port that takes the whole grid on one wire,
 * the way the lenticular node takes a whole animation, plus — up to
 * {@link MAX_CELL_PORT_GRID} — one image port per cell. Neither is marked
 * required on its own, because either route alone is enough; the node checks
 * that at compute time.
 */
export function lensGridInputs(config: NodeConfig): PortSpec[] {
  const { cols, rows } = gridOf(config);
  const cells = cols * rows <= MAX_CELL_PORTS ? lensGridCellSlots(config) : [];
  return [{ id: 'views', label: 'All views (sequence)', type: 'sequence' as const }, ...cells];
}

/** Just the per-cell image ports — empty on a grid too big to be wired by hand. */
export function lensGridCellInputs(config: NodeConfig): PortSpec[] {
  return lensGridInputs(config).filter((p) => p.id !== 'views');
}

/**
 * Missing-view labels for an error message, kept to a readable few. A 15×15 with
 * nothing wired has 225 of them, and a wall of names says less than a count.
 */
export function summariseMissing(labels: string[], keep = 6): string {
  if (labels.length <= keep) return labels.join(', ');
  return `${labels.slice(0, keep).join(', ')} … and ${labels.length - keep} more`;
}

/** The view count a radial node instance is configured for. */
function radialCountOf(config: NodeConfig): number {
  const raw = typeof config.views === 'number' ? config.views : parseFloat(String(config.views));
  return clampRadialViews(Number.isFinite(raw) ? raw : DEFAULT_RADIAL_VIEWS);
}

/**
 * The Radial Lens Print's inputs: one image per bearing around the circle, each
 * named for the angle it is seen from, plus an `all` port that takes the whole
 * ring on one wire. Same arrangement as the lens grid, and for the same reason.
 */
export function radialInputs(config: NodeConfig): PortSpec[] {
  return [
    { id: 'all', label: 'All views (sequence)', type: 'sequence' as const },
    ...radialViews(radialCountOf(config)).map((view) => ({
      id: view.id,
      label: view.label,
      type: 'image' as const,
    })),
  ];
}

/** Just the per-bearing image ports, in port order. */
export function radialViewInputs(config: NodeConfig): PortSpec[] {
  return radialInputs(config).filter((p) => p.id !== 'all');
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
    // One input per bearing around the circle, named for the angle it is seen
    // from.
    case 'radialGrid':
      return { inputs: radialInputs(node.config), outputs: def?.outputs ?? [] };
    default:
      return { inputs: def?.inputs ?? [], outputs: def?.outputs ?? [] };
  }
}
