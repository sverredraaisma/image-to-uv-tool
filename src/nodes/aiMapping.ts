// Pure mapping between node ports/config and the Replicate request/response.
// Kept side-effect-free (image encoding and fetching are injected) so the
// tricky input-building and multi-output-splitting logic is unit-testable
// without the store, the platform adapter, or the network.

import type { ComputeContext, ConfigField, NodeConfig, PortType, RasterImage } from '../types';
import { firstOutputText, firstOutputUrl } from '../lib/replicate';
import { asImage, asText, str } from './helpers';

export interface AiPort {
  id: string;
  label: string;
  type: PortType;
  /** Default Replicate input key this port feeds (editable per node). */
  key: string;
  required?: boolean;
}

/** An output port. Models can return several things (array items / object keys). */
export interface AiOutput {
  id: string;
  label: string;
  type: 'image' | 'text';
  /** Pick this array index from the model output. */
  index?: number;
  /** Pick this object key from the model output. */
  key?: string;
}

/** A model-specific scalar input (number/enum/boolean) with its real default. */
export interface AiScalar {
  field: ConfigField;
  default: unknown;
}

export function coerceScalar(field: ConfigField, value: unknown): unknown {
  if (field.kind === 'number') return Number(value);
  if (field.kind === 'boolean') return Boolean(value);
  return value;
}

/**
 * Build the Replicate `input` object from a node's ports, scalar fields and the
 * raw "Extra inputs (JSON)" field. Images are encoded via the injected
 * `encodeImage`. Throws if a required input is missing or the JSON is invalid.
 */
export function buildReplicateInput(
  ports: AiPort[],
  scalars: AiScalar[],
  config: NodeConfig,
  inputs: ComputeContext['inputs'],
  encodeImage: (img: RasterImage) => string,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};

  for (const p of ports) {
    const key = str(config[`${p.id}Key`], p.key);
    if (p.type === 'image' || p.type === 'mask') {
      const img = asImage(inputs[p.id]);
      if (p.required && !img) throw new Error(`Missing required input: ${p.label}`);
      if (img) input[key] = encodeImage(img);
    } else if (p.type === 'text') {
      const text = asText(inputs[p.id]) ?? str(config[p.id]);
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

  return input;
}

/** Narrow a model output to the sub-value for a specific output port. */
export function pickOutput(output: unknown, out: AiOutput): unknown {
  if (out.index != null && Array.isArray(output)) return output[out.index];
  if (out.key != null && output && typeof output === 'object' && !Array.isArray(output)) {
    return (output as Record<string, unknown>)[out.key];
  }
  return output;
}

export type ResolvedOutput = { url: string } | { text: string };

/**
 * Resolve each output port to a URL (to download) or text — pure, no fetching.
 * `preferredKey` only applies when there is a single default output port.
 */
export function resolveOutputs(
  outputPorts: AiOutput[],
  modelOutput: unknown,
  singleDefault: boolean,
  preferredKey?: string,
): Record<string, ResolvedOutput | undefined> {
  const result: Record<string, ResolvedOutput | undefined> = {};
  for (const o of outputPorts) {
    const picked = pickOutput(modelOutput, o);
    if (o.type === 'text') {
      const text = firstOutputText(picked);
      result[o.id] = text != null ? { text } : undefined;
    } else {
      const url = firstOutputUrl(picked, singleDefault ? preferredKey : undefined);
      result[o.id] = url ? { url } : undefined;
    }
  }
  return result;
}
