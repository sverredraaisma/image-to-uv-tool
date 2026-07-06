// Pure logic for the "Add node" menu: filter by search, then order categories
// and AI capability groups deliberately (not by registration order), with items
// sorted alphabetically. Kept free of React so it is directly unit-testable.

export interface MenuNode {
  type: string;
  label: string;
  description?: string;
  category: string;
  group?: string;
  /** Generative-AI node — hidden when the "Gen AI" toggle is off. */
  genAI?: boolean;
}

export interface MenuGroup {
  group: string; // '' = ungrouped
  items: MenuNode[];
}

export interface MenuCategory {
  category: string;
  groups: MenuGroup[];
}

export const CATEGORY_ORDER = [
  'Input',
  'Compose',
  'Adjust',
  'Transform',
  'Mask',
  'UV',
  'Export',
  'Pipeline',
  'AI (Replicate)',
  'AI (OpenRouter)',
];

export const GROUP_ORDER = [
  'Generate',
  'Edit',
  'Stylize',
  'Segment',
  'Depth',
  'Background removal',
  'Restore & upscale',
  'Describe',
  'Custom',
];

const rank = (order: string[], v: string): number => {
  const i = order.indexOf(v);
  return i < 0 ? order.length : i;
};

const orderedKeys = (values: Iterable<string>, order: string[]): string[] =>
  [...new Set(values)].sort((a, b) => rank(order, a) - rank(order, b) || a.localeCompare(b));

/**
 * Build the grouped, sorted, filtered menu structure. `test.*` node types are
 * excluded. An empty query returns everything. When `showGenAI` is false,
 * generative-AI nodes are hidden.
 */
export function buildNodeMenu(nodes: MenuNode[], query = '', showGenAI = true): MenuCategory[] {
  const q = query.trim().toLowerCase();
  const visible = nodes.filter((n) => {
    if (n.type.startsWith('test.')) return false;
    if (!showGenAI && n.genAI) return false;
    if (!q) return true;
    return `${n.label} ${n.description ?? ''} ${n.category} ${n.group ?? ''}`.toLowerCase().includes(q);
  });

  return orderedKeys(
    visible.map((n) => n.category),
    CATEGORY_ORDER,
  ).map((category) => {
    const catItems = visible.filter((n) => n.category === category);
    const groups = orderedKeys(
      catItems.map((n) => n.group ?? ''),
      GROUP_ORDER,
    ).map((group) => ({
      group,
      items: catItems.filter((n) => (n.group ?? '') === group).sort((a, b) => a.label.localeCompare(b.label)),
    }));
    return { category, groups };
  });
}
