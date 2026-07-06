// A rectangular region (position + size) passed between nodes as a `text`
// value. Split Region emits one; Place Image consumes it to composite a
// processed crop back exactly where it came from. JSON keeps it human-readable
// in a text preview and trivially parseable.

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function formatRegion(r: Region): string {
  return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height });
}

/** Parse a region from text, or null if it isn't a valid region object. */
export function parseRegion(text: string): Region | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const nums = [o?.x, o?.y, o?.width, o?.height];
    if (nums.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return { x: o.x as number, y: o.y as number, width: o.width as number, height: o.height as number };
    }
  } catch {
    /* not JSON / not a region */
  }
  return null;
}
