import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore } from '../store/store';
import { setPlatform } from '../lib/platform';
import { createImage } from '../lib/image';
import type { RasterImage } from '../types';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

const FAKE = createImage(2, 2, [10, 20, 30, 255]);

function resetStore() {
  localStorage.clear();
  useStore.setState({
    nodes: [],
    edges: [],
    runtime: {},
    epochs: {},
    apiKey: '',
    openRouterKey: '',
    proxyUrl: '',
    pendingConnection: null,
    selectedNodeId: null,
    editorNodeId: null,
    preview: null,
    toasts: [],
  });
}

beforeEach(() => {
  resetStore();
  setPlatform({
    decodeImage: async () => FAKE,
    encodePng: () => 'data:image/png;base64,fake',
    encodePngBlob: async () => new Blob(),
    fetchImage: async () => FAKE,
  });
});

describe('real node pipeline (with fake platform)', () => {
  it('decodes an image input and runs an auto invert downstream', async () => {
    const s = useStore.getState();
    const input = s.addNode('imageInput');
    s.updateNodeConfig(input, { src: 'data:image/png;base64,whatever' });
    const inv = s.addNode('invert'); // defaults: invert r,g,b (not a)
    s.addConnection({ source: input, sourceHandle: 'out', target: inv, targetHandle: 'in' });
    await useStore.getState().processAutoRun();

    const out = useStore.getState().runtime[inv].outputs.out as RasterImage;
    expect(out.kind).toBe('image');
    expect([...out.data.slice(0, 4)]).toEqual([245, 235, 225, 255]);
    expect(useStore.getState().runtime[inv].status).toBe('upToDate');
  });

  it('produces an STL from a heightmap node', async () => {
    const s = useStore.getState();
    const input = s.addNode('imageInput');
    s.updateNodeConfig(input, { src: 'data:img' });
    const stl = s.addNode('heightmapStl');
    s.updateNodeConfig(stl, { minWhite: -1, baseThickness: 0, depthRange: 5, width: 2 });
    s.addConnection({ source: input, sourceHandle: 'out', target: stl, targetHandle: 'in' });
    await useStore.getState().processAutoRun();

    const out = useStore.getState().runtime[stl].outputs.out;
    expect(out?.kind).toBe('stl');
    if (out?.kind === 'stl') expect(out.triangleCount).toBeGreaterThan(0);
  });

  it('an AI node stays manual and errors without an API key', async () => {
    const s = useStore.getState();
    const input = s.addNode('imageInput');
    s.updateNodeConfig(input, { src: 'data:img' });
    const ai = s.addNode('birefnetV3');
    s.addConnection({ source: input, sourceHandle: 'out', target: ai, targetHandle: 'image' });
    await useStore.getState().processAutoRun();

    // never auto-ran
    expect(useStore.getState().runtime[ai].status).toBe('outOfDate');

    await useStore.getState().runNode(ai);
    expect(useStore.getState().runtime[ai].status).toBe('error');
    expect(useStore.getState().runtime[ai].error).toMatch(/api key/i);
    expect(useStore.getState().toasts.some((t) => /api key/i.test(t.message))).toBe(true);
  });
});

describe('new local nodes', () => {
  it('solid colour source feeds an auto greyscale', async () => {
    const s = useStore.getState();
    const src = s.addNode('solidColor');
    s.updateNodeConfig(src, { width: 2, height: 2, color: '#ff0000' });
    const g = s.addNode('grayscale');
    s.addConnection({ source: src, sourceHandle: 'out', target: g, targetHandle: 'in' });
    await useStore.getState().processAutoRun();
    const out = useStore.getState().runtime[g].outputs.out as RasterImage;
    expect(out.kind).toBe('image');
    expect([...out.data.slice(0, 4)]).toEqual([76, 76, 76, 255]);
  });

  it('apply-mask sets alpha from the mask', async () => {
    const s = useStore.getState();
    const img = s.addNode('solidColor');
    s.updateNodeConfig(img, { width: 2, height: 1, color: '#ffffff' });
    const mask = s.addNode('solidColor');
    s.updateNodeConfig(mask, { width: 2, height: 1, color: '#000000' });
    const apply = s.addNode('applyMask');
    s.addConnection({ source: img, sourceHandle: 'out', target: apply, targetHandle: 'image' });
    s.addConnection({ source: mask, sourceHandle: 'out', target: apply, targetHandle: 'mask' });
    await useStore.getState().processAutoRun();
    const out = useStore.getState().runtime[apply].outputs.out as RasterImage;
    expect(out.data[3]).toBe(0); // black mask -> alpha 0
  });
});

