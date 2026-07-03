// Replicate-backed AI model nodes. Always manual-run so tokens are only spent
// when the user explicitly asks.
//
// Each node can have MANY inputs. A node declares a list of typed input ports
// (image / mask / text), each mapped to a Replicate input key that is editable
// in the node's advanced settings. Text ports can also be typed inline instead
// of wired. Anything a model needs that isn't a declared port can be supplied
// through the per-node "Extra inputs (JSON)" field. This keeps the nodes working
// even as Replicate model schemas change, and lets you add every input a model
// supports.

import type { ComputeResult, ConfigField, NodeDefinition, PortSpec } from '../types';
import { platform } from '../lib/platform';
import { runModel } from '../lib/replicate';
import { str } from './helpers';
import {
  buildReplicateInput,
  resolveOutputs,
  type AiOutput,
  type AiPort,
  type AiScalar,
} from './aiMapping';

interface AiSpec {
  type: string;
  label: string;
  description: string;
  /** Capability group for menu sorting (Generate, Segment, Describe…). */
  group: string;
  /** Default `owner/name` or `owner/name:version` slug (editable). */
  model: string;
  ports: AiPort[];
  /** Extra scalar inputs mapped 1:1 to Replicate keys (field.key === input key). */
  scalars?: AiScalar[];
  /** Explicit output ports (for models that return several things). */
  outputs?: AiOutput[];
  /** Default output field to pick — only used for the single default output. */
  outputKey?: string;
  /** Shorthand for a single output's type when `outputs` is omitted. */
  output?: 'image' | 'text';
}

function makeReplicateNode(spec: AiSpec): NodeDefinition {
  const inputs: PortSpec[] = spec.ports.map((p) => ({ id: p.id, label: p.label, type: p.type }));
  const scalars = spec.scalars ?? [];
  const outputPorts: AiOutput[] =
    spec.outputs ?? [{ id: 'out', label: 'Output', type: spec.output === 'text' ? 'text' : 'image' }];
  const singleDefaultOutput = !spec.outputs;

  const configFields: ConfigField[] = [
    { kind: 'text', key: 'model', label: 'Model (owner/name[:version])', advanced: true },
  ];
  for (const p of spec.ports) {
    if (p.type === 'text') {
      configFields.push({
        kind: 'text',
        key: p.id,
        label: p.label,
        multiline: true,
        placeholder: 'type here or wire an input',
      });
    }
    configFields.push({
      kind: 'text',
      key: `${p.id}Key`,
      label: `${p.label} → input key`,
      advanced: true,
    });
  }
  for (const s of scalars) configFields.push(s.field);
  configFields.push({
    kind: 'text',
    key: 'extraInputs',
    label: 'Extra inputs (JSON)',
    multiline: true,
    advanced: true,
    placeholder: '{ "guidance": 3.5 }',
  });
  if (singleDefaultOutput) {
    configFields.push({ kind: 'text', key: 'outputKey', label: 'Output field key', advanced: true });
  }

  const defaultConfig = () => {
    const cfg: Record<string, unknown> = {
      model: spec.model,
      extraInputs: '',
      outputKey: spec.outputKey ?? '',
    };
    for (const p of spec.ports) {
      cfg[`${p.id}Key`] = p.key;
      if (p.type === 'text') cfg[p.id] = '';
    }
    for (const s of scalars) cfg[s.field.key] = s.default;
    return cfg;
  };

  return {
    type: spec.type,
    label: spec.label,
    category: 'AI (Replicate)',
    group: spec.group,
    description: spec.description,
    autoRun: false,
    inputs,
    outputs: outputPorts.map((o) => ({ id: o.id, label: o.label, type: o.type })),
    configFields,
    defaultConfig,
    compute: async ({ inputs: inp, config, apiKey, proxyUrl, signal, onProgress }) => {
      if (!apiKey) throw new Error('Set your Replicate API key first');
      const model = str(config.model, spec.model);

      onProgress?.('Encoding inputs…');
      const input = buildReplicateInput(spec.ports, scalars, config, inp, platform.encodePng);

      const modelOutput = await runModel(model, input, { apiKey, proxyUrl, signal, onProgress });

      // Resolve each output port to a URL/text, then download image URLs in
      // parallel so all previews are populated.
      const resolved = resolveOutputs(
        outputPorts,
        modelOutput,
        singleDefaultOutput,
        str(config.outputKey) || undefined,
      );
      const result: ComputeResult = {};
      const jobs: Promise<void>[] = [];
      for (const [portId, out] of Object.entries(resolved)) {
        if (!out) result[portId] = undefined;
        else if ('text' in out) result[portId] = { kind: 'text', text: out.text };
        else jobs.push(platform.fetchImage(out.url, signal).then((img) => void (result[portId] = img)));
      }
      if (jobs.length) onProgress?.('Downloading results…');
      await Promise.all(jobs);

      if (Object.values(result).every((v) => v == null)) {
        throw new Error('Model returned no usable output');
      }
      return result;
    },
  };
}

