import { describe, it, expect } from 'vitest';
import { nodeWidth, type NodeLayoutInfo } from './nodeLayout';

const def = (over: Partial<NodeLayoutInfo>): NodeLayoutInfo => ({
  inputs: [],
  outputs: [],
  ...over,
});

describe('nodeWidth', () => {
  it('keeps simple nodes at the minimum width', () => {
    const w = nodeWidth(def({ inputs: [{ label: 'In' }], outputs: [{ label: 'Out' }] }));
    expect(w).toBe(214);
  });

  it('widens for long port labels', () => {
    const w = nodeWidth(def({ outputs: [{ label: 'Negative mask preview label' }] }));
    expect(w).toBeGreaterThan(214);
    expect(w).toBeLessThanOrEqual(320);
  });

  it('widens for multiline text fields', () => {
    const w = nodeWidth(
      def({ configFields: [{ label: 'Prompt', kind: 'text', multiline: true }] }),
    );
    expect(w).toBeGreaterThanOrEqual(250);
  });

  it('ignores advanced fields and caps at the maximum', () => {
    const compact = nodeWidth(
      def({ configFields: [{ label: 'A very long advanced field label here', kind: 'text', advanced: true }] }),
    );
    expect(compact).toBe(214);
    const huge = nodeWidth(def({ outputs: [{ label: 'x'.repeat(200) }] }));
    expect(huge).toBe(320);
  });
});
