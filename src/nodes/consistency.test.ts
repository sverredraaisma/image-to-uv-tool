import { describe, it, expect } from 'vitest';
import '../nodes'; // register built-ins
import { allNodeDefs } from '../engine/registry';

const defs = allNodeDefs().filter((d) => !d.type.startsWith('test.'));
const VALID_PORT_TYPES = new Set(['image', 'mask', 'text', 'stl']);

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

  it('every node has at least one output', () => {
    expect(defs.filter((d) => d.outputs.length === 0).map((d) => d.type)).toEqual([]);
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

  it('AI (Replicate) nodes declare a capability group and are manual-run', () => {
    const bad: string[] = [];
    for (const d of defs.filter((d) => d.category === 'AI (Replicate)')) {
      if (!d.group) bad.push(`${d.type}: no group`);
      if (d.autoRun) bad.push(`${d.type}: should be manual`);
    }
    expect(bad).toEqual([]);
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
