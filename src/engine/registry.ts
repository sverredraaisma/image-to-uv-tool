import type { NodeDefinition, PortSpec } from '../types';

const registry = new Map<string, NodeDefinition>();

export function registerNode(def: NodeDefinition): void {
  if (registry.has(def.type)) {
    // Two definitions claiming the same type is a bug (or an unintended plugin
    // clash); surface it instead of silently shadowing the earlier one.
    console.warn(`registerNode: overwriting existing node type "${def.type}"`);
  }
  registry.set(def.type, def);
}

export function getNodeDef(type: string): NodeDefinition {
  const def = registry.get(type);
  if (!def) throw new Error(`Unknown node type: ${type}`);
  return def;
}

export function getNodeDefSafe(type: string): NodeDefinition | undefined {
  return registry.get(type);
}

export function allNodeDefs(): NodeDefinition[] {
  return [...registry.values()];
}

export function findPort(ports: PortSpec[], id: string): PortSpec | undefined {
  return ports.find((p) => p.id === id);
}
