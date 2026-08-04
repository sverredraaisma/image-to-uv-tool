// Core data model for the node-based generation tool.
//
// All image data is represented as a plain RGBA pixel buffer (`RasterImage`) so
// that every processing node is a pure function that can run and be unit-tested
// in Node without a real canvas. The browser/canvas only appears at the edges
// (uploading a file, rendering a preview, talking to Replicate).

/** Semantic type of a port, used for connection-compatibility checks. */
export type PortType = 'image' | 'mask' | 'text' | 'stl' | 'sequence' | 'splat' | 'transform';

/** A raw RGBA raster image. `data` length must equal width * height * 4. */
export interface RasterImage {
  kind: 'image';
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA, row-major
}

export interface TextValue {
  kind: 'text';
  text: string;
}

/**
 * A triangle-soup mesh. The kind is `stl` for historical reasons — it was the
 * only format the tool knew — but it carries OBJ meshes too, which is what the
 * optional surface attributes below are for. Anything that only wants geometry
 * (the STL exporter, the previews) can keep ignoring them.
 */
export interface StlValue {
  kind: 'stl';
  triangleCount: number;
  /** Flat triangle vertices [ax,ay,az, bx,by,bz, cx,cy,cz, …] (length = count*9). */
  triangles: Float32Array;
  /**
   * Per-vertex texture coordinates [au,av, bu,bv, cu,cv, …] (length = count*6),
   * in OBJ convention: 0–1, origin bottom-left. Absent if the mesh is unmapped.
   */
  uvs?: Float32Array;
  /**
   * Per-vertex colours [ar,ag,ab, br,bg,bb, …] (length = count*9), 0–255. From
   * OBJ's `v x y z r g b` extension. Absent if the mesh carries no colour.
   */
  colours?: Uint8Array;
}

/**
 * An ordered bundle of frames travelling down a single edge — a decoded GIF /
 * animated WebP, or any other run of images that belong together.
 *
 * It exists so one wire can carry a whole animation: the lenticular node takes
 * N frames, and dragging N edges out of an animation by hand would be absurd.
 * Nodes are run once per frame when one of these reaches an image input (see
 * `engine/sequenceMap.ts`), so an ordinary pixel op works on a whole animation.
 * `asImage` still collapses one to its first frame, for the nodes that opt out
 * of that and for anything reading a sequence as a single picture.
 */
export interface SequenceValue {
  kind: 'sequence';
  frames: RasterImage[];
  /** Per-frame display duration in ms; same length as `frames`. */
  delaysMs?: number[];
}

/**
 * A 3D Gaussian splat cloud — a captured scene as a few hundred thousand
 * translucent ellipsoids rather than as geometry.
 *
 * Structure-of-arrays, and deliberately flat: a cloud is one or two orders of
 * magnitude bigger than any mesh this tool handles, so it is stored the way it
 * will be read (one pass per attribute, no per-splat objects) and passed along
 * edges by reference, never cloned.
 *
 * Only the DC term of each splat's spherical harmonics is kept, as a plain
 * RGBA. The higher bands are what make a splat's colour change with the angle
 * you look from, and dropping them costs the print its moving specular
 * highlights — but they are 45 floats a splat, which is more memory than a
 * browser tab has to spare on a scene this size. See `lib/splat/parse.ts`.
 */
export interface SplatValue {
  kind: 'splat';
  count: number;
  /** Centres [x,y,z, …] (length = count*3), in the file's own units. */
  positions: Float32Array;
  /** Ellipsoid radii [sx,sy,sz, …] (length = count*3), same units. */
  scales: Float32Array;
  /** Orientations as unit quaternions [x,y,z,w, …] (length = count*4). */
  rotations: Float32Array;
  /** Colour and opacity [r,g,b,a, …] (length = count*4), 0–255, already sRGB. */
  colours: Uint8ClampedArray;
  /** File name it came from, for the reports. */
  name?: string;
  /** Splats dropped on import to stay inside the budget, if any. */
  droppedCount?: number;
}

/**
 * A placed camera: where you stood, which way you faced, and how much of the
 * scene the sheet spans.
 *
 * `scale` is scene units per millimetre of print, which is the one number that
 * ties a captured scene of arbitrary size to a physical sheet: a print 100 mm
 * across at scale 0.02 spans 2 units of the scene. It is what the Splat Camera
 * editor's zoom sets, and what the view renderer turns back into millimetres.
 */
export interface TransformValue {
  kind: 'transform';
  /** Camera position in scene units. */
  position: [number, number, number];
  /** Camera orientation, degrees: pitch (X), yaw (Y), roll (Z), applied Y·X·Z. */
  rotationDeg: [number, number, number];
  /** Scene units per millimetre of print. */
  scale: number;
}

