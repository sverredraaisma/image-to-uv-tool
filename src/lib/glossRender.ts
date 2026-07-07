// Self-contained WebGL renderer for the interactive 3D gloss preview. The
// artwork is drawn on a (lightly displaced) plane you can orbit; the gloss map
// drives a Blinn-Phong specular so varnished areas flash as the surface tilts
// under a fixed light. No third-party 3D dependency.
//
// The matrix / light math is pure and unit-tested; `createGlossRenderer` is the
// only browser-coupled part and returns null when WebGL is unavailable so the
// caller can fall back to the static 2D preview.

import type { RasterImage } from '../types';
import { luminance, resizeBilinear } from './image';

// ---------------------------------------------------------------------------
// Pure math (column-major 4×4 matrices, WebGL-ready). Exported for testing.
// ---------------------------------------------------------------------------

export type Mat4 = Float32Array;

export function mat4Identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** Column-major product a·b. */
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  }
  return o;
}

export function mat4Perspective(fovyRad: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovyRad / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

export function mat4Translation(x: number, y: number, z: number): Mat4 {
  const m = mat4Identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export function mat4Scale(x: number, y: number, z: number): Mat4 {
  const m = new Float32Array(16);
  m[0] = x;
  m[5] = y;
  m[10] = z;
  m[15] = 1;
  return m;
}

export function mat4RotationX(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = mat4Identity();
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}

export function mat4RotationY(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = mat4Identity();
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

/** Upper-left 3×3 (column-major) — the normal matrix for a pure rotation. */
export function mat3FromMat4(m: Mat4): Float32Array {
  const o = new Float32Array(9);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 3 + r] = m[c * 4 + r];
  return o;
}

/** Unit light direction (view space) from azimuth/elevation in degrees. */
export function lightDirection(azimuthDeg: number, elevationDeg: number): [number, number, number] {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const ce = Math.cos(el);
  return [ce * Math.cos(az), ce * Math.sin(az), Math.sin(el)];
}

export interface ViewParams {
  rotX: number; // radians
  rotY: number; // radians
  zoom: number; // 1 = default framing
  aspect: number; // canvas width / height
}

/**
 * Model-view-projection + normal matrix for the tilted plane. The model is a
 * pure rotation — the image aspect fit and heightmap displacement are baked into
 * the mesh vertices (so `normalMat` is just the rotation).
 */
export function computeMatrices(p: ViewParams): { mvp: Mat4; normalMat: Float32Array } {
  const rot = mat4Multiply(mat4RotationX(p.rotX), mat4RotationY(p.rotY));
  const dist = 3.0 / Math.max(0.2, p.zoom);
  const view = mat4Translation(0, 0, -dist);
  const proj = mat4Perspective((38 * Math.PI) / 180, Math.max(0.1, p.aspect), 0.1, 100);
  const mvp = mat4Multiply(proj, mat4Multiply(view, rot));
  return { mvp, normalMat: mat3FromMat4(rot) };
}

// ---------------------------------------------------------------------------
// WebGL renderer.
// ---------------------------------------------------------------------------

export interface GlossTextures {
  art?: RasterImage;
  gloss?: RasterImage;
  heightmap?: RasterImage;
}

export interface GlossRenderParams {
  rotX: number;
  rotY: number;
  zoom: number;
  azimuth: number;
  elevation: number;
  shininess: number;
  intensity: number;
  matte: number;
  relief: number;
  /** Relief-smoothing multiplier for the normal-map bake; defaults when omitted. */
  smooth?: number;
}

export interface GlossRenderer {
  setTextures(t: GlossTextures): void;
  render(p: GlossRenderParams): void;
  resize(width: number, height: number): void;
  dispose(): void;
  hasArt(): boolean;
}

// The mesh is a real displaced heightfield: each vertex is pushed along Z by the
// heightmap (CPU-side, so no vertex texture fetch — that fails to LINK where
// MAX_VERTEX_TEXTURE_IMAGE_UNITS is 0), giving a true 3D silhouette you can orbit.
// The *shading* detail, though, comes from a normal map baked from the full-res
// heightmap and sampled per-fragment (uHasNormal), so relief far finer than the
// tessellation still catches the light. The interpolated vertex normal is only
// the fallback used when no heightmap is wired.
const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec2 aUv;
uniform mat4 uMvp;
uniform mat3 uNormalMat;
varying vec2 vUv;
varying vec3 vNormal;
void main() {
  vUv = aUv;
  vNormal = normalize(uNormalMat * aNormal);
  gl_Position = uMvp * vec4(aPos, 1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 vUv;
varying vec3 vNormal;
uniform mat3 uNormalMat;
uniform sampler2D uArt;
uniform sampler2D uGloss;
uniform sampler2D uNormalTex;
uniform bool uHasGloss;
uniform bool uHasNormal;
uniform float uReliefStrength;
uniform vec3 uLightDir;
uniform float uShininess;
uniform float uIntensity;
uniform float uMatte;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec3 albedo = texture2D(uArt, vUv).rgb;
  float gloss = uHasGloss ? luma(texture2D(uGloss, vUv).rgb) : 0.0;
  // High-res per-fragment normal from the baked normal map (model space, same
  // frame as aNormal), else the interpolated mesh normal. The normal map is
  // baked at a reference relief; rescaling its tangent tilt by uReliefStrength
  // reproduces the exact surface normal at the live relief.
  vec3 N;
  if (uHasNormal) {
    vec3 nt = texture2D(uNormalTex, vUv).rgb * 2.0 - 1.0;
    nt.xy *= uReliefStrength;
    N = normalize(uNormalMat * normalize(nt));
  } else {
    N = normalize(vNormal);
  }
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 H = normalize(uLightDir + V);
  float ndl = max(dot(N, uLightDir), 0.0);
  float spec = pow(max(dot(N, H), 0.0), uShininess) * uIntensity * gloss;
  float shade = 0.28 + 0.72 * ndl;
  vec3 base = albedo * (1.0 - 0.55 * uMatte);
  vec3 col = base * shade + vec3(1.0) * spec;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('[gloss3d] shader compile failed:', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

// Mesh resolution. The renderer uses GRID_HI when OES_element_index_uint lets
// triangle indices be 32-bit; otherwise GRID_LO, whose (GRID_LO+1)² = 65536 is
// the densest grid that still fits Uint16 indices (max index 65535). The
// exported pure builders default to DEFAULT_GRID when no grid is passed.
const DEFAULT_GRID = 200;
const GRID_LO = 255; // 256² verts → max index 65535 (fits Uint16)
const GRID_HI = 512; // 513² verts → needs Uint32 indices
// Peak displacement (world units) per unit of `relief` (heightStrength). The
// plane spans 2 units, so relief=2 gives ±0.5·2·0.12 ≈ ±0.12 → a gentle bas-relief
// by default; raise the Relief strength control for a more dramatic mesh.
const RELIEF_SCALE = 0.12;
// The normal map is baked at this reference relief; the shader rescales its xy
// tilt by (live relief / this) so bump strength tracks the Relief control with
// no texture rebuild. 2 matches the node's default heightStrength.
const NORMAL_REF_RELIEF = 2;
// Before differencing the height field into a normal map, low-pass it with a box
// blur whose radius is (longer side · this · smooth-multiplier). This
// reconstructs the smooth surface behind 8-bit quantization: an isolated 240→241
// step gets spread over ~2·radius px instead of spiking into a one-pixel ridge,
// so gentle far-apart slopes stay gentle while genuine close, high-contrast
// detail still bumps. This is the radius *per unit* of the node's Relief
// smoothing control; the renderer multiplies it by that value.
const NORMAL_SMOOTH_FRACTION = 1 / 256;
// Default Relief-smoothing multiplier when a caller/params doesn't specify one
// (≈16px blur at a 2048px height field). Matches the node's heightSmooth default.
const DEFAULT_SMOOTH = 2;

/** Constant per-vertex UVs (image-upright), built once. */
function buildUvs(grid = DEFAULT_GRID): Float32Array {
  const row = grid + 1;
  const uv = new Float32Array(row * row * 2);
  for (let j = 0; j <= grid; j++) {
    for (let i = 0; i <= grid; i++) {
      const k = (j * row + i) * 2;
      uv[k] = i / grid;
      uv[k + 1] = 1 - j / grid;
    }
  }
  return uv;
}

/**
 * Constant triangle indices for the grid, built once. Uses Uint32 when the grid
 * is too dense for a Uint16 index (needs OES_element_index_uint at draw time).
 */
function buildIndices(grid = DEFAULT_GRID): Uint16Array | Uint32Array {
  const row = grid + 1;
  const idx = row * row - 1 > 65535 ? new Uint32Array(grid * grid * 6) : new Uint16Array(grid * grid * 6);
  let o = 0;
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const a = j * row + i;
      idx[o++] = a;
      idx[o++] = a + 1;
      idx[o++] = a + row;
      idx[o++] = a + 1;
      idx[o++] = a + row + 1;
      idx[o++] = a + row;
    }
  }
  return idx;
}

/** Bilinear luminance sample (0–1) of an image at UV coords (clamped). */
function sampleLum(img: RasterImage, u: number, v: number): number {
  const x = Math.min(1, Math.max(0, u)) * (img.width - 1);
  const y = Math.min(1, Math.max(0, v)) * (img.height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(img.width - 1, x0 + 1);
  const y1 = Math.min(img.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (px: number, py: number) => {
    const i = (py * img.width + px) * 4;
    return luminance(img.data[i], img.data[i + 1], img.data[i + 2]) / 255;
  };
  const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const bot = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return top * (1 - fy) + bot * fy;
}

/**
 * Build the displaced heightfield: positions (aspect-fit in x/y, pushed along z
 * by the heightmap) and per-vertex normals from the displaced surface. Flat
 * (z=0, +Z normals) when there's no heightmap. Exported for testing.
 */
export function buildGeometry(
  heightImg: RasterImage | undefined,
  planeAspect: number,
  relief: number,
  grid = DEFAULT_GRID,
): { positions: Float32Array; normals: Float32Array } {
  const row = grid + 1;
  const positions = new Float32Array(row * row * 3);
  const normals = new Float32Array(row * row * 3);
  const sx = planeAspect >= 1 ? 1 : planeAspect;
  const sy = planeAspect >= 1 ? 1 / planeAspect : 1;
  const amp = relief * RELIEF_SCALE;

  const z = new Float32Array(row * row);
  if (heightImg && amp !== 0) {
    for (let j = 0; j <= grid; j++) {
      for (let i = 0; i <= grid; i++) {
        z[j * row + i] = (sampleLum(heightImg, i / grid, 1 - j / grid) - 0.5) * amp;
      }
    }
  }
  const dx = (2 / grid) * sx;
  const dy = (2 / grid) * sy;
  for (let j = 0; j <= grid; j++) {
    for (let i = 0; i <= grid; i++) {
      const k = j * row + i;
      positions[k * 3] = ((i / grid) * 2 - 1) * sx;
      positions[k * 3 + 1] = ((j / grid) * 2 - 1) * sy;
      positions[k * 3 + 2] = z[k];
      // Central-difference surface normal (clamped at the edges).
      const zl = z[j * row + Math.max(0, i - 1)];
      const zr = z[j * row + Math.min(grid, i + 1)];
      const zd = z[Math.max(0, j - 1) * row + i];
      const zu = z[Math.min(grid, j + 1) * row + i];
      const nx = -(zr - zl) / (2 * dx);
      const ny = -(zu - zd) / (2 * dy);
      const len = Math.hypot(nx, ny, 1) || 1;
      normals[k * 3] = nx / len;
      normals[k * 3 + 1] = ny / len;
      normals[k * 3 + 2] = 1 / len;
    }
  }
  return { positions, normals };
}

/**
 * Separable box blur (clamp-to-edge) over a scalar field, via a sliding window
 * running sum — O(w·h) regardless of radius. Returns `src` unchanged when the
 * radius is below 1px. Used to reconstruct the smooth surface behind an 8-bit
 * height field before differencing it into normals.
 */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r < 1) return src;
  const win = 2 * r + 1;
  const clampI = (v: number, hi: number) => (v < 0 ? 0 : v > hi ? hi : v);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + clampI(k, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win;
      sum += src[row + clampI(x + r + 1, w - 1)] - src[row + clampI(x - r, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[clampI(k, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win;
      sum += tmp[clampI(y + r + 1, h - 1) * w + x] - tmp[clampI(y - r, h - 1) * w + x];
    }
  }
  return out;
}

/**
 * Bake a heightmap into a normal map at the heightmap's own (GPU-capped)
 * resolution, so per-fragment lighting can show detail far finer than the mesh.
 * The stored normal is a unit vector in the plane's model frame (x → +u,
 * y → −v, z → up) — the same slope convention as buildGeometry — computed at
 * `refRelief`; the shader rescales the xy tilt to the live relief. Because the
 * stored normal is linear in the height amplitude before normalisation,
 * scaling xy by (relief / refRelief) and renormalising yields the exact normal
 * at any relief.
 *
 * The height field is low-pass filtered first (blur radius = longer side ·
 * `smoothFraction`) so 8-bit quantization steps don't become one-pixel ridges:
 * the normal then reflects the surface's actual slope over distance — gentle
 * where ridges are far apart, strong where real detail is close together. Pass a
 * larger `smoothFraction` to suppress more stairstepping (at the cost of blurring
 * finer detail), or 0 to difference the raw samples. Exported for testing.
 */
export function buildNormalMap(
  heightImg: RasterImage,
  planeAspect: number,
  refRelief: number,
  smoothFraction = NORMAL_SMOOTH_FRACTION,
): RasterImage {
  const w = heightImg.width;
  const h = heightImg.height;
  const src = heightImg.data;
  const raw = new Float32Array(w * h);
  for (let i = 0, p = 0; i < raw.length; i++, p += 4) {
    raw[i] = luminance(src[p], src[p + 1], src[p + 2]) / 255;
  }
  // Smooth away 8-bit quantization staircases before differencing.
  const radius = Math.round(Math.max(w, h) * Math.max(0, smoothFraction));
  const lum = boxBlur(raw, w, h, radius);
  const sx = planeAspect >= 1 ? 1 : planeAspect;
  const sy = planeAspect >= 1 ? 1 / planeAspect : 1;
  const amp = refRelief * RELIEF_SCALE;
  // World-space height slope per unit luminance gradient (matches buildGeometry:
  // dz/dx = amp/(2·sx) · dLum/du, with dLum/du ≈ gradient·(dim−1)/2).
  const ax = (amp * (w - 1)) / (4 * sx);
  const ay = (amp * (h - 1)) / (4 * sy);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const yUp = (y > 0 ? y - 1 : 0) * w;
    const yDn = (y < h - 1 ? y + 1 : h - 1) * w;
    const yc = y * w;
    for (let x = 0; x < w; x++) {
      const xl = x > 0 ? x - 1 : 0;
      const xr = x < w - 1 ? x + 1 : w - 1;
      const gx = lum[yc + xr] - lum[yc + xl]; // +u (model +x)
      const gy = lum[yDn + x] - lum[yUp + x]; // +v row (model −y)
      let nx = -gx * ax;
      let ny = gy * ay;
      const inv = 1 / Math.hypot(nx, ny, 1);
      nx *= inv;
      ny *= inv;
      const o = (yc + x) * 4;
      out[o] = (nx * 0.5 + 0.5) * 255;
      out[o + 1] = (ny * 0.5 + 0.5) * 255;
      out[o + 2] = (inv * 0.5 + 0.5) * 255; // nz = 1·inv
      out[o + 3] = 255;
    }
  }
  return { kind: 'image', width: w, height: h, data: out };
}

/** GPUs cap texture size; keep uploads within a safe bound. */
function fitForGpu(img: RasterImage, max = 2048): RasterImage {
  const longest = Math.max(img.width, img.height);
  if (longest <= max) return img;
  const s = max / longest;
  return resizeBilinear(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)));
}

function uploadTexture(gl: WebGLRenderingContext, tex: WebGLTexture, img: RasterImage): void {
  const fit = fitForGpu(img);
  const data = new Uint8Array(fit.data.buffer, fit.data.byteOffset, fit.data.byteLength);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, fit.width, fit.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
}

export function createGlossRenderer(canvas: HTMLCanvasElement): GlossRenderer | null {
  // Try a range of context types / attributes so more environments succeed.
  // `failIfMajorPerformanceCaveat: false` allows a software (SwiftShader/llvmpipe)
  // context when hardware GL is unavailable; a WebGL2 context also satisfies the
  // WebGL1 API we use. Some setups still can't create any context (e.g. Firefox
  // "Exhausted GL driver options") — then we return null and the caller shows the
  // flat preview.
  const attempts: [string, WebGLContextAttributes][] = [
    ['webgl', { antialias: true, alpha: false, failIfMajorPerformanceCaveat: false }],
    ['experimental-webgl', { antialias: true, alpha: false, failIfMajorPerformanceCaveat: false }],
    ['webgl2', { antialias: true, alpha: false, failIfMajorPerformanceCaveat: false }],
  ];
  let gl: WebGLRenderingContext | null = null;
  for (const [type, attrs] of attempts) {
    try {
      const ctx = canvas.getContext(type, attrs);
      if (ctx) {
        gl = ctx as WebGLRenderingContext;
        break;
      }
    } catch {
      // Try the next context type (jsdom/headless throw here).
    }
  }
  if (!gl) return null;

  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  if (!vs || !fs || !prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('[gloss3d] program link failed:', gl.getProgramInfoLog(prog));
    return null;
  }

  const posBuf = gl.createBuffer();
  const normBuf = gl.createBuffer();
  const uvBuf = gl.createBuffer();
  const idxBuf = gl.createBuffer();
  if (!posBuf || !normBuf || !uvBuf || !idxBuf) return null;

  // A denser mesh (smoother silhouette) when 32-bit indices are available.
  const uintExt = gl.getExtension('OES_element_index_uint');
  const grid = uintExt ? GRID_HI : GRID_LO;

  // Constant UVs + indices upload once.
  const indices = buildIndices(grid);
  const indexType = indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, buildUvs(grid), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

  const aPos = gl.getAttribLocation(prog, 'aPos');
  const aNormal = gl.getAttribLocation(prog, 'aNormal');
  const aUv = gl.getAttribLocation(prog, 'aUv');
  const u = {
    mvp: gl.getUniformLocation(prog, 'uMvp'),
    normalMat: gl.getUniformLocation(prog, 'uNormalMat'),
    art: gl.getUniformLocation(prog, 'uArt'),
    gloss: gl.getUniformLocation(prog, 'uGloss'),
    hasGloss: gl.getUniformLocation(prog, 'uHasGloss'),
    lightDir: gl.getUniformLocation(prog, 'uLightDir'),
    shininess: gl.getUniformLocation(prog, 'uShininess'),
    intensity: gl.getUniformLocation(prog, 'uIntensity'),
    matte: gl.getUniformLocation(prog, 'uMatte'),
    normalTex: gl.getUniformLocation(prog, 'uNormalTex'),
    hasNormal: gl.getUniformLocation(prog, 'uHasNormal'),
    reliefStrength: gl.getUniformLocation(prog, 'uReliefStrength'),
  };

  const artTex = gl.createTexture();
  const glossTex = gl.createTexture();
  const normalTex = gl.createTexture();

  let hasArt = false;
  let hasGloss = false;
  let hasNormal = false;
  let planeAspect = 1;
  let heightImg: RasterImage | undefined;
  let builtRelief = NaN; // forces a geometry build on the first render
  let builtSmooth = DEFAULT_SMOOTH; // last smoothing the normal map was baked at
  let geometryDirty = true;

  gl.clearColor(0.09, 0.09, 0.11, 1);
  gl.enable(gl.DEPTH_TEST);

  const rebuildGeometry = (relief: number) => {
    const { positions, normals } = buildGeometry(heightImg, planeAspect, relief, grid);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.DYNAMIC_DRAW);
    builtRelief = relief;
    geometryDirty = false;
  };

  // Bake the heightmap into the normal-map texture at the given smoothing. Cheap
  // to skip (no heightmap → just clears hasNormal), so it's safe to call eagerly.
  const rebuildNormalMap = (smooth: number) => {
    if (heightImg && normalTex) {
      const frac = NORMAL_SMOOTH_FRACTION * Math.max(0, smooth);
      uploadTexture(gl, normalTex, buildNormalMap(heightImg, planeAspect, NORMAL_REF_RELIEF, frac));
      hasNormal = true;
    } else {
      hasNormal = false;
    }
    builtSmooth = smooth;
  };

  const bindAttrib = (buf: WebGLBuffer, loc: number, size: number) => {
    if (loc < 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  };

  return {
    hasArt: () => hasArt,
    setTextures(t) {
      if (t.art && artTex) {
        uploadTexture(gl, artTex, t.art);
        hasArt = true;
        planeAspect = t.art.width / t.art.height;
      } else {
        hasArt = false;
      }
      if (t.gloss && glossTex) {
        uploadTexture(gl, glossTex, t.gloss);
        hasGloss = true;
      } else {
        hasGloss = false;
      }
      // Keep the heightmap for CPU displacement (capped for fast sampling) and
      // bake it into a normal map (at the last-used smoothing) so per-fragment
      // shading resolves detail finer than the mesh tessellation.
      heightImg = t.heightmap ? fitForGpu(t.heightmap, 2048) : undefined;
      rebuildNormalMap(builtSmooth);
      geometryDirty = true;
    },
    resize(width, height) {
      canvas.width = Math.max(1, Math.floor(width));
      canvas.height = Math.max(1, Math.floor(height));
      gl.viewport(0, 0, canvas.width, canvas.height);
    },
    render(p) {
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!hasArt) return;
      if (geometryDirty || p.relief !== builtRelief) rebuildGeometry(p.relief);
      const smooth = Number.isFinite(p.smooth) ? (p.smooth as number) : DEFAULT_SMOOTH;
      if (smooth !== builtSmooth) rebuildNormalMap(smooth);

      const aspect = canvas.height > 0 ? canvas.width / canvas.height : 1;
      const { mvp, normalMat } = computeMatrices({ rotX: p.rotX, rotY: p.rotY, zoom: p.zoom, aspect });
      const [lx, ly, lz] = lightDirection(p.azimuth, p.elevation);

      gl.useProgram(prog);
      bindAttrib(posBuf, aPos, 3);
      bindAttrib(normBuf, aNormal, 3);
      bindAttrib(uvBuf, aUv, 2);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);

      gl.uniformMatrix4fv(u.mvp, false, mvp);
      gl.uniformMatrix3fv(u.normalMat, false, normalMat);
      gl.uniform3f(u.lightDir, lx, ly, lz);
      gl.uniform1f(u.shininess, Math.max(1, p.shininess));
      gl.uniform1f(u.intensity, p.intensity);
      gl.uniform1f(u.matte, p.matte);
      gl.uniform1i(u.hasGloss, hasGloss ? 1 : 0);
      gl.uniform1i(u.hasNormal, hasNormal ? 1 : 0);
      gl.uniform1f(u.reliefStrength, p.relief / NORMAL_REF_RELIEF);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, artTex);
      gl.uniform1i(u.art, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, glossTex);
      gl.uniform1i(u.gloss, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, normalTex);
      gl.uniform1i(u.normalTex, 2);

      gl.drawElements(gl.TRIANGLES, indices.length, indexType, 0);
    },
    dispose() {
      gl.deleteTexture(artTex);
      gl.deleteTexture(glossTex);
      gl.deleteTexture(normalTex);
      gl.deleteBuffer(posBuf);
      gl.deleteBuffer(normBuf);
      gl.deleteBuffer(uvBuf);
      gl.deleteBuffer(idxBuf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    },
  };
}
