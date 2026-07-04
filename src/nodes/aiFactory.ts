// Factory that turns a compact model spec into a Replicate-backed node.
//
// A node can have MANY inputs. Each declares a typed input port (image / mask /
// text) mapped to a Replicate input key that is editable in the node's advanced
// settings. Text ports can be typed inline instead of wired. Anything a model
// needs that isn't a declared port can be supplied via the per-node "Extra
// inputs (JSON)" field. This keeps nodes working even as Replicate model schemas
// change, and lets you supply every input a model supports.

import type { ComputeResult, ConfigField, NodeDefinition, PortSpec } from '../types';
import { platform } from '../lib/platform';
import { downscaleToMax } from '../lib/image';
import { runModel } from '../lib/replicate';
import { str } from './helpers';

/**
 * Longest-side cap applied to every image/mask before it is encoded for
 * Replicate. Keeps real-camera photos from being sent at full resolution
 * (opaque 413/422s, memory doubling, main-thread jank). Same-sized image+mask
 * pairs stay aligned because the scale factor is identical.
 */
export const MAX_AI_IMAGE_DIM = 2048;
import { buildReplicateInput, resolveOutputs, type AiOutput, type AiPort, type AiScalar } from './aiMapping';

export interface AiSpec {
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
  /** Expose a first-class "seed" input (blank = random) for reproducibility. */
  seed?: boolean;
}

/** A seed scalar: blank omits it (random), a number makes the run reproducible. */
const SEED_SCALAR: AiScalar = {
  field: { kind: 'number', key: 'seed', label: 'Seed (blank = random)', advanced: true },
  default: '',
};

export function makeReplicateNode(spec: AiSpec): NodeDefinition {
  const inputs: PortSpec[] = spec.ports.map((p) => ({
    id: p.id,
    label: p.label,
    type: p.type,
    required: p.required,
  }));
  const scalars = [...(spec.scalars ?? []), ...(spec.seed ? [SEED_SCALAR] : [])];
  const outputPorts: AiOutput[] = spec.outputs ?? [
    { id: 'out', label: 'Output', type: spec.output === 'text' ? 'text' : 'image' },
  ];
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
      const encodeForModel = (img: Parameters<typeof platform.encodePng>[0]) =>
        platform.encodePng(downscaleToMax(img, MAX_AI_IMAGE_DIM));
      const input = buildReplicateInput(spec.ports, scalars, config, inp, encodeForModel);

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
      // A failed image download shouldn't lose the outputs that succeeded, so
      // each fetch is isolated; the first error is kept in case they all fail.
      let firstError: unknown;
      for (const [portId, out] of Object.entries(resolved)) {
        if (!out) result[portId] = undefined;
        else if ('text' in out) result[portId] = { kind: 'text', text: out.text };
        else {
          jobs.push(
            platform
              .fetchImage(out.url, signal)
              .then((img) => void (result[portId] = img))
              .catch((e) => void (firstError ??= e)),
          );
        }
      }
      if (jobs.length) onProgress?.('Downloading results…');
      await Promise.all(jobs);

      // A cancel during the downloads must not commit a half-populated result as
      // success — surface it as an abort so the node resets to out-of-date.
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      if (Object.values(result).every((v) => v == null)) {
        throw firstError ?? new Error('Model returned no usable output');
      }
      return result;
    },
  };
}

/** An image input port (default key "image", required). */
export const IMAGE = (over: Partial<AiPort> = {}): AiPort => ({
  id: 'image',
  label: 'Image',
  type: 'image',
  key: 'image',
  required: true,
  ...over,
});

/** A text prompt port (default key "prompt", required). */
export const PROMPT = (over: Partial<AiPort> = {}): AiPort => ({
  id: 'prompt',
  label: 'Prompt',
  type: 'text',
  key: 'prompt',
  required: true,
  ...over,
});
