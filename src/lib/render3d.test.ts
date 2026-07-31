import { describe, it, expect } from 'vitest';
import {
  clampSetbackMm,
  viewGridChunks,
  viewSequenceChunks,
  disparityPerStep,
  eyeOffsetsMm,
  prepareVertices,
  projectToSheet,
  renderViewGrid,
  type ViewGridOptions,
} from './render3d';
import { meshBounds } from './stl';
import { createImage } from './image';
import type { RasterImage, StlValue } from '../types';

const options = (over: Partial<ViewGridOptions> = {}): ViewGridOptions => ({
  grid: 3,
  widthMm: 100,
  heightMm: 100,
  widthPx: 64,
  viewDistanceMm: 400,
  depthMm: 20,
  setbackMm: 0,
  coneDeg: 60,
  rotationDeg: [0, 0, 0],
  margin: 0,
  supersample: 1,
  shading: {
    lightAzimuthDeg: 0,
    lightElevationDeg: 0,
    ambient: 1, // flat, so tests read geometry rather than shading
    colour: [0, 0, 0],
    background: [255, 255, 255],
  },
  ...over,
});

/** Two triangles making an axis-aligned quad at a constant z. */
function quad(x0: number, x1: number, y0: number, y1: number, z: number): number[] {
  return [x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z];
}

const mesh = (...coords: number[][]): StlValue => {
  const flat = coords.flat();
  return { kind: 'stl', triangleCount: flat.length / 9, triangles: new Float32Array(flat) };
};

/** Is this pixel the object (dark) rather than the background (white)? */
const dark = (img: RasterImage, x: number, y: number) => img.data[(y * img.width + x) * 4] < 128;

/** Rightmost column holding any object pixel, or -1. */
function rightmostDark(img: RasterImage): number {
  for (let x = img.width - 1; x >= 0; x--) {
    for (let y = 0; y < img.height; y++) if (dark(img, x, y)) return x;
  }
  return -1;
}

/** Leftmost column holding any object pixel, or -1. */
function leftmostDark(img: RasterImage): number {
  for (let x = 0; x < img.width; x++) {
    for (let y = 0; y < img.height; y++) if (dark(img, x, y)) return x;
  }
  return -1;
}

/** Bottom-most row holding any object pixel, or -1. */
function lowestDark(img: RasterImage): number {
  for (let y = img.height - 1; y >= 0; y--) {
    for (let x = 0; x < img.width; x++) if (dark(img, x, y)) return y;
  }
  return -1;
}

describe('eyeOffsetsMm', () => {
  it('spreads the grid over the whole cone, symmetrically', () => {
    const o = eyeOffsetsMm(3, 60, 400);
    expect(o).toHaveLength(3);
    expect(o[1]).toBeCloseTo(0, 10); // an odd grid has a dead-ahead view
    expect(o[0]).toBeCloseTo(-o[2], 10);
    // The outer views sit at exactly ±30°, and these are positions on a plane,
    // so it is tan — 231 mm off-axis at 400 mm, not the 209 mm of an arc.
    expect(o[2]).toBeCloseTo(400 * Math.tan(Math.PI / 6), 6);
  });

  it('has no centre view for an even grid, and none at all for one view', () => {
    const four = eyeOffsetsMm(4, 60, 400);
    expect(four.some((v) => v === 0)).toBe(false);
    expect(four[0]).toBeCloseTo(-four[3], 10);
    expect(eyeOffsetsMm(1, 60, 400)).toEqual([0]);
  });
});

describe('projectToSheet', () => {
  it('puts a point on the sheet plane in the same place for every eye', () => {
    for (const ex of [-200, -50, 0, 37, 231]) {
      const p = projectToSheet(12, -7, 0, ex, ex / 2, 400);
      expect(p.X).toBeCloseTo(12, 10);
      expect(p.Y).toBeCloseTo(-7, 10);
      expect(p.t).toBeCloseTo(1, 10);
    }
  });

  it('slides a point in front of the sheet against the eye, and behind it with', () => {
    const near = (ex: number) => projectToSheet(0, 0, 10, ex, 0, 400).X;
    const far = (ex: number) => projectToSheet(0, 0, -10, ex, 0, 400).X;
    // Eye to the right: the near point reads left of centre, the far one right.
    // (Hold a finger up against a wall and move your head: the finger goes the
    // other way. The print has to record it where the ray actually crosses.)
    expect(near(100)).toBeLessThan(0);
    expect(far(100)).toBeGreaterThan(0);
    expect(near(-100)).toBeCloseTo(-near(100), 10);
    // …and the nearer face moves further, because it is further off the plane.
    expect(Math.abs(near(100))).toBeGreaterThan(Math.abs(far(100)) * 0.9);
  });

  it('reports a depth key that grows towards the eye', () => {
    expect(projectToSheet(0, 0, 10, 0, 0, 400).t).toBeGreaterThan(projectToSheet(0, 0, -10, 0, 0, 400).t);
  });
});