const IMAGE: (over?: Partial<AiPort>) => AiPort = (over = {}) => ({
  id: 'image',
  label: 'Image',
  type: 'image',
  key: 'image',
  required: true,
  ...over,
});

const PROMPT = (over: Partial<AiPort> = {}): AiPort => ({
  id: 'prompt',
  label: 'Prompt',
  type: 'text',
  key: 'prompt',
  required: true,
  ...over,
});

export const aiNodes: NodeDefinition[] = [
  // ---- Generate (text → image) ----
  makeReplicateNode({
    type: 'fluxSchnell',
    label: 'Flux Schnell',
    group: 'Generate',
    description: 'Fast text-to-image generation (black-forest-labs/flux-schnell).',
    model: 'black-forest-labs/flux-schnell',
    ports: [PROMPT()],
    scalars: [
      {
        field: {
          kind: 'select',
          key: 'aspect_ratio',
          label: 'Aspect ratio',
          options: ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9'].map((v) => ({ value: v, label: v })),
        },
        default: '1:1',
      },
    ],
  }),
  makeReplicateNode({
    type: 'fluxDev',
    label: 'Flux Dev',
    group: 'Generate',
    description: 'Higher-quality (slower) text-to-image (black-forest-labs/flux-dev).',
    model: 'black-forest-labs/flux-dev',
    ports: [PROMPT()],
    scalars: [
      {
        field: {
          kind: 'select',
          key: 'aspect_ratio',
          label: 'Aspect ratio',
          options: ['1:1', '16:9', '9:16', '4:3', '3:4'].map((v) => ({ value: v, label: v })),
        },
        default: '1:1',
      },
    ],
  }),
  makeReplicateNode({
    type: 'sdxl',
    label: 'SDXL',
    group: 'Generate',
    description: 'Stable Diffusion XL text-to-image (stability-ai/sdxl).',
    model: 'stability-ai/sdxl',
    ports: [
      PROMPT(),
      { id: 'negative_prompt', label: 'Negative prompt', type: 'text', key: 'negative_prompt', required: false },
    ],
  }),
  makeReplicateNode({
    type: 'recraftV3',
    label: 'Recraft v3',
    group: 'Generate',
    description: 'High-quality text-to-image with styles (recraft-ai/recraft-v3).',
    model: 'recraft-ai/recraft-v3',
    ports: [PROMPT()],
    scalars: [
      {
        field: {
          kind: 'select',
          key: 'size',
          label: 'Size',
          options: ['1024x1024', '1365x1024', '1024x1365', '1536x1024', '1024x1536'].map((v) => ({
            value: v,
            label: v,
          })),
        },
        default: '1024x1024',
      },
    ],
  }),
  makeReplicateNode({
    type: 'ideogramV2',
    label: 'Ideogram v2',
    group: 'Generate',
    description: 'Text-to-image with excellent in-image text rendering (ideogram-ai/ideogram-v2).',
    model: 'ideogram-ai/ideogram-v2',
    ports: [PROMPT()],
    scalars: [
      {
        field: {
          kind: 'select',
          key: 'aspect_ratio',
          label: 'Aspect ratio',
          options: ['1:1', '16:9', '9:16', '4:3', '3:4'].map((v) => ({ value: v, label: v })),
        },
        default: '1:1',
      },
    ],
  }),
  makeReplicateNode({
    type: 'sd35Large',
    label: 'Stable Diffusion 3.5',
    group: 'Generate',
    description: 'Stable Diffusion 3.5 Large text-to-image (stability-ai/stable-diffusion-3.5-large).',
    model: 'stability-ai/stable-diffusion-3.5-large',
    ports: [
      PROMPT(),
      { id: 'negative_prompt', label: 'Negative prompt', type: 'text', key: 'negative_prompt', required: false },
    ],
  }),

  // ---- Edit (image + instruction → image) ----
  makeReplicateNode({
    type: 'instructPix2Pix',
    label: 'Instruct Pix2Pix',
    group: 'Edit',
    description: 'Edit an image with a text instruction (timothybrooks/instruct-pix2pix).',
    model: 'timothybrooks/instruct-pix2pix',
    ports: [IMAGE(), PROMPT({ label: 'Instruction' })],
  }),
  makeReplicateNode({
    type: 'sdInpaint',
    label: 'SD Inpainting',
    group: 'Edit',
    description: 'Fill a masked region from a prompt (stability-ai/stable-diffusion-inpainting).',
    model: 'stability-ai/stable-diffusion-inpainting',
    ports: [
      IMAGE(),
      { id: 'mask', label: 'Mask', type: 'mask', key: 'mask', required: false },
      PROMPT(),
    ],
  }),
  makeReplicateNode({
    type: 'fluxCanny',
    label: 'Flux ControlNet (Canny)',
    group: 'Edit',
    description: 'Structure-guided generation from a control image + prompt (black-forest-labs/flux-canny-dev).',
    model: 'black-forest-labs/flux-canny-dev',
    ports: [IMAGE({ key: 'control_image', label: 'Control image' }), PROMPT()],
  }),
  makeReplicateNode({
    type: 'fluxKontext',
    label: 'Flux Kontext',
    group: 'Edit',
    description: 'High-quality instruction-based image editing (black-forest-labs/flux-kontext-pro).',
    model: 'black-forest-labs/flux-kontext-pro',
    ports: [IMAGE({ key: 'input_image' }), PROMPT({ label: 'Instruction' })],
  }),
  makeReplicateNode({
    type: 'icLight',
    label: 'Relight (IC-Light)',
    group: 'Edit',
    description: 'Relight a subject from a text prompt (zsxkib/ic-light).',
    model: 'zsxkib/ic-light',
    ports: [IMAGE({ key: 'subject_image' }), PROMPT()],
  }),
  makeReplicateNode({
    type: 'lamaRemove',
    label: 'Remove Object (LaMa)',
    group: 'Edit',
    description: 'Erase a masked region and inpaint the background, no prompt (cjwbw/lama).',
    model: 'cjwbw/lama',
    ports: [IMAGE(), { id: 'mask', label: 'Mask', type: 'mask', key: 'mask', required: true }],
  }),

  // ---- Stylize ----
  makeReplicateNode({
    type: 'animeGan',
    label: 'AnimeGAN v2',
    group: 'Stylize',
    description: 'Cartoon / anime stylisation of a photo (412392713/animegan-v2).',
    model: '412392713/animegan-v2',
    ports: [IMAGE()],
  }),
  makeReplicateNode({
    type: 'styleTransfer',
    label: 'Style Transfer',
    group: 'Stylize',
    description: 'Restyle an image using a reference style image + prompt (fofr/style-transfer).',
    model: 'fofr/style-transfer',
    ports: [
      IMAGE(),
      { id: 'style', label: 'Style image', type: 'image', key: 'style_image', required: false },
      PROMPT({ required: false }),
    ],
  }),

  // ---- Depth ----
  makeReplicateNode({
    type: 'depthAnythingV2',
    label: 'Depth Anything v2',
    group: 'Depth',
    description: 'Monocular depth estimation (chenxwh/depth-anything-v2). Grey + colour depth outputs.',
    model: 'chenxwh/depth-anything-v2',
    ports: [IMAGE()],
    scalars: [
      {
        field: {
          kind: 'select',
          key: 'model_size',
          label: 'Model size',
          options: [
            { value: 'Small', label: 'Small' },
            { value: 'Base', label: 'Base' },
            { value: 'Large', label: 'Large' },
          ],
        },
        default: 'Large',
      },
    ],
    outputs: [
      { id: 'grey', label: 'Grey depth', type: 'image', key: 'grey_depth' },
      { id: 'color', label: 'Colour depth', type: 'image', key: 'color_depth' },
    ],
  }),
  makeReplicateNode({
    type: 'marigoldDepth',
    label: 'Marigold Depth',
    group: 'Depth',
    description: 'High-quality diffusion-based depth estimation (prs-eth/marigold).',
    model: 'prs-eth/marigold',
    ports: [IMAGE()],
  }),
  // ---- Segment ----
  makeReplicateNode({
    type: 'sam2Image',
    label: 'SAM 2 (image)',
    group: 'Segment',
    description:
      'Segment Anything 2, automatic masks. Verified slug: meta/sam-2. Point/box prompts go in Extra inputs (JSON).',
    model: 'meta/sam-2',
    ports: [IMAGE()],
  }),
  makeReplicateNode({
    type: 'sam3Concept',
    label: 'SAM 3 (concept)',
    group: 'Segment',
    description:
      'Segment Anything 3 — segments everything matching a text concept. Default slug is the video model (lucataco/sam3-video); set an image SAM 3 slug/keys if you have one.',
    model: 'lucataco/sam3-video',
    ports: [
      IMAGE({ required: false }),
      { id: 'prompt', label: 'Concept prompt', type: 'text', key: 'prompt', required: false },
    ],
  }),
  makeReplicateNode({
    type: 'groundedSam',
    label: 'Grounded SAM',
    group: 'Segment',
    description:
      'Text-prompted segmentation (Grounding DINO + SAM). Masks what the prompt describes; subtract a negative prompt. Slug: schananas/grounded_sam.',
    model: 'schananas/grounded_sam',
    ports: [
      IMAGE(),
      { id: 'mask_prompt', label: 'Mask prompt', type: 'text', key: 'mask_prompt', required: true },
      {
        id: 'negative_mask_prompt',
        label: 'Negative mask prompt',
        type: 'text',
        key: 'negative_mask_prompt',
        required: false,
      },
    ],
    scalars: [
      {
        field: {
          kind: 'number',
          key: 'adjustment_factor',
          label: 'Adjustment factor',
          min: -25,
          max: 25,
          step: 1,
        },
        default: 0,
      },
    ],
    outputs: [
      { id: 'mask', label: 'Mask', type: 'image', index: 2 },
      { id: 'invertedMask', label: 'Inverted mask', type: 'image', index: 3 },
      { id: 'annotated', label: 'Annotated', type: 'image', index: 0 },
      { id: 'negAnnotated', label: 'Neg. annotated', type: 'image', index: 1 },
    ],
  }),

  // ---- Background removal ----
  makeReplicateNode({
    type: 'birefnetV3',
    label: 'BiRefNet',
    group: 'Background removal',
    description: 'High-accuracy background removal. Verified slug: men1scus/birefnet.',
    model: 'men1scus/birefnet',
    ports: [IMAGE()],
  }),
  makeReplicateNode({
    type: 'isnetAnime',
    label: 'Background removal (rembg)',
    group: 'Background removal',
    description:
      'Background removal (rembg / IS-Net). Verified slug: cjwbw/rembg. For the isnet-anime variant set model_name via Extra inputs (JSON) if the chosen model supports it.',
    model: 'cjwbw/rembg',
    ports: [IMAGE()],
  }),
  makeReplicateNode({
    type: 'briaRmbg',
    label: 'Bria RMBG 2.0',
    group: 'Background removal',
    description: 'Commercial-grade background removal (bria/remove-background).',
    model: 'bria/remove-background',
    ports: [IMAGE()],
  }),

  // ---- Restore & upscale ----
  makeReplicateNode({
    type: 'realEsrgan',
    label: 'Real-ESRGAN upscale',
    group: 'Restore & upscale',
    description: 'Upscale / enhance an image (nightmareai/real-esrgan).',
    model: 'nightmareai/real-esrgan',
    ports: [IMAGE()],
    scalars: [
      { field: { kind: 'number', key: 'scale', label: 'Scale', min: 1, max: 10, step: 1 }, default: 4 },
      { field: { kind: 'boolean', key: 'face_enhance', label: 'Face enhance' }, default: false },
    ],
  }),
  makeReplicateNode({
    type: 'gfpgan',
    label: 'GFPGAN face restore',
    group: 'Restore & upscale',
    description: 'Restore faces in an image (tencentarc/gfpgan).',
    model: 'tencentarc/gfpgan',
    ports: [IMAGE({ key: 'img' })],
    scalars: [
      {
        field: {
          kind: 'select',
          key: 'version',
          label: 'Version',
          options: ['v1.2', 'v1.3', 'v1.4', 'RestoreFormer'].map((v) => ({ value: v, label: v })),
        },
        default: 'v1.4',
      },
      { field: { kind: 'number', key: 'scale', label: 'Scale', min: 1, max: 10, step: 1 }, default: 2 },
    ],
  }),
  makeReplicateNode({
    type: 'ddcolor',
    label: 'Colorize (DDColor)',
    group: 'Restore & upscale',
    description: 'Colourise black & white photos (piddnad/ddcolor).',
    model: 'piddnad/ddcolor',
    ports: [IMAGE()],
  }),
  makeReplicateNode({
    type: 'clarityUpscaler',
    label: 'Clarity Upscaler',
    group: 'Restore & upscale',
    description: 'Creative, detail-adding upscaler with an optional prompt (philz1337x/clarity-upscaler).',
    model: 'philz1337x/clarity-upscaler',
    ports: [IMAGE(), PROMPT({ required: false })],
    scalars: [
      { field: { kind: 'number', key: 'scale_factor', label: 'Scale factor', min: 1, max: 4, step: 1 }, default: 2 },
    ],
  }),
  makeReplicateNode({
    type: 'codeformer',
    label: 'CodeFormer face restore',
    group: 'Restore & upscale',
    description: 'Face restoration with adjustable fidelity (sczhou/codeformer).',
    model: 'sczhou/codeformer',
    ports: [IMAGE()],
    scalars: [
      {
        field: { kind: 'number', key: 'codeformer_fidelity', label: 'Fidelity', min: 0, max: 1, step: 0.05 },
        default: 0.7,
      },
    ],
  }),
  makeReplicateNode({
    type: 'supir',
    label: 'SUPIR restore',
    group: 'Restore & upscale',
    description: 'High-quality photo restoration + upscale, optionally prompt-guided (zsxkib/supir).',
    model: 'zsxkib/supir',
    ports: [IMAGE(), PROMPT({ required: false })],
  }),

  // ---- Image → text (captioning / VLM) ----
  makeReplicateNode({
    type: 'blipCaption',
    label: 'Image Caption (BLIP)',
    group: 'Describe',
    description:
      'Lightweight image captioning / VQA (salesforce/blip). Leave the question empty to caption, or ask a question.',
    model: 'salesforce/blip',
    output: 'text',
    ports: [
      IMAGE(),
      { id: 'prompt', label: 'Question', type: 'text', key: 'question', required: false },
    ],
  }),
  makeReplicateNode({
    type: 'moondream',
    label: 'Moondream (VLM)',
    group: 'Describe',
    description: 'Small vision-language model — ask a question about the image (lucataco/moondream2).',
    model: 'lucataco/moondream2',
    output: 'text',
    ports: [
      IMAGE(),
      { id: 'prompt', label: 'Question', type: 'text', key: 'prompt', required: false },
    ],
  }),
  makeReplicateNode({
    type: 'llava',
    label: 'LLaVA (VLM)',
    group: 'Describe',
    description: 'Larger vision-language model for detailed image Q&A (yorickvp/llava-13b).',
    model: 'yorickvp/llava-13b',
    output: 'text',
    ports: [IMAGE(), { id: 'prompt', label: 'Question', type: 'text', key: 'prompt', required: false }],
  }),
  makeReplicateNode({
    type: 'clipInterrogator',
    label: 'CLIP Interrogator',
    group: 'Describe',
    description: 'Reverse-engineer a text prompt from an image (pharmapsychotic/clip-interrogator).',
    model: 'pharmapsychotic/clip-interrogator',
    output: 'text',
    ports: [IMAGE()],
    scalars: [
      {
        field: {
          kind: 'select',
          key: 'mode',
          label: 'Mode',
          options: ['best', 'fast', 'classic', 'negative'].map((v) => ({ value: v, label: v })),
        },
        default: 'best',
      },
    ],
  }),
  makeReplicateNode({
    type: 'ocr',
    label: 'OCR (text extract)',
    group: 'Describe',
    description: 'Extract text from an image (abiruyt/text-extract-ocr).',
    model: 'abiruyt/text-extract-ocr',
    output: 'text',
    ports: [IMAGE()],
  }),

  // ---- Custom ----
  makeReplicateNode({
    type: 'replicateCustom',
    label: 'Replicate (custom)',
    group: 'Custom',
    description:
      'Run any Replicate model. Set the slug, wire up to two images/masks + a prompt, and add any other inputs via Extra inputs (JSON).',
    model: '',
    ports: [
      IMAGE({ required: false }),
      { id: 'image2', label: 'Image 2 / mask', type: 'image', key: 'mask', required: false },
      { id: 'prompt', label: 'Prompt', type: 'text', key: 'prompt', required: false },
    ],
  }),
];
