// Built-in example workflows for the empty state. All use local, auto-run nodes
// (no API key needed) so they compute and show results the moment they load.

import type { SavedGraph } from '../types';

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
];