/** Any value that can travel along an edge / sit on a port. */
export type DataValue = RasterImage | TextValue | StlValue | SequenceValue | SplatValue | TransformValue;

/** Kind string of a DataValue, for runtime checks. */
export type DataKind = DataValue['kind'];

export interface PortSpec {
  id: string;
  label: string;
  type: PortType;
  /** Input ports only: accept more than one incoming connection. */
  multiple?: boolean;
  /** Input ports only: the node can't compute until this is connected/filled. */
  required?: boolean;
}

// ---------------------------------------------------------------------------
// Config field descriptors — declaratively describe the simple controls that
// render directly on a node (and in its settings popup).
// ---------------------------------------------------------------------------

interface ConfigFieldBase {
  key: string;
  label: string;
  /** Only show this field in the popup, not inline on the node. */
  advanced?: boolean;
}
export interface NumberField extends ConfigFieldBase {
  kind: 'number';
  min?: number;
  max?: number;
  step?: number;
}
export interface TextFieldSpec extends ConfigFieldBase {
  kind: 'text';
  multiline?: boolean;
  placeholder?: string;
}
export interface SelectField extends ConfigFieldBase {
  kind: 'select';
  options: { value: string; label: string }[];
}
export interface BooleanField extends ConfigFieldBase {
  kind: 'boolean';
}
export interface ColorField extends ConfigFieldBase {
  kind: 'color';
}
export type ConfigField = NumberField | TextFieldSpec | SelectField | BooleanField | ColorField;

export type NodeConfig = Record<string, unknown>;

/** Context handed to a node's compute function. */
export interface ComputeContext {
  /** Resolved input values keyed by input port id. Arrays for `multiple` inputs. */
  inputs: Record<string, DataValue | DataValue[] | undefined>;
  config: NodeConfig;
  /** Replicate API key. */
  apiKey: string | null;
  /** OpenRouter API key (for LLM nodes). */
  openRouterKey: string | null;
  proxyUrl: string | null;
  signal?: AbortSignal;
  /**
   * Report human-readable progress (e.g. "polling prediction…"), optionally
   * with a 0–1 fraction of the whole job, which draws a bar on the node.
   */
  onProgress?: (message: string, fraction?: number) => void;
  /**
   * The user has been shown how big this node's output would be and has agreed
   * to wait for it. Set for one run at a time by the oversize prompt; a node
   * that can produce a raster over the usual limit passes it to its renderer.
   */
  allowOversize?: boolean;
}

/** Output values keyed by output port id. */
export type ComputeResult = Record<string, DataValue | undefined>;

export interface NodeDefinition {
  type: string;
  label: string;
  category: string;
  /** Optional sub-group within a category (e.g. AI capability: "Generate"). */
  group?: string;
  description?: string;
  /**
   * Auto-run nodes recompute automatically as soon as all their inputs are up
   * to date. Manual nodes (e.g. paid AI calls) only run when the user asks.
   */
  autoRun: boolean;
  inputs: PortSpec[];
  outputs: PortSpec[];
  configFields?: ConfigField[];
  defaultConfig: () => NodeConfig;
  compute: (ctx: ComputeContext) => Promise<ComputeResult> | ComputeResult;
  /** Node exposes a large custom editor popup (e.g. the area picker). */
  customEditor?: string;
  /**
   * Whether the node runs once per frame when a Sequence lands on an image
   * input, its image outputs coming back as a Sequence.
   *
   * Left undefined this is derived — image in and image out, and not already
   * handling sequences itself (see `engine/sequenceMap.ts`), which covers
   * every ordinary pixel op. Set it to opt out, or pass a predicate to leave
   * the choice to the node's own config, which is how the paid AI nodes make a
   * frame-by-frame run something you ask for rather than something you get.
   */
  mapsSequences?: boolean | ((config: NodeConfig) => boolean);
  /**
   * Uses generative AI to synthesise new imagery/text (as opposed to analysing
   * or enhancing an existing image). Drives the header "Gen AI" toggle (hides
   * these from the menus) and shows a badge on the node.
   */
  genAI?: boolean;
}

// ---------------------------------------------------------------------------
// Graph state (persisted) vs. runtime state (never persisted).
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  config: NodeConfig;
  /** Muted: pass a compatible input straight through instead of computing. */
  bypassed?: boolean;
}

export interface GraphEdge {
  id: string;
  source: string;
  sourceHandle: string; // output port id
  target: string;
  targetHandle: string; // input port id
}

export type NodeStatus = 'outOfDate' | 'upToDate' | 'running' | 'error';

export interface NodeRuntime {
  status: NodeStatus;
  outputs: ComputeResult;
  error?: string;
  progress?: string;
  /** 0–1 through a chunked run, when the node knows how much is left. */
  progressFraction?: number;
}

export interface SavedGraph {
  version: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
