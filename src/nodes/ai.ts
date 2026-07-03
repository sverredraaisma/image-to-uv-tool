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

import type { ComputeResult, ConfigField, NodeDefinition, PortSpec, PortType } from '../types';
import { platform } from '../lib/platform';
import { firstOutputText, firstOutputUrl, runModel } from '../lib/replicate';
import { asImage, asText, str } from './helpers';

interface AiPort {
  id: string;
  label: string;
  type: PortType;
  /** Default Replicate input key this port feeds (editable per node). */
  key: string;
  required?: boolean;
}

/** An output port. Models can return several things (array items / object keys). */
interface AiOutput {
  id: string;
  label: string;
  type: 'image' | 'text';
  /** Pick this array index from the model output. */
  index?: number;
  /** Pick this object key from the model output. */
  key?: string;
}

/** A model-specific scalar input (number/enum/boolean) with its real default. */
interface AiScalar {
  field: ConfigField;
  default: unknown;
}

interface AiSpec {
  type: string;
  label: string;
  description: string;
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

function coerceScalar(field: ConfigField, value: unknown): unknown {
  if (field.kind === 'number') return Number(value);
  if (field.kind === 'boolean') return Boolean(value);
  return value;
}

/** Narrow a model output to the sub-value for a specific output port. */
function pickOutput(output: unknown, out: AiOutput): unknown {
  if (out.index != null && Array.isArray(output)) return output[out.index];
  if (out.key != null && output && typeof output === 'object' && !Array.isArray(output)) {
    return (output as Record<string, unknown>)[out.key];
  }
  return output;
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
    description: spec.description,
    autoRun: false,
    inputs,
    outputs: outputPorts.map((o) => ({ id: o.id, label: o.label, type: o.type })),
    configFields,
    defaultConfig,
    compute: async ({ inputs: inp, config, apiKey, proxyUrl, signal, onProgress }) => {
      if (!apiKey) throw new Error('Set your Replicate API key first');
      const model = str(config.model, spec.model);
      const input: Record<string, unknown> = {};

      for (const p of spec.ports) {
        const key = str(config[`${p.id}Key`], p.key);
        if (p.type === 'image' || p.type === 'mask') {
          const img = asImage(inp[p.id]);
          if (p.required && !img) throw new Error(`Missing required input: ${p.label}`);
          if (img) {
            onProgress?.(`Encoding ${p.label}…`);
            input[key] = platform.encodePng(img);
          }
        } else if (p.type === 'text') {
          const text = asText(inp[p.id]) ?? str(config[p.id]);
          if (p.required && !text) throw new Error(`Missing required input: ${p.label}`);
          if (text) input[key] = text;
        }
      }

      for (const s of scalars) {
        const v = config[s.field.key];
        if (v !== '' && v !== undefined && v !== null) input[s.field.key] = coerceScalar(s.field, v);
      }

      const extra = str(config.extraInputs).trim();
      if (extra) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(extra);
        } catch {
          throw new Error('“Extra inputs” is not valid JSON');
        }
        if (parsed && typeof parsed === 'object') Object.assign(input, parsed);
      }

      const modelOutput = await runModel(model, input, { apiKey, proxyUrl, signal, onProgress });

      // Split the model output across the declared output ports, downloading
      // every image output in parallel so all previews are populated.
      const result: ComputeResult = {};
      const jobs: Promise<void>[] = [];
      for (const o of outputPorts) {
        const picked = pickOutput(modelOutput, o);
        if (o.type === 'text') {
          const text = firstOutputText(picked);
          result[o.id] = text != null ? { kind: 'text', text } : undefined;
        } else {
          const preferredKey = singleDefaultOutput ? str(config.outputKey) || undefined : undefined;
          const url = firstOutputUrl(picked, preferredKey);
          if (url) {
            jobs.push(platform.fetchImage(url, signal).then((img) => void (result[o.id] = img)));
          }
        }
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

export const aiNodes: NodeDefinition[] = [
  makeReplicateNode({
    type: 'depthAnythingV2',
    label: 'Depth Anything v2',
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
    type: 'sam2Image',
    label: 'SAM 2 (image)',
    description:
      'Segment Anything 2, automatic masks. Verified slug: meta/sam-2. Point/box prompts go in Extra inputs (JSON).',
    model: 'meta/sam-2',
    ports: [IMAGE()],
  }),
  makeReplicateNode({
    type: 'sam3Concept',
    label: 'SAM 3 (concept)',
    description:
      'Segment Anything 3 — segments everything matching a text concept. Default slug is the video model (lucataco/sam3-video); set an image SAM 3 slug/keys if you have one.',
    model: 'lucataco/sam3-video',
    ports: [
      IMAGE({ required: false }),
      { id: 'prompt', label: 'Concept prompt', type: 'text', key: 'prompt', required: false },
    ],
  }),
  makeReplicateNode({
    type: 'birefnetV3',
    label: 'BiRefNet',
    description: 'High-accuracy background removal. Verified slug: men1scus/birefnet.',
    model: 'men1scus/birefnet',
    ports: [IMAGE()],
  }),
  makeReplicateNode({
    type: 'isnetAnime',
    label: 'Background removal (rembg)',
    description:
      'Background removal (rembg / IS-Net). Verified slug: cjwbw/rembg. For the isnet-anime variant set model_name via Extra inputs (JSON) if the chosen model supports it.',
    model: 'cjwbw/rembg',
    ports: [IMAGE()],
  }),
  makeReplicateNode({
    type: 'groundedSam',
    label: 'Grounded SAM',
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
  // ---- Image → text (captioning / VLM) ----
  makeReplicateNode({
    type: 'blipCaption',
    label: 'Image Caption (BLIP)',
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
    description: 'Small vision-language model — ask a question about the image (lucataco/moondream2).',
    model: 'lucataco/moondream2',
    output: 'text',
    ports: [
      IMAGE(),
      { id: 'prompt', label: 'Question', type: 'text', key: 'prompt', required: false },
    ],
  }),
  makeReplicateNode({
    type: 'replicateCustom',
    label: 'Replicate (custom)',
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
