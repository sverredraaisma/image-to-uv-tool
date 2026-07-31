// Pins the pseudocode published in docs/printed-lenses.md, under
// "Doing it yourself → From scratch".
//
// That listing is the whole method, written out for someone reimplementing it
// from the document alone. It is only worth publishing if it is *true*, so the
// port below is literal — same variable names, same order — and is asserted to
// produce byte-identical output to the real renderers, at a configuration
// awkward enough to catch a sign or rounding slip: a 23° array, a phase that
// isn't 0, three views, and odd pixel dimensions.
//
// If this fails, either the code changed or the guide is now lying. Fix
// whichever is wrong; don't relax the assertion.

import { describe, it, expect } from 'vitest';
import { createImage } from './image';
import { renderInterlaced, renderDepthMap, type LenticularSettings } from './lenticular';
import type { RasterImage } from '../types';

// A literal port of the pseudocode published in docs/printed-lenses.md.
function docImplementation(views: RasterImage[], p: LenticularSettings) {
  const { widthMm: width_mm, ppi: PPI, lpi: LPI, ri: n, heightMm: H, phase, stripSamples: q } = p;
  const o = (p.orientationDeg * Math.PI) / 180;
  const N = views.length;
  const height_mm = (width_mm * views[0].height) / views[0].width;
  const frac = (v: number) => v - Math.floor(v);

  const pitch = 25.4 / LPI;
  const disc = H * H * (n - 1) ** 2 - (n * n * pitch * pitch) / 4;
  const s = disc < 0 ? pitch / 2 : (H * (n - 1) - Math.sqrt(disc)) / n;
  const R = (s * s + (pitch / 2) ** 2) / (2 * s);
  const b = Math.max(0, H - s);

  const bilinear = (img: RasterImage, u: number, v: number, out: Uint8ClampedArray, at: number) => {
    const fx = Math.min(img.width - 1, Math.max(0, u * img.width - 0.5));
    const fy = Math.min(img.height - 1, Math.max(0, v * img.height - 0.5));
    const x0 = Math.floor(fx),
      y0 = Math.floor(fy);
    const x1 = Math.min(img.width - 1, x0 + 1),
      y1 = Math.min(img.height - 1, y0 + 1);
    const tx = fx - x0,
      ty = fy - y0;
    for (let c = 0; c < 4; c++) {
      const t =
        img.data[(y0 * img.width + x0) * 4 + c] * (1 - tx) + img.data[(y0 * img.width + x1) * 4 + c] * tx;
      const bo =
        img.data[(y1 * img.width + x0) * 4 + c] * (1 - tx) + img.data[(y1 * img.width + x1) * 4 + c] * tx;
      out[at + c] = t * (1 - ty) + bo * ty;
    }
  };

  const cells = width_mm / pitch;
  const map_w = Math.round((width_mm / 25.4) * PPI);
  const art_w = Math.min(map_w, Math.max(Math.ceil(cells * N * q), ...views.map((v) => v.width)));
  const art_h = Math.round((art_w * views[0].height) / views[0].width);
  const art = createImage(art_w, art_h, [255, 255, 255, 255]);
  let mmPerPx = width_mm / art_w;
  for (let py = 0; py < art_h; py++) {
    for (let px = 0; px < art_w; px++) {
      const x = (px + 0.5) * mmPerPx,
        y = (py + 0.5) * mmPerPx;
      const u = x * Math.cos(o) + y * Math.sin(o);
      const v = -x * Math.sin(o) + y * Math.cos(o);
      const sig = u / pitch + phase;
      const j = Math.floor(sig),
        t = sig - j;
      const k = Math.min(N - 1, Math.floor(t * N));
      const u_c = (j + 0.5 - phase) * pitch;
      const sx = u_c * Math.cos(o) - v * Math.sin(o);
      const sy = u_c * Math.sin(o) + v * Math.cos(o);
      bilinear(views[k], sx / width_mm, sy / height_mm, art.data, (py * art_w + px) * 4);
    }
  }

  const map_h = Math.round((map_w * views[0].height) / views[0].width);
  const depth = new Uint16Array(map_w * map_h);
  mmPerPx = width_mm / map_w;
  for (let py = 0; py < map_h; py++) {
    for (let px = 0; px < map_w; px++) {
      const x = (px + 0.5) * mmPerPx,
        y = (py + 0.5) * mmPerPx;
      const u = x * Math.cos(o) + y * Math.sin(o);
      const t = frac(u / pitch + phase);
      const d = (t - 0.5) * pitch;
      const z = b + Math.max(0, Math.sqrt(Math.max(0, R * R - d * d)) - (R - s));
      depth[py * map_w + px] = Math.round(Math.min(1, z / H) * 65535);
    }
  }
  return { art, depth, map_w, map_h };
}

const settings: LenticularSettings = {
  widthMm: 25.4,
  ppi: 200,
  lpi: 12,
  phase: 0.3,
  heightMm: 4,
  ri: 1.52,
  orientationDeg: 23,
  stripSamples: 2,
};
const ramp = (seed: number) => {
  const img = createImage(31, 23);
  for (let i = 0; i < 31 * 23; i++) {
    img.data[i * 4] = (i * 7 + seed * 53) % 256;
    img.data[i * 4 + 1] = (i * 3 + seed * 11) % 256;
    img.data[i * 4 + 2] = (i + seed * 97) % 256;
    img.data[i * 4 + 3] = 255;
  }
  return img;
};

describe('docs/printed-lenses.md pseudocode', () => {
  const views = [ramp(1), ramp(2), ramp(3)];
  const doc = docImplementation(views, settings);

  it('reproduces the reference interlace exactly', () => {
    const ref = renderInterlaced(views, settings);
    expect([doc.art.width, doc.art.height]).toEqual([ref.width, ref.height]);
    expect(doc.art.data).toEqual(ref.data);
  });

  it('reproduces the reference relief map exactly', () => {
    const ref = renderDepthMap(views, settings);
    expect([doc.map_w, doc.map_h]).toEqual([ref.width, ref.height]);
    expect(doc.depth).toEqual(ref.depth);
  });
});
