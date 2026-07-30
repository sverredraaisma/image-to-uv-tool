// Built-in example workflows for the empty state. Most use local, auto-run
// nodes (no API key needed) so they compute and show results the moment they
// load; a couple start from an Image Input you upload into, and the "materials"
// gloss recipe includes one manual Replicate (AI) segmentation step.

import type { SavedGraph } from '../types';
// The print nodes supply their own settings, so an example can never drift from
// the defaults — which are the ordinary UV-flatbed numbers (1440 PPI, 45 LPI,
// 0.9 mm of varnish at RI 1.5) rather than something tuned for a fast demo.
import { lenticularNode } from '../nodes/lenticular';
import { lensGridNode } from '../nodes/lensGrid';
import { modelInputNode, modelViewsNode } from '../nodes/model3d';
import { animationInputNode } from '../nodes/animation';
import { stlToBinary } from '../lib/stl';

/**
 * A file in public/, addressed the way it will actually be served. BASE_URL is
 * '/' in dev and '/<repo>/' on a GitHub Pages project site, so a root-absolute
 * path would 404 there — the same reason main.tsx registers the service worker
 * through it. Kept as a URL rather than inlined bytes: the fetch happens once,
 * only if someone loads the example, instead of every visitor downloading it.
 */
const publicAsset = (file: string): string => `${import.meta.env.BASE_URL}${file}`;

export interface Example {
  name: string;
  description: string;
  graph: SavedGraph;
}

const edge = (source: string, target: string): SavedGraph['edges'][number] => ({
  id: `${source}-${target}`,
  source,
  sourceHandle: 'out',
  target,
  targetHandle: 'in',
});

/** Edge between explicit ports (for multi-input/output nodes). */
const wire = (
  source: string,
  target: string,
  sourceHandle = 'out',
  targetHandle = 'in',
): SavedGraph['edges'][number] => ({
  id: `${source}.${sourceHandle}-${target}.${targetHandle}`,
  source,
  sourceHandle,
  target,
  targetHandle,
});

/**
 * A cube as a real binary STL, in a data URL — generated here rather than
 * shipped in public/, because the whole file is 684 bytes and the writer that
 * makes it is already in the repository. Model units are arbitrary: the render
 * node centres and fits whatever it is given to the sheet.
 */
const CUBE_STL_URL = (() => {
  const [n, p] = [-10, 10];
  const face = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
  ) => [...a, ...b, ...c, ...a, ...c, ...d];
  // Six faces, each wound counter-clockwise seen from outside the cube.
  const tris = [
    ...face([n, n, p], [p, n, p], [p, p, p], [n, p, p]), // front  (+z)
    ...face([p, n, n], [n, n, n], [n, p, n], [p, p, n]), // back   (−z)
    ...face([p, n, p], [p, n, n], [p, p, n], [p, p, p]), // right  (+x)
    ...face([n, n, n], [n, n, p], [n, p, p], [n, p, n]), // left   (−x)
    ...face([n, p, p], [p, p, p], [p, p, n], [n, p, n]), // top    (+y)
    ...face([n, n, n], [p, n, n], [p, n, p], [n, n, p]), // bottom (−y)
  ];
  const bytes = stlToBinary({
    kind: 'stl',
    triangleCount: tris.length / 9,
    triangles: new Float32Array(tris),
  });
  return `data:model/stl;base64,${btoa(String.fromCharCode(...bytes))}`;
})();

