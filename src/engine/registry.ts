import type { NodeDefinition, PortSpec } from '../types';

const registry = new Map<string, NodeDefinition>();

export function registerNode(def: NodeDefinition): void {
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