describe('prepareVertices', () => {
  const boundsOf = (stl: StlValue, o = options()) =>
    meshBounds({ kind: 'stl', triangleCount: stl.triangleCount, triangles: prepareVertices(stl, o).verts });

  it('centres the model and fits it to the sheet', () => {
    // A 2×1 quad parked away from the origin: it should come back centred and
    // scaled so its long axis fills the 100 mm sheet.
    const stl = mesh(quad(10, 12, 5, 6, 0));
    const b = boundsOf(stl);
    expect(b.centre[0]).toBeCloseTo(0, 6);
    expect(b.centre[1]).toBeCloseTo(0, 6);
    expect(b.size[0]).toBeCloseTo(100, 4);
    expect(b.size[1]).toBeCloseTo(50, 4);
  });

  it('leaves room when a margin is asked for, without distorting the subject', () => {
    const b = boundsOf(mesh(quad(-1, 1, -1, 1, 0)), options({ margin: 0.2 }));
    expect(b.size[0]).toBeCloseTo(80, 4);
    expect(b.size[1]).toBeCloseTo(80, 4);
  });

  it('keeps the model’s shape, and compresses depth only at projection time', () => {
    // A 2 × 2 × 8 box on a 100 mm sheet: the footprint fits to 100 × 100, so one
    // scale for every axis makes it 400 mm deep. The vertices keep all of that —
    // squashing them would squash the normals with them, and the subject would
    // shade like the slab it had become.
    const stl = mesh(quad(-1, 1, -1, 1, -4), quad(-1, 1, -1, 1, 4));
    const prepared = prepareVertices(stl, options({ depthMm: 20 }));
    const b = meshBounds({ kind: 'stl', triangleCount: stl.triangleCount, triangles: prepared.verts });
    expect(b.size[2]).toBeCloseTo(400, 3); // true depth, in proportion to x/y
    expect(b.centre[2]).toBeCloseTo(0, 6); // straddling the sheet plane
    // …and the projection is told to show a twentieth of it.
    expect(prepared.zScale).toBeCloseTo(20 / 400, 6);
  });

  it('leaves a flat model on the sheet instead of dividing by its zero depth', () => {
    const prepared = prepareVertices(mesh(quad(-1, 1, -1, 1, 7)), options({ depthMm: 20 }));
    expect(prepared.zScale).toBe(0);
    for (let i = 2; i < prepared.verts.length; i += 3) expect(prepared.verts[i]).toBe(0);
  });

  it('fits the rotated silhouette, not the original one', () => {
    // A wide, shallow quad turned on its side has to fit the sheet the other way.
    const stl = mesh(quad(-2, 2, -0.5, 0.5, 0));
    const b = boundsOf(stl, options({ rotationDeg: [0, 0, 90] }));
    expect(b.size[1]).toBeCloseTo(100, 3); // the long axis now runs up the sheet
    expect(b.size[0]).toBeCloseTo(25, 3);
  });
});

