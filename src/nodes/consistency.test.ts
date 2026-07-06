import { describe, it, expect } from 'vitest';
import '../nodes'; // register built-ins
import { allNodeDefs } from '../engine/registry';

const defs = allNodeDefs().filter((d) => !d.type.startsWith('test.'));
const VALID_PORT_TYPES = new Set(['image', 'mask', 'text', 'stl']);
// Pipeline nodes resolve their ports per-instance (from config) via nodePorts,
// so their static definition ports are intentionally empty.
const DYNAMIC_PORT_TYPES = new Set(['pipeline', 'pipelineInput', 'pipelineOutput']);

// A meta-test guarding every node definition — catches mistakes when adding
// nodes (typos, missing defaults, duplicate ids) before they reach the UI.
describe('node registry consistency', () => {
  it('registers a reasonable number of nodes', () => {
    expect(defs.length).toBeGreaterThan(20);
  });

  it('has unique node types', () => {
    const types = defs.map((d) => d.type);
    const dupes = types.filter((t, i) => types.indexOf(t) !== i);
    expect(dupes).toEqual([]);
  });

  it('every node has at least one output (except dynamic-port pipeline nodes)', () => {
    expect(
      defs.filter((d) => !DYNAMIC_PORT_TYPES.has(d.type) && d.outputs.length === 0).map((d) => d.type),
    ).toEqual([]);
  });

  it('text→image generation nodes expose a first-class seed field with a random default', () => {
    const generators = defs.filter((d) => d.group === 'Generate');
    expect(generators.length).toBeGreaterThan(0);
    for (const d of generators) {
      const seedField = (d.configFields ?? []).find((f) => f.key === 'seed');
      expect(seedField, `${d.type} missing seed field`).toBeTruthy();
      expect(d.defaultConfig().seed).toBe(''); // blank = random
    }
  });

  it('port ids are unique within a node and typed validly', () => {
    const problems: string[] = [];
    for (const d of defs) {
      const inIds = d.inputs.map((p) => p.id);
      const outIds = d.outputs.map((p) => p.id);
      if (new Set(inIds).size !== inIds.length) problems.push(`${d.type}: duplicate input id`);
      if (new Set(outIds).size !== outIds.length) problems.push(`${d.type}: duplicate output id`);
      for (const p of [...d.inputs, ...d.outputs]) {
        if (!VALID_PORT_TYPES.has(p.type)) problems.push(`${d.type}.${p.id}: bad type ${p.type}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every config field key has a matching default', () => {
    const missing: string[] = [];
    for (const d of defs) {
      const cfg = d.defaultConfig();
      for (const f of d.configFields ?? []) {
        if (!Object.prototype.hasOwnProperty.call(cfg, f.key)) missing.push(`${d.type}.${f.key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every AI node (Replicate + OpenRouter) is manual-run', () => {
    // Safety-critical: an auto-run AI node would spend API tokens on its own.
    const auto = defs.filter((d) => d.category.startsWith('AI (') && d.autoRun).map((d) => d.type);
    expect(auto).toEqual([]);
  });

  it('AI (Replicate) nodes declare a capability group', () => {
    const ungrouped = defs.filter((d) => d.category === 'AI (Replicate)' && !d.group).map((d) => d.type);
    expect(ungrouped).toEqual([]);
  });

  it('AI model slugs are well-formed (owner/name, optional :version)', () => {
    const bad: string[] = [];
    for (const d of defs.filter((d) => d.category === 'AI (Replicate)')) {
      const model = d.defaultConfig().model;
      // the "custom" node ships with an empty, user-supplied slug
      if (typeof model === 'string' && model !== '' && !/^[\w.-]+\/[\w.-]+(:[\da-f]+)?$/.test(model)) {
        bad.push(`${d.type}: "${model}"`);
      }
    }
    expect(bad).toEqual([]);
  });
});
