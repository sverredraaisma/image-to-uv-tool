// Core data model for the node-based generation tool.
//
// All image data is represented as a plain RGBA pixel buffer (`RasterImage`) so
// that every processing node is a pure function that can run and be unit-tested
// in Node without a real canvas. The browser/canvas only appears at the edges
// (uploading a file, rendering a preview, talking to Replicate).

/** Semantic type of a port, used for connection-compatibility checks. */
export type PortType = 'image' | 'mask' | 'text' | 'stl';

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

export interface StlValue {
  kind: 'stl';
  triangleCount: number;
  /** Flat triangle vertices [ax,ay,az, bx,by,bz, cx,cy,cz, …] (length = count*9). */
  triangles: Float32Array;
}

/** Any value that can travel along an edge / sit on a port. */
export type DataValue = RasterImage | TextValue | StlValue;

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
  /** Report human-readable progress (e.g. "polling prediction…"). */
  onProgress?: (message: string) => void;
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
}

export interface SavedGraph {
  version: 1;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