export const EXAMPLES: Example[] = [
  {
    name: 'Gradient → STL',
    description: 'Turn a gradient heightmap into a 3D-printable STL solid.',
    graph: {
      version: 1,
      nodes: [
        {
          id: 'grad',
          type: 'gradient',
          position: { x: 80, y: 140 },
          config: { width: 200, height: 200, from: '#000000', to: '#ffffff', direction: 'horizontal' },
        },
        {
          id: 'stl',
          type: 'heightmapStl',
          position: { x: 440, y: 140 },
          config: { minWhite: -1, baseThickness: 2, depthRange: 20, width: 100 },
        },
      ],
      edges: [edge('grad', 'stl')],
    },
  },
  {
    name: 'Noise → Normal Map',
    description: 'Procedural value noise blurred into a tileable normal map.',
    graph: {
      version: 1,
      nodes: [
        {
          id: 'noise',
          type: 'noise',
          position: { x: 60, y: 140 },
          config: { width: 256, height: 256, scale: 22, seed: 3 },
        },
        { id: 'blur', type: 'blur', position: { x: 360, y: 140 }, config: { radius: 2 } },
        { id: 'nm', type: 'normalMap', position: { x: 640, y: 140 }, config: { strength: 3 } },
      ],
      edges: [edge('noise', 'blur'), edge('blur', 'nm')],
    },
  },
  {
    name: 'Gradient → Vignette → Histogram',
    description: 'A small adjust chain ending in a value-distribution scope.',
    graph: {
      version: 1,
      nodes: [
        {
          id: 'grad',
          type: 'gradient',
          position: { x: 60, y: 140 },
          config: { width: 256, height: 256, from: '#1e3a8a', to: '#f59e0b', direction: 'vertical' },
        },
        { id: 'vig', type: 'vignette', position: { x: 360, y: 140 }, config: { strength: 0.6 } },
        { id: 'hist', type: 'histogram', position: { x: 640, y: 140 }, config: {} },
      ],
      edges: [edge('grad', 'vig'), edge('vig', 'hist')],
    },
  },
  {
    name: 'Spot gloss — painted highlights',
    description:
      'Varnish where the artist painted a glint: Highlight Extract → print-prep tail → simulated gloss print. Upload art into the Image Input.',
    graph: {
      version: 1,
      nodes: [
        { id: 'img', type: 'imageInput', position: { x: 60, y: 200 }, config: { maxSize: 0 } },
        {
          id: 'hl',
          type: 'highlightExtract',
          position: { x: 320, y: 120 },
          config: { radius: 24, gain: 1, bias: 4, satRejection: 2 },
        },
        { id: 'blur', type: 'blur', position: { x: 560, y: 120 }, config: { radius: 1 } },
        {
          id: 'at',
          type: 'autoThreshold',
          position: { x: 760, y: 120 },
          config: { mode: 'otsu', percentile: 20, invert: false },
        },
        {
          id: 'dsp',
          type: 'despeckle',
          position: { x: 980, y: 120 },
          config: { minArea: 9, minHoleArea: 0, threshold: 128 },
        },
        { id: 'erode', type: 'erode', position: { x: 1200, y: 120 }, config: { radius: 1 } },
        {
          id: 'gp',
          type: 'glossPreview',
          position: { x: 1420, y: 200 },
          config: { azimuth: 135, elevation: 45, shininess: 32, intensity: 1, matte: 0.1, heightStrength: 2 },
        },
      ],
      edges: [
        edge('img', 'hl'),
        edge('hl', 'blur'),
        edge('blur', 'at'),
        edge('at', 'dsp'),
        edge('dsp', 'erode'),
        wire('erode', 'gp', 'out', 'gloss'),
        wire('img', 'gp', 'out', 'art'),
      ],
    },
  },
  {
    name: 'Spot gloss — relief peaks',
    description:
      'Gloss the raised areas of a heightmap so peaks read shiny and valleys matte. Uses a gradient as a stand-in heightmap — computes instantly.',
    graph: {
      version: 1,
      nodes: [
        {
          id: 'grad',
          type: 'gradient',
          position: { x: 60, y: 200 },
          config: { width: 256, height: 256, from: '#000000', to: '#ffffff', direction: 'horizontal' },
        },
        {
          id: 'at',
          type: 'autoThreshold',
          position: { x: 380, y: 120 },
          config: { mode: 'percentile', percentile: 20, invert: false },
        },
        {
          id: 'dsp',
          type: 'despeckle',
          position: { x: 620, y: 120 },
          config: { minArea: 9, minHoleArea: 0, threshold: 128 },
        },
        {
          id: 'gp',
          type: 'glossPreview',
          position: { x: 900, y: 200 },
          config: {
            azimuth: 135,
            elevation: 45,
            shininess: 24,
            intensity: 1,
            matte: 0.15,
            heightStrength: 3,
          },
        },
      ],
      edges: [
        edge('grad', 'at'),
        edge('at', 'dsp'),
        wire('dsp', 'gp', 'out', 'gloss'),
        wire('grad', 'gp', 'out', 'art'),
        wire('grad', 'gp', 'out', 'heightmap'),
      ],
    },
  },
  {
    name: 'Spot gloss — linework',
    description:
      'Gloss the linework and lettering of a flat illustration: Edge Detect → Dilate → Auto Threshold. A good fallback when there are no painted highlights.',
    graph: {
      version: 1,
      nodes: [
        { id: 'img', type: 'imageInput', position: { x: 60, y: 200 }, config: { maxSize: 0 } },
        { id: 'ed', type: 'edgeDetect', position: { x: 320, y: 120 }, config: {} },
        { id: 'dil', type: 'dilate', position: { x: 540, y: 120 }, config: { radius: 1 } },
        {
          id: 'at',
          type: 'autoThreshold',
          position: { x: 760, y: 120 },
          config: { mode: 'otsu', percentile: 20, invert: false },
        },
        {
          id: 'gp',
          type: 'glossPreview',
          position: { x: 1020, y: 200 },
          config: { azimuth: 135, elevation: 45, shininess: 32, intensity: 1, matte: 0.1, heightStrength: 2 },
        },
      ],
      edges: [
        edge('img', 'ed'),
        edge('ed', 'dil'),
        edge('dil', 'at'),
        wire('at', 'gp', 'out', 'gloss'),
        wire('img', 'gp', 'out', 'art'),
      ],
    },
  },
  {
    name: 'Spot gloss — materials (AI)',
    description:
      'Text-prompt the materials to varnish — "eyes, metal, glass, water" — with Grounded SAM, then clean into a gloss mask. Needs a Replicate key; press Run on the AI node.',
    graph: {
      version: 1,
      nodes: [
        { id: 'img', type: 'imageInput', position: { x: 60, y: 200 }, config: { maxSize: 0 } },
        {
          id: 'gs',
          type: 'groundedSam',
          position: { x: 320, y: 120 },
          config: { mask_prompt: 'eyes, metal, glass, water', adjustment_factor: 0 },
        },
        {
          id: 'at',
          type: 'autoThreshold',
          position: { x: 640, y: 120 },
          config: { mode: 'otsu', percentile: 20, invert: false },
        },
        {
          id: 'dsp',
          type: 'despeckle',
          position: { x: 860, y: 120 },
          config: { minArea: 9, minHoleArea: 0, threshold: 128 },
        },
        {
          id: 'gp',
          type: 'glossPreview',
          position: { x: 1120, y: 200 },
          config: { azimuth: 135, elevation: 45, shininess: 32, intensity: 1, matte: 0.1, heightStrength: 2 },
        },
      ],
      edges: [
        wire('img', 'gs', 'out', 'image'),
        wire('gs', 'at', 'mask', 'in'),
        edge('at', 'dsp'),
        wire('dsp', 'gp', 'out', 'gloss'),
        wire('img', 'gp', 'out', 'art'),
      ],
    },
  },
  {
    name: 'Spot gloss — dark luxury',
    description:
      'Varnish the deep blacks — a classic premium-print move: Greyscale → Invert → Auto Threshold (brightest 10%). Uses a gradient source, computes instantly.',
    graph: {
      version: 1,
      nodes: [
        {
          id: 'grad',
          type: 'gradient',
          position: { x: 60, y: 200 },
          config: { width: 256, height: 256, from: '#000000', to: '#ffffff', direction: 'horizontal' },
        },
        { id: 'gray', type: 'grayscale', position: { x: 360, y: 120 }, config: {} },
        {
          id: 'inv',
          type: 'invert',
          position: { x: 560, y: 120 },
          config: { r: true, g: true, b: true, a: false },
        },
        {
          id: 'at',
          type: 'autoThreshold',
          position: { x: 760, y: 120 },
          config: { mode: 'percentile', percentile: 10, invert: false },
        },
        {
          id: 'gp',
          type: 'glossPreview',
          position: { x: 1020, y: 200 },
          config: {
            azimuth: 135,
            elevation: 45,
            shininess: 48,
            intensity: 1,
            matte: 0.25,
            heightStrength: 2,
          },
        },
      ],
      edges: [
        edge('grad', 'gray'),
        edge('gray', 'inv'),
        edge('inv', 'at'),
        wire('at', 'gp', 'out', 'gloss'),
        wire('grad', 'gp', 'out', 'art'),
      ],
    },
  },
  {
    name: 'Lenticular → two-frame flip',
    description:
      'The plain lenticular job: two frames interlaced under a lens array, so tilting the sheet swaps a ' +
      'dot for a ring. Press Run ▶ — it renders the artwork and the gloss lens map that focuses on it.',
    graph: {
      version: 1,
      nodes: [
        // Two frames that are unmistakably different at a glance, built from
        // local nodes so the example computes without an upload.
        {
          id: 'dot',
          type: 'radialGradient',
          position: { x: 60, y: 90 },
          config: {
            width: 512,
            height: 512,
            mode: 'radial',
            from: '#ffffff',
            to: '#000000',
            radius: 0.45,
            innerRadius: 0,
            angle: 0,
            feather: 0.05,
          },
        },
        {
          id: 'ring',
          type: 'radialGradient',
          position: { x: 60, y: 330 },
          config: {
            width: 512,
            height: 512,
            mode: 'ring',
            from: '#000000',
            to: '#ffffff',
            radius: 0.82,
            innerRadius: 0.56,
            angle: 0,
            feather: 0.03,
          },
        },
        {
          id: 'print',
          type: 'lenticular',
          position: { x: 420, y: 200 },
          // Straight off the node's defaults: 100 mm at 1440 PPI / 45 LPI on a
          // 0.9 mm varnish stack at RI 1.5 — the ordinary UV flatbed job. It is
          // a 32 MP render, which is exactly why the node is manual.
          config: lenticularNode.defaultConfig(),
        },
      ],
      // Frames interlace in connection order: dot first, ring second.
      edges: [wire('dot', 'print', 'out', 'frames'), wire('ring', 'print', 'out', 'frames')],
    },
  },
  {
    name: 'Lenticular → animated fireplace',
    description:
      'A whole GIF printed as one lenticular: the fire loop is resampled to the node’s 8 frames, and ' +
      'tilting the sheet plays the animation and repeats it. Press Run ▶ on the print node.',
    graph: {
      version: 1,
      nodes: [
        {
          id: 'gif',
          type: 'animationInput',
          position: { x: 60, y: 200 },
          config: {
            ...animationInputNode.defaultConfig(),
            // Shipped in public/, resolved against the deploy base path.
            src: publicAsset('fireplace-fire.gif'),
            srcRef: '',
            name: 'fireplace-fire.gif',
          },
        },
        {
          id: 'print',
          type: 'lenticular',
          position: { x: 420, y: 200 },
          config: lenticularNode.defaultConfig(),
        },
      ],
      // One wire carries every frame: the Sequence expands inside the print.
      edges: [wire('gif', 'print', 'frames', 'frames')],
    },
  },
  {
    name: 'Lens Grid → loading spinner',
    description:
      'The web loading spinner, printed: a ring of 12 graduated ticks on a 2×2 lens grid, so the bright ' +
      'tail chases you round as you turn the sheet. Press Run ▶ — it prints at the node’s default ' +
      '1440 PPI, so it is a full-resolution render.',
    graph: {
      version: 1,
      nodes: [
        // The throbber, built the way CSS builds it: a ring, times one sweep
        // around the centre, stepped into ticks.
        {
          id: 'ring',
          type: 'radialGradient',
          position: { x: 40, y: 80 },
          config: {
            width: 512,
            height: 512,
            mode: 'ring',
            from: '#000000',
            to: '#ffffff',
            radius: 0.82,
            innerRadius: 0.56,
            angle: 0,
            feather: 0.03,
          },
        },
        {
          id: 'sweep',
          type: 'radialGradient',
          position: { x: 40, y: 300 },
          config: {
            width: 512,
            height: 512,
            mode: 'conic',
            from: '#000000',
            to: '#ffffff',
            radius: 0.9,
            innerRadius: 0.6,
            angle: 0,
            feather: 0.02,
          },
        },
        // 12 discrete steps instead of a smooth tail: ticks stay legible at the
        // ~177 px each view actually resolves to (100 mm of 45 LPI lenslets).
        { id: 'ticks', type: 'posterize', position: { x: 300, y: 300 }, config: { levels: 12 } },
        // Ring × ticks = the spinner, its bright tail at 12 o'clock.
        { id: 's0', type: 'combine', position: { x: 520, y: 190 }, config: { mode: 'multiply' } },
        // …and its three rotations. 90° CW walks the tail up → right → down → left.
        { id: 'r90', type: 'transform', position: { x: 740, y: 60 }, config: { op: 'rotate90' } },
        { id: 'r180', type: 'transform', position: { x: 740, y: 200 }, config: { op: 'rotate180' } },
        { id: 'r270', type: 'transform', position: { x: 740, y: 340 }, config: { op: 'rotate270' } },
        {
          id: 'grid',
          type: 'lensGrid',
          position: { x: 990, y: 190 },
          // The node's own optics — 100 mm at 1440 PPI / 45 LPI, 0.9 mm of
          // varnish at RI 1.5 — with the grid dropped to 2 because this example
          // supplies exactly four views. Grid size is the artwork's decision;
          // everything else is the printer's.
          config: {
            ...lensGridNode.defaultConfig(),
            grid: 2,
          },
        },
      ],
      edges: [
        edge('sweep', 'ticks'),
        wire('ring', 's0', 'out', 'a'),
        wire('ticks', 's0', 'out', 'b'),
        edge('s0', 'r90'),
        edge('s0', 'r180'),
        edge('s0', 'r270'),
        // Each view gets the rotation whose bright tail points nearest the way
        // that view is looked at from — a constant 45° lag, so the tail keeps
        // turning the same way as you walk round the print.
        wire('s0', 'grid', 'out', 'c0r0'), // Left · Up    ← tail up
        wire('r90', 'grid', 'out', 'c1r0'), // Right · Up   ← tail right
        wire('r180', 'grid', 'out', 'c1r1'), // Right · Down ← tail down
        wire('r270', 'grid', 'out', 'c0r1'), // Left · Down  ← tail left
      ],
    },
  },
  {
    name: 'Lens Grid → 3D cube',
    description:
      'A cube rendered from all nine eye positions of a 3×3 lens grid and printed as one sheet, so it ' +
      'turns as you move. Everything is at the nodes’ defaults — including the 2 mm subject depth, ' +
      'which sounds absurd until you read the Info: that is already one whole lenslet of parallax per ' +
      'view step, and it is all a 57° cone at 45 LPI can carry. Press Run ▶ on both manual nodes.',
    graph: {
      version: 1,
      nodes: [
        {
          id: 'cube',
          type: 'modelInput',
          position: { x: 60, y: 200 },
          config: { ...modelInputNode.defaultConfig(), src: CUBE_STL_URL, srcRef: '', name: 'cube.stl' },
        },
        {
          id: 'views',
          type: 'modelViews',
          position: { x: 420, y: 200 },
          config: {
            ...modelViewsNode.defaultConfig(),
            // The one thing the artwork decides: square-on, a cube is a square,
            // and a square has no silhouette to move. Turned into a three-quarter
            // view it has corners at three depths, which is what reads as solid.
            rotX: -25,
            rotY: 30,
          },
        },
        {
          id: 'grid',
          type: 'lensGrid',
          position: { x: 800, y: 200 },
          config: lensGridNode.defaultConfig(),
        },
      ],
      // One wire carries all nine views, in the order the grid names its cells.
      edges: [wire('cube', 'views', 'out', 'model'), wire('views', 'grid', 'views', 'views')],
    },
  },
];