describe('renderViewGrid', () => {
  it('renders grid² views at the sheet aspect', () => {
    const r = renderViewGrid(mesh(quad(-1, 1, -1, 1, 0)), options({ widthPx: 32, heightMm: 50 }));
    expect(r.views).toHaveLength(9);
    expect(r.views[0].width).toBe(32);
    expect(r.views[0].height).toBe(16); // 100 × 50 mm sheet
    expect(r.depth.width).toBe(32);
  });

  it('renders a subject lying in the window identically from every eye — it is the focal plane', () => {
    // Flat, no depth and no setback: the subject is the sheet plane itself.
    const r = renderViewGrid(mesh(quad(-1, 1, -1, 1, 0)), options({ depthMm: 0, setbackMm: 0 }));
    for (const view of r.views) expect(view.data).toEqual(r.views[4].data);
  });

  it('stands the subject behind the sheet, so all of it slides *with* the eye', () => {
    // A plane 40 mm back. Nothing is in front of the window, so every point
    // moves the way the eye does — the opposite of a pop-out.
    const back = options({ margin: 0.4, depthMm: 0, setbackMm: 40 });
    const r = renderViewGrid(mesh(quad(-1, 1, -1, 1, 0)), back);
    const [lu, cu, ru, , , , ld] = r.views;
    expect(rightmostDark(ru)).toBeGreaterThan(rightmostDark(cu));
    expect(rightmostDark(cu)).toBeGreaterThan(rightmostDark(lu));
    // The same in the other axis: the eye above sees it higher up the sheet.
    expect(lowestDark(ld)).toBeGreaterThan(lowestDark(lu));

    // …and it is a window, not a shove backwards: the fit is measured at the
    // near face, so the subject still fills the frame head-on however far back
    // it stands. (Within a pixel — the two scalings cancel in real numbers.)
    const flush = renderViewGrid(mesh(quad(-1, 1, -1, 1, 0)), { ...back, setbackMm: 0 });
    expect(Math.abs(rightmostDark(cu) - rightmostDark(flush.views[4]))).toBeLessThanOrEqual(1);
  });

  it('moves a near feature less than a far one — the parallax the print carries', () => {
    // A back plane over the left of the sheet, with a nearer tab clear of its
    // right-hand edge, so each is measured by its own extreme.
    const stl = mesh(quad(-1, 0.8, -1, 1, -1), quad(0.85, 1, -0.4, 0.4, 1));
    const r = renderViewGrid(stl, options({ margin: 0.25, depthMm: 30 }));
    const [lu, , ru] = r.views;
    const tab = rightmostDark(ru) - rightmostDark(lu);
    const plane = leftmostDark(ru) - leftmostDark(lu);
    // Both slide right as the eye goes right, because both are behind the
    // sheet; the deeper one slides further, and that difference is the depth.
    expect(tab).toBeGreaterThan(0);
    expect(plane).toBeGreaterThan(tab);
  });

  it('reports where the subject stands behind the sheet', () => {
    const r = renderViewGrid(mesh(quad(-1, 1, -1, 1, 1)), options({ depthMm: 6, setbackMm: 4 }));
    expect([r.nearMm, r.farMm]).toEqual([4, 10]);
  });

  it('brings the subject out through the plate on a negative setback', () => {
    // 40 mm in front of the sheet, all of it: now it slides *against* the eye,
    // the way anything nearer than the paper has to.
    const front = options({ margin: 0.4, depthMm: 0, setbackMm: -40 });
    const r = renderViewGrid(mesh(quad(-1, 1, -1, 1, 0)), front);
    const [lu, cu, ru] = r.views;
    expect([r.nearMm, r.farMm]).toEqual([-40, -40]);
    expect(rightmostDark(ru)).toBeLessThan(rightmostDark(cu));
    expect(rightmostDark(cu)).toBeLessThan(rightmostDark(lu));
    // Fitted at the near face still, which is in front now — so it is scaled
    // down to fit the frame rather than up, and lands the same size head-on.
    const flush = renderViewGrid(mesh(quad(-1, 1, -1, 1, 0)), { ...front, setbackMm: 0 });
    expect(Math.abs(rightmostDark(cu) - rightmostDark(flush.views[4]))).toBeLessThanOrEqual(1);
  });

  it('keeps a crossing subject partly either side of the plane', () => {
    // 2 mm out, 28 mm in — the arrangement a pop-out detail on a deep subject
    // actually wants.
    const r = renderViewGrid(mesh(quad(-1, 1, -1, 1, 1)), options({ depthMm: 30, setbackMm: -2 }));
    expect([r.nearMm, r.farMm]).toEqual([-2, 28]);
  });

  it('holds the pop-out to a quarter of the viewing distance', () => {
    const r = renderViewGrid(mesh(quad(-1, 1, -1, 1, 1)), options({ depthMm: 1, setbackMm: -1000 }));
    expect(r.nearMm).toBe(-100); // 400 mm viewing distance
    expect(clampSetbackMm(-10, 400)).toBe(-10);
  });

  it('keeps the nearer surface where two overlap', () => {
    // A far plane over the whole sheet and a near plane over its left half; the
    // depth key must pick the near one there whatever order they arrive in.
    const near = quad(-1, 0, -1, 1, 1);
    const far = quad(-1, 1, -1, 1, -1);
    const front = renderViewGrid(mesh(near, far), options({ margin: 0 })).depth;
    const back = renderViewGrid(mesh(far, near), options({ margin: 0 })).depth;
    const at = (img: RasterImage, x: number) => img.data[(Math.floor(img.height / 2) * img.width + x) * 4];
    expect(at(front, 8)).toBeGreaterThan(at(front, 56)); // left half is nearer
    expect(at(front, 8)).toBe(at(back, 8)); // and the order it was fed doesn't matter
    expect(at(front, 56)).toBe(at(back, 56));
  });

  it('shades by facing, and leaves the background alone where nothing is hit', () => {
    // Light straight on: a face square to it is fully lit, an edge-on one dark.
    const o = options({
      margin: 0.5, // the subject cannot reach the corners
      shading: {
        lightAzimuthDeg: 0,
        lightElevationDeg: 0,
        ambient: 0,
        colour: [200, 200, 200],
        background: [10, 20, 30],
      },
    });
    const r = renderViewGrid(mesh(quad(-1, 1, -1, 1, 0)), o);
    const centre = r.views[4];
    const mid = (centre.height / 2) * centre.width + centre.width / 2;
    expect(centre.data[mid * 4]).toBeCloseTo(200, -1); // facing the light
    expect([centre.data[0], centre.data[1], centre.data[2]]).toEqual([10, 20, 30]);
    expect(r.coverage).toBeGreaterThan(0.1);
    expect(r.coverage).toBeLessThan(0.5); // margin 0.5 leaves half the frame empty
  });

  it('supersamples down to the requested size', () => {
    const o = options({ widthPx: 24, supersample: 3 });
    const r = renderViewGrid(mesh(quad(-1, 1, -1, 1, 0)), o);
    expect(r.views[0].width).toBe(24);
    expect(r.views[0].height).toBe(24);
  });
});

