// Pure node-sizing heuristic, kept out of the React component so it can be
// unit-tested. Structural input type so tests don't need full NodeDefinitions.

export interface NodeLayoutInfo {
  inputs: { label: string }[];
  outputs: { label: string }[];
  configFields?: { label: string; advanced?: boolean; kind: string; multiline?: boolean }[];
}

const MIN = 214;
const MAX = 320;
const CHAR = 6.6;

/**
 * Pick a comfortable node width from its content: the longest port label (which
 * sits next to a fixed-size preview) and the longest inline field label, plus a
 * little extra for multiline text fields. Simple nodes stay compact; busy ones
 * grow up to a cap.
 */
export function nodeWidth(def: NodeLayoutInfo): number {
  const longestPort = [...def.inputs, ...def.outputs].reduce((m, p) => Math.max(m, p.label.length), 0);
  const fields = (def.configFields ?? []).filter((f) => !f.advanced);
  const longestField = fields.reduce((m, f) => Math.max(m, f.label.length), 0);
  const hasMultiline = fields.some((f) => f.kind === 'text' && f.multiline);

  const portW = longestPort * CHAR + 46 /* preview */ + 46; /* handle + gaps */
  const fieldW = longestField * CHAR + 132; /* control + padding */
  const width = Math.max(MIN, portW, fieldW, hasMultiline ? 250 : 0);
  return Math.round(Math.min(MAX, width));
}
