import { describe, it, expect } from 'vitest';
import '../nodes'; // register built-ins
import { allNodeDefs } from '../engine/registry';
import { useStore } from '../store/store';
import { NODE_HELP, helpFor } from './nodeHelp';

const defs = allNodeDefs();

describe('node help', () => {
  it('covers every registered node — a node nobody can explain is a node nobody uses', () => {
    const missing = defs.filter((d) => !NODE_HELP[d.type]).map((d) => d.type);
    expect(missing).toEqual([]);
  });

  it('has no entries for nodes that no longer exist', () => {
    const known = new Set(defs.map((d) => d.type));
    expect(Object.keys(NODE_HELP).filter((t) => !known.has(t))).toEqual([]);
  });

  it('gives every node a summary and at least one worked example', () => {
    const problems: string[] = [];
    for (const [type, help] of Object.entries(NODE_HELP)) {
      if (help.summary.trim().length < 20) problems.push(`${type}: summary too thin`);
      if (help.uses.length < 1) problems.push(`${type}: no uses`);
      for (const use of help.uses) {
        if (!use.title.trim()) problems.push(`${type}: use without a title`);
        if (use.detail.trim().length < 20) problems.push(`${type}: "${use.title}" has no detail`);
        if (use.chain && use.chain.length < 2) problems.push(`${type}: "${use.title}" chain is not a chain`);
      }
      for (const tip of help.tips ?? []) if (!tip.trim()) problems.push(`${type}: empty tip`);
    }
    expect(problems).toEqual([]);
  });

  it('never opens for a node type the registry does not know', () => {
    const { openHelp } = useStore.getState();
    openHelp('no-such-node');
    expect(useStore.getState().helpNodeType).toBeNull();
    openHelp('blur');
    expect(useStore.getState().helpNodeType).toBe('blur');
    openHelp(null);
    expect(useStore.getState().helpNodeType).toBeNull();
  });

  it('falls back to something useful for an unknown node', () => {
    const help = helpFor({
      type: 'plugin.mystery',
      label: 'Mystery',
      category: 'Elsewhere',
      description: 'Does a thing.',
      autoRun: true,
      inputs: [],
      outputs: [],
      defaultConfig: () => ({}),
      compute: () => ({}),
    });
    expect(help.summary).toBe('Does a thing.');
    expect(help.uses.length).toBeGreaterThan(0);
  });

  it('returns the authored entry for a known node', () => {
    const def = defs.find((d) => d.type === 'lenticular')!;
    expect(helpFor(def)).toBe(NODE_HELP.lenticular);
    expect(helpFor(def).uses.some((u) => u.title.toLowerCase().includes('animation'))).toBe(true);
  });
});