describe('LLM + image-to-text (with stubbed fetch)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('runs an OpenRouter LLM node with a prompt + wired text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'ROBOT SAYS HI' } }] })),
    );
    useStore.setState({ openRouterKey: 'or-key' });
    const s = useStore.getState();
    const prompt = s.addNode('promptInput');
    s.updateNodeConfig(prompt, { text: 'hello' });
    const llm = s.addNode('llmLlama8b');
    s.updateNodeConfig(llm, { prompt: 'Uppercase this:' });
    s.addConnection({ source: prompt, sourceHandle: 'out', target: llm, targetHandle: 'text' });
    await useStore.getState().processAutoRun();

    expect(useStore.getState().runtime[llm].status).toBe('outOfDate'); // manual
    await useStore.getState().runNode(llm);
    const out = useStore.getState().runtime[llm].outputs.out;
    expect(out?.kind).toBe('text');
    if (out?.kind === 'text') expect(out.text).toBe('ROBOT SAYS HI');
  });

  it('an image-to-text node returns the model text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/models/salesforce/blip')) return jsonResponse({ latest_version: { id: 'v' } });
        if (u.endsWith('/predictions') && (init?.method ?? 'GET') === 'POST') {
          return jsonResponse({ id: 'p', status: 'succeeded', output: 'a red square' });
        }
        throw new Error(`unexpected ${u}`);
      }),
    );
    useStore.setState({ apiKey: 'r8-key' });
    const s = useStore.getState();
    const img = s.addNode('imageInput');
    s.updateNodeConfig(img, { src: 'data:img' });
    const cap = s.addNode('blipCaption');
    s.addConnection({ source: img, sourceHandle: 'out', target: cap, targetHandle: 'image' });
    await useStore.getState().processAutoRun();

    await useStore.getState().runNode(cap);
    const out = useStore.getState().runtime[cap].outputs.out;
    expect(out?.kind).toBe('text');
    if (out?.kind === 'text') expect(out.text).toBe('a red square');
  });

  it('Grounded SAM sends the image, mask prompt and adjustment factor', async () => {
    let postBody: { version?: string; input?: Record<string, unknown> } | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/models/schananas/grounded_sam')) {
          return jsonResponse({ latest_version: { id: 'gsv' } });
        }
        if (u.endsWith('/predictions') && (init?.method ?? 'GET') === 'POST') {
          postBody = JSON.parse(String(init?.body));
          return jsonResponse({
            id: 'p',
            status: 'succeeded',
            output: [
              'https://x/annotated.jpg',
              'https://x/neg_annotated.jpg',
              'https://x/mask.jpg',
              'https://x/inverted_mask.jpg',
            ],
          });
        }
        throw new Error(`unexpected ${u}`);
      }),
    );
    useStore.setState({ apiKey: 'r8-key' });
    const s = useStore.getState();
    const img = s.addNode('imageInput');
    s.updateNodeConfig(img, { src: 'data:img' });
    const gs = s.addNode('groundedSam');
    s.updateNodeConfig(gs, { mask_prompt: 'clothes', adjustment_factor: 5 });
    s.addConnection({ source: img, sourceHandle: 'out', target: gs, targetHandle: 'image' });
    await useStore.getState().processAutoRun();

    await useStore.getState().runNode(gs);
    expect(useStore.getState().runtime[gs].status).toBe('upToDate');
    expect(postBody!.version).toBe('gsv');
    expect(postBody!.input!.mask_prompt).toBe('clothes');
    expect(postBody!.input!.adjustment_factor).toBe(5);
    expect(typeof postBody!.input!.image).toBe('string');
    // all four outputs populated on their own ports
    const outs = useStore.getState().runtime[gs].outputs;
    expect(outs.mask?.kind).toBe('image');
    expect(outs.invertedMask?.kind).toBe('image');
    expect(outs.annotated?.kind).toBe('image');
    expect(outs.negAnnotated?.kind).toBe('image');
  });

  it('Depth Anything splits grey and colour depth into separate outputs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/models/chenxwh/depth-anything-v2')) {
          return jsonResponse({ latest_version: { id: 'dv' } });
        }
        if (u.endsWith('/predictions') && (init?.method ?? 'GET') === 'POST') {
          return jsonResponse({
            id: 'p',
            status: 'succeeded',
            output: { grey_depth: 'https://x/grey.png', color_depth: 'https://x/color.png' },
          });
        }
        throw new Error(`unexpected ${u}`);
      }),
    );
    useStore.setState({ apiKey: 'r8-key' });
    const s = useStore.getState();
    const img = s.addNode('imageInput');
    s.updateNodeConfig(img, { src: 'data:img' });
    const depth = s.addNode('depthAnythingV2');
    s.addConnection({ source: img, sourceHandle: 'out', target: depth, targetHandle: 'image' });
    await useStore.getState().processAutoRun();

    await useStore.getState().runNode(depth);
    const outs = useStore.getState().runtime[depth].outputs;
    expect(outs.grey?.kind).toBe('image');
    expect(outs.color?.kind).toBe('image');
  });
});