describe('chunked view rendering', () => {
  const quadMesh = () => mesh(quad(-1, 1, -1, 1, 1));

  it('renders one view per chunk, counting them off', () => {
    const gen = viewGridChunks(quadMesh(), options({ grid: 3, widthPx: 16 }));
    const seen: { done: number; total: number; what: string }[] = [];
    let step = gen.next();
    while (!step.done) {
      seen.push(step.value);
      step = gen.next();
    }
    expect(seen).toHaveLength(9);
    expect(seen.map((p) => p.done)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(seen.every((p) => p.total === 9 && p.what === 'Views')).toBe(true);
    // …and what comes back is exactly what the plain call gives.
    expect(step.value.views).toHaveLength(9);
    expect(step.value.views[4].data).toEqual(
      renderViewGrid(quadMesh(), options({ grid: 3, widthPx: 16 })).views[4].data,
    );
  });

  it('does the same for a 1D run', () => {
    const { grid: _grid, ...shared } = options({ widthPx: 16 });
    const gen = viewSequenceChunks(quadMesh(), { ...shared, views: 5 });
    let count = 0;
    let step = gen.next();
    while (!step.done) {
      count++;
      step = gen.next();
    }
    expect(count).toBe(5);
    expect(step.value.views).toHaveLength(5);
  });
});

describe('disparityPerStep', () => {
  it('matches the hand calculation', () => {
    const o = options({ grid: 3, coneDeg: 60, viewDistanceMm: 400, depthMm: 20 });
    // Eye step = 400·tan30° = 230.94 mm; the far face stands 20 mm behind the
    // sheet, so it slides 230.94 × 20/420 = 11.0 mm per step. At 45 LPI
    // (0.5644 mm pitch) that is 19.5 lenslets — wildly too much, which is the
    // point: it is easy to ask for far more depth than a lens grid can show.
    const d = disparityPerStep(o, 45);
    expect(d.mm).toBeCloseTo((400 * Math.tan(Math.PI / 6) * 20) / 420, 6);
    expect(d.lenslets).toBeCloseTo(d.mm / (25.4 / 45), 6);
    expect(d.lenslets).toBeGreaterThan(19);
  });

  it('is measured at the far face, so the setback counts as depth', () => {
    // 5 mm of subject 5 mm back reaches as far as 10 mm of subject on the glass.
    const a = disparityPerStep(options({ depthMm: 5, setbackMm: 5 }), 45);
    const b = disparityPerStep(options({ depthMm: 10, setbackMm: 0 }), 45);
    expect(a.mm).toBeCloseTo(b.mm, 10);
  });

  it('falls linearly with depth and rises with the cone', () => {
    const base = disparityPerStep(options({ depthMm: 20 }), 45).lenslets;
    expect(disparityPerStep(options({ depthMm: 2 }), 45).lenslets).toBeLessThan(base / 5);
    expect(disparityPerStep(options({ depthMm: 0 }), 45).lenslets).toBe(0);
    expect(disparityPerStep(options({ coneDeg: 20 }), 45).lenslets).toBeLessThan(base);
    // A bigger grid divides the same cone into smaller steps.
    expect(disparityPerStep(options({ grid: 6 }), 45).lenslets).toBeLessThan(base);
  });
});

describe('surface colour', () => {
  /** A quad on the sheet plane, uv-mapped across the whole 0–1 square. */
  const mapped = (): StlValue => ({
    kind: 'stl',
    triangleCount: 2,
    triangles: new Float32Array(quad(-1, 1, -1, 1, 0)),
    // Matching the quad() winding: (x0,y0) (x1,y0) (x1,y1) then (x0,y0) (x1,y1) (x0,y1).
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]),
  });

  /** A 2×2 texture: red, green on the top row; blue, white on the bottom. */
  const swatch = (): RasterImage => {
    const img = createImage(2, 2, [0, 0, 0, 255]);
    img.data.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    return img;
  };

  const flatLight = { lightAzimuthDeg: 0, lightElevationDeg: 0, ambient: 1 };

  it('samples the texture through the mesh’s uvs, right way up', () => {
    const o = options({
      widthPx: 32,
      texture: swatch(),
      shading: { ...flatLight, colour: [1, 2, 3], background: [0, 0, 0] },
    });
    const view = renderViewGrid(mapped(), o).views[4];
    /** Which swatch is this pixel nearest? Sampling is bilinear, so on a 2×2
     *  texture every pixel is some blend — the question is which one wins. */
    const swatchAt = (x: number, y: number) => {
      const at = (y * view.width + x) * 4;
      const [r, g, b] = [view.data[at], view.data[at + 1], view.data[at + 2]];
      if (r > 200 && g < 80 && b < 80) return 'red';
      if (g > 200 && r < 80 && b < 80) return 'green';
      if (b > 200 && r < 80 && g < 80) return 'blue';
      if (r > 200 && g > 200 && b > 200) return 'white';
      return `mixed(${r},${g},${b})`;
    };
    // uv origin is bottom-left in OBJ, so the texture's top row lands at the
    // top of the sheet: red top-left, green top-right, blue bottom-left.
    expect(swatchAt(8, 8)).toBe('red');
    expect(swatchAt(24, 8)).toBe('green');
    expect(swatchAt(8, 24)).toBe('blue');
    expect(swatchAt(24, 24)).toBe('white');
  });

  it('replaces the material colour rather than tinting it', () => {
    // A photographic texture must not be dyed by whatever colour is set.
    const o = (colour: [number, number, number]) =>
      options({
        widthPx: 16,
        texture: swatch(),
        shading: { ...flatLight, colour, background: [0, 0, 0] },
      });
    const a = renderViewGrid(mapped(), o([255, 0, 0])).views[4];
    const b = renderViewGrid(mapped(), o([0, 0, 255])).views[4];
    expect(a.data).toEqual(b.data);
  });

  it('uses vertex colours when there is no texture, and keeps a face flat', () => {
    const stl: StlValue = {
      ...mapped(),
      colours: new Uint8Array([200, 0, 0, 200, 0, 0, 200, 0, 0, 200, 0, 0, 200, 0, 0, 200, 0, 0]),
    };
    const o = options({
      widthPx: 16,
      shading: { ...flatLight, colour: [0, 0, 255], background: [0, 0, 0] },
    });
    const view = renderViewGrid(stl, o).views[4];
    const mid = (Math.floor(view.height / 2) * view.width + Math.floor(view.width / 2)) * 4;
    expect([...view.data.slice(mid, mid + 3)]).toEqual([200, 0, 0]);
  });

  it('ignores a texture the mesh has no uvs for', () => {
    const bare = mesh(quad(-1, 1, -1, 1, 0));
    const o = options({
      widthPx: 16,
      shading: { ...flatLight, colour: [10, 20, 30], background: [0, 0, 0] },
    });
    const withTex = renderViewGrid(bare, { ...o, texture: swatch() }).views[4];
    const without = renderViewGrid(bare, o).views[4];
    expect(withTex.data).toEqual(without.data);
  });

  it('still shades: the same texel is darker on a face turned from the light', () => {
    const lit = { lightAzimuthDeg: 0, lightElevationDeg: 0, ambient: 0 };
    const o = options({
      widthPx: 16,
      texture: swatch(),
      shading: { ...lit, colour: [0, 0, 0], background: [0, 0, 0] },
      rotationDeg: [0, 60, 0], // turn the quad away from the light
    });
    const face = renderViewGrid(mapped(), { ...o, rotationDeg: [0, 0, 0] }).views[4];
    const turned = renderViewGrid(mapped(), o).views[4];
    const brightest = (img: RasterImage) => Math.max(...img.data.filter((_, i) => i % 4 === 0));
    expect(brightest(turned)).toBeLessThan(brightest(face));
  });
});
