import { describe, it, expect } from 'vitest';
import { graphFileName } from './download';

describe('graphFileName', () => {
  it('builds a timestamped .json name from a date (UTC)', () => {
    expect(graphFileName(new Date('2026-07-04T03:45:12.000Z'))).toBe('node-graph-2026-07-04-03-45.json');
  });
  it('zero-pads month/day/time components', () => {
    expect(graphFileName(new Date('2026-01-02T09:08:00.000Z'))).toBe('node-graph-2026-01-02-09-08.json');
  });
});
