// Running an image node over a whole Sequence, one frame at a time.
//
// Every node that takes an image and returns an image is, by construction, a
// function of one frame — so it is also a function of an animation, applied
// frame by frame. Rather than teach ~90 nodes to loop, the loop lives here and
// wraps `compute` at the two places a node is ever run (the store's scheduler
// and the pipeline subgraph evaluator).
//
// The rule is data-driven: nothing happens until a Sequence actually arrives on
// an image input, and then the node runs once per frame and its image outputs
// come back bundled as a Sequence. A still wired alongside an animation is
// reused for every frame, which is what makes Combine, Apply Mask and the rest
// compose an overlay onto a whole GIF without any special case.
//
// What is *not* mapped is as important:
//
//   • Nodes that already speak Sequence — anything with a sequence port, or a
//     `multiple` image input that collects frames itself (Lenticular Print) —
//     handle the whole animation in one run, and mapping them would run the
//     whole print once per frame.
//   • Pipeline nodes, because the nodes *inside* the subgraph map instead; the
//     outer node would multiply the work by the frame count again.
//   • Anything a node definition opts out of, which is how the paid AI nodes
//     make a 30× fan-out a decision rather than a default.

import type {
  ComputeContext,
  ComputeResult,
  DataValue,
  NodeConfig,
  NodeDefinition,
  RasterImage,
  SequenceValue,
} from '../types';
import type { ResolvedPorts } from './ports';

/**
 * Most frames one node run will map over. A guard, not a design limit: a
 * hundred-frame GIF through a chain of ops is a lot of full-size rasters held
 * at once, and a runaway is better caught with a sentence than an out-of-memory.
 */
export const MAX_MAPPED_FRAMES = 240;

const isSequence = (v: DataValue | DataValue[] | undefined): v is SequenceValue =>
  !Array.isArray(v) && v?.kind === 'sequence';

const isImage = (v: DataValue | undefined): v is RasterImage => v?.kind === 'image';

/**
 * Does this node run once per frame when a Sequence arrives, if the definition
 * does not say otherwise? Image in, image out, and not already in the sequence
 * business.
 */
export function mapsSequencesByDefault(def: NodeDefinition, ports: ResolvedPorts): boolean {
  // A pipeline's inner nodes do the mapping; doing it out here as well would
  // run the whole subgraph once per frame *and* map inside it.
  if (def.type === 'pipeline') return false;
  // Already speaks Sequence, in either direction.
  if (ports.inputs.some((p) => p.type === 'sequence')) return false;
  if (ports.outputs.some((p) => p.type === 'sequence')) return false;
  // Collects many images on one port — that is a node gathering frames itself.
  if (ports.inputs.some((p) => p.multiple)) return false;
  const takesImage = ports.inputs.some((p) => p.type === 'image' || p.type === 'mask');
  const givesImage = ports.outputs.some((p) => p.type === 'image' || p.type === 'mask');
  return takesImage && givesImage;
}

/** The definition's decision, falling back to {@link mapsSequencesByDefault}. */
export function mapsSequences(def: NodeDefinition, ports: ResolvedPorts, config: NodeConfig): boolean {
  const declared = def.mapsSequences;
  if (typeof declared === 'function') return declared(config);
  if (typeof declared === 'boolean') return declared;
  return mapsSequencesByDefault(def, ports);
}

/** The frame at `index` of a sequence, holding on the last one past the end. */
const frameAt = (seq: SequenceValue, index: number): RasterImage | undefined =>
  seq.frames[Math.min(index, seq.frames.length - 1)];

/** One frame's worth of a value: sequences step, everything else repeats. */
function valueAtFrame(
  value: DataValue | DataValue[] | undefined,
  index: number,
): DataValue | DataValue[] | undefined {
  if (Array.isArray(value)) return value.map((v) => (isSequence(v) ? (frameAt(v, index) ?? v) : v));
  return isSequence(value) ? frameAt(value, index) : value;
}

/**
 * Run `def.compute` once per frame and bundle the image outputs back into
 * Sequences, or run it once when nothing sequenced is wired in.
 *
 * Non-image outputs (an Info report, a coverage figure, a mesh) keep the first
 * frame's value: they describe the run, and N copies of a slightly different
 * sentence would be worse than one.
 */
export async function computeMaybeMapped(
  def: NodeDefinition,
  ports: ResolvedPorts,
  ctx: ComputeContext,
): Promise<ComputeResult> {
  if (!mapsSequences(def, ports, ctx.config)) return def.compute(ctx);

  // Only the image-carrying inputs decide the frame count; a Sequence wired
  // somewhere a node reads as text has nothing to do with it.
  const imagePorts = ports.inputs.filter((p) => p.type === 'image' || p.type === 'mask');
  const sequences = imagePorts
    .map((p) => ctx.inputs[p.id])
    .filter((v): v is SequenceValue => isSequence(v) && v.frames.length > 0);
  if (!sequences.length) return def.compute(ctx);

  const frames = Math.max(...sequences.map((s) => s.frames.length));
  if (frames > MAX_MAPPED_FRAMES) {
    throw new Error(
      `${def.label} would run over ${frames} frames — the limit is ${MAX_MAPPED_FRAMES}. ` +
        `Reduce the frame count on the Animation Input.`,
    );
  }
  // Timing comes from the longest sequence that carries any, so a GIF keeps its
  // own pacing all the way down a chain of ops and into an export.
  const timed = sequences
    .filter((s) => s.delaysMs?.length === s.frames.length)
    .sort((a, b) => b.frames.length - a.frames.length)[0];

  const collected = new Map<string, (RasterImage | undefined)[]>();
  const scalars: ComputeResult = {};
  for (let i = 0; i < frames; i++) {
    if (ctx.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const label = `Frame ${i + 1}/${frames}`;
    ctx.onProgress?.(label);

    const inputs: ComputeContext['inputs'] = {};
    for (const [key, value] of Object.entries(ctx.inputs)) inputs[key] = valueAtFrame(value, i);
    const result = await def.compute({
      ...ctx,
      inputs,
      // The node's own progress messages still get through, behind the count —
      // a slow per-frame node should say what it is doing *and* where it is.
      onProgress: (message) => ctx.onProgress?.(`${label} · ${message}`),
    });

    for (const [key, value] of Object.entries(result)) {
      if (isImage(value)) {
        if (!collected.has(key)) collected.set(key, []);
        collected.get(key)!.push(value);
      } else if (i === 0) {
        scalars[key] = value;
      }
    }
  }

  const out: ComputeResult = { ...scalars };
  for (const [key, images] of collected) {
    const present = images.filter((img): img is RasterImage => !!img);
    if (!present.length) continue;
    out[key] = {
      kind: 'sequence',
      frames: present,
      // Only if they still line up — a node that skipped a frame has broken the
      // correspondence, and wrong timings are worse than none.
      delaysMs: timed && present.length === frames ? timed.delaysMs : undefined,
    };
  }
  return out;
}
