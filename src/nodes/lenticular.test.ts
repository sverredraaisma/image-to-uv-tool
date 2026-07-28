import { describe, it, expect } from 'vitest';
import { lenticularNode, settingsFromConfig } from './lenticular';
import { createImage } from '../lib/image';
import type { ComputeContext, DataValue, RasterImage } from '../types';

// Pure node (no platform / network), so drive compute() directly.
const ctx = (inputs: Record<string, DataValue | DataValue[] | undefined>, config: Record<string, unknown>) =>
  ({ inputs, config }) as unknown as ComputeContext;

const RED = createImage(20, 20, [255, 0, 0, 255]);
const BLUE = createImage(20, 20, [0, 0, 255, 255]);

/** Config that renders a fast 100×100 output with 10 px lenticules. */
const config = (over: Record<string, unknown> = {}) => ({
  ...lenticularNode.defaultConfig(),
  widthMm: 25.4,
  ppi: 100,
  lpi: 10,
  heightMm: 5,
  ...over,
});

const px = (img: RasterImage, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

describe('Lenticular Print node', () => {
  it('is manual-run, takes many frames, and opens a custom editor', () => {
    expect(lenticularNode.autoRun).toBe(false);
    expect(lenticularNode.customEditor).toBe('lenticular');
    const frames = lenticularNode.inputs.find((p) => p.id === 'frames');
    expect(frames?.multiple).toBe(true);
    expect(frames?.required).toBe(true);
  });

  it('ships the documented defaults', () => {
    const cfg = lenticularNode.defaultConfig();
    expect(cfg.ppi).toBe(1440);
    expect(cfg.lpi).toBe(45);
    expect(cfg.phase).toBe(0);
    expect(cfg.heightMm).toBe(0.9);
    expect(cfg.ri).toBe(1.5);
    expect(cfg.orientationDeg).toBe(0);
  });

  it('interlaces the frames and emits a depth preview and an info report', async () => {
    const out = await lenticularNode.compute(ctx({ frames: [RED, BLUE] }, config()));
    const interlaced = out.interlaced as RasterImage;
    const depth = out.depth as RasterImage;
    expect(interlaced.width).toBe(100);
    expect(px(interlaced, 0, 0)).toEqual([255, 0, 0]);
    expect(px(interlaced, 5, 0)).toEqual([0, 0, 255]);
    expect(depth.width).toBe(interlaced.width);
    expect(depth.height).toBe(interlaced.height);
    // Depth preview is greyscale, brightest at the lenticule apex.
    expect(px(depth, 5, 0)[0]).toBeGreaterThan(px(depth, 0, 0)[0]);
    expect(out.info?.kind).toBe('text');
    if (out.info?.kind === 'text') expect(out.info.text).toContain('2 frames');
  });

  it('interlaces three or more frames', async () => {
    const green = createImage(20, 20, [0, 255, 0, 255]);
    const out = await lenticularNode.compute(ctx({ frames: [RED, green, BLUE] }, config()));
    const img = out.interlaced as RasterImage;
    expect(px(img, 0, 0)).toEqual([255, 0, 0]);
    expect(px(img, 4, 0)).toEqual([0, 255, 0]);
    expect(px(img, 8, 0)).toEqual([0, 0, 255]);
  });

  it('rejects fewer than two frames', async () => {
    await expect(lenticularNode.compute(ctx({ frames: [RED] }, config()))).rejects.toThrow(
      /at least 2 images \(got 1\)/,
    );
    await expect(lenticularNode.compute(ctx({ frames: undefined }, config()))).rejects.toThrow(
      /at least 2 images \(got 0\)/,
    );
  });

  it('warns in the info report when the lens cannot focus in the given height', async () => {
    const out = await lenticularNode.compute(
      ctx({ frames: [RED, BLUE] }, config({ lpi: 10, heightMm: 0.5 })),
    );
    if (out.info?.kind === 'text') expect(out.info.text).toContain('cannot focus');
    else throw new Error('expected a text info output');
  });
});

describe('settingsFromConfig', () => {
  it('reads the printed settings and coerces strings from the number fields', () => {
    expect(settingsFromConfig({ widthMm: '150', ppi: '720', lpi: '60', phase: '0.5' })).toMatchObject({
      widthMm: 150,
      ppi: 720,
      lpi: 60,
      phase: 0.5,
    });
  });

  it('falls back to the defaults for missing or nonsensical values', () => {
    expect(settingsFromConfig({})).toEqual({
      widthMm: 100,
      ppi: 1440,
      lpi: 45,
      phase: 0,
      heightMm: 0.9,
      ri: 1.5,
      orientationDeg: 0,
    });
    // RI below 1 would invert the optics; height of 0 would divide by zero.
    expect(settingsFromConfig({ ri: 0.2, heightMm: 0 }).ri).toBeGreaterThan(1);
    expect(settingsFromConfig({ ri: 0.2, heightMm: 0 }).heightMm).toBeGreaterThan(0);
  });
});
