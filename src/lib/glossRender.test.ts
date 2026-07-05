import { describe, it, expect, vi } from 'vitest';
import {
  buildGeometry,
  computeMatrices,
  createGlossRenderer,
  lightDirection,
  mat3FromMat4,
  mat4Identity,
  mat4Multiply,
  mat4Perspective,
  mat4RotationX,
  mat4RotationY,
} from './glossRender';
import { createImage } from './image';

const zValues = (positions: Float32Array) => {
  const out: number[] = [];
  for (let i = 2; i < positions.length; i += 3) out.push(positions[i]);
  return out;
};

/** Minimal WebGL stub recording the calls the renderer makes. */
function fakeGl() {
  let k = 100;
  const uniforms: Record<string, number> = {};
  const calls = {
    matrices: [] as Float32Array[],
    draws: [] as { mode: number; count: number; type: number }[],
    textureUploads: 0,
  };
  const gl = {
    // constants (arbitrary distinct values)
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    ELEMENT_ARRAY_BUFFER: 6,
    STATIC_DRAW: 7,
    RGBA: 8,
    UNSIGNED_BYTE: 9,
    TEXTURE_2D: 10,
    TEXTURE_WRAP_S: 11,
    TEXTURE_WRAP_T: 12,
    CLAMP_TO_EDGE: 13,
    TEXTURE_MIN_FILTER: 14,
    TEXTURE_MAG_FILTER: 15,
    LINEAR: 16,
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 17,
    DEPTH_TEST: 18,
    COLOR_BUFFER_BIT: 19,
    DEPTH_BUFFER_BIT: 20,
    TEXTURE0: 33984,
    TRIANGLES: 22,
    UNSIGNED_SHORT: 23,
    FLOAT: 24,
    // creators
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    deleteShader: () => {},
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    getAttribLocation: () => 0,
    getUniformLocation: (_p: unknown, name: string) => ({ name, id: k++ }),
    createTexture: () => ({}),
    bindTexture: () => {},
    texImage2D: () => {
      calls.textureUploads++;
    },
    texParameteri: () => {},
    activeTexture: () => {},
    getParameter: () => 4,
    clearColor: () => {},
    enable: () => {},
    clear: () => {},
    viewport: () => {},
    useProgram: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    uniformMatrix4fv: (_l: unknown, _t: boolean, v: Float32Array) => calls.matrices.push(v),
    uniformMatrix3fv: (_l: unknown, _t: boolean, v: Float32Array) => calls.matrices.push(v),
    uniform3f: () => {},
    uniform1f: () => {},
    uniform2f: () => {},
    uniform1i: (l: { name: string } | null, val: number) => {
      if (l) uniforms[l.name] = val;
    },
    drawElements: (mode: number, count: number, type: number) => calls.draws.push({ mode, count, type }),
    deleteTexture: () => {},
    deleteBuffer: () => {},
    deleteProgram: () => {},
  };
  return { gl, calls, uniforms };
}

function fakeCanvas(gl: unknown): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.getContext = vi.fn(() => gl) as unknown as HTMLCanvasElement['getContext'];
  return canvas;
}

const mag = (v: number[]) => Math.hypot(...v);

describe('gloss render math', () => {
  it('lightDirection is a unit vector at the expected angles', () => {
    expect(lightDirection(0, 0)).toEqual([1, 0, 0]);
    const side = lightDirection(90, 0);
    expect(side[0]).toBeCloseTo(0, 6);
    expect(side[1]).toBeCloseTo(1, 6);
    const up = lightDirection(0, 90);
    expect(up[2]).toBeCloseTo(1, 6);
    for (const [az, el] of [
      [30, 20],
      [200, 60],
      [-45, 10],
    ]) {
      expect(mag([...lightDirection(az, el)])).toBeCloseTo(1, 6);
    }
  });

  it('identity multiplies as a no-op', () => {
    const rot = mat4RotationY(0.7);
    const prod = mat4Multiply(rot, mat4Identity());
    for (let i = 0; i < 16; i++) expect(prod[i]).toBeCloseTo(rot[i], 6);
  });

  it('rotation matrices compose (Rx·Ry ≠ Ry·Rx but both are valid rotations)', () => {
    const a = mat4Multiply(mat4RotationX(0.5), mat4RotationY(0.3));
    // A rotation preserves lengths: its columns are unit vectors.
    for (let c = 0; c < 3; c++) {
      const col = [a[c * 4], a[c * 4 + 1], a[c * 4 + 2]];
      expect(mag(col)).toBeCloseTo(1, 6);
    }
  });

  it('perspective has the canonical projective terms', () => {
    const p = mat4Perspective(Math.PI / 4, 2, 0.1, 100);
    expect(p[11]).toBe(-1);
    expect(p[0]).toBeCloseTo(p[5] / 2, 6); // f/aspect with aspect = 2
  });

  it('mat3FromMat4 extracts the upper-left rotation block', () => {
    const r = mat4RotationX(0.9);
    const m3 = mat3FromMat4(r);
    expect(m3).toHaveLength(9);
    expect(m3[0]).toBeCloseTo(r[0], 6);
    expect(m3[4]).toBeCloseTo(r[5], 6);
    expect(m3[8]).toBeCloseTo(r[10], 6);
  });

  it('computeMatrices yields finite 16- and 9-length matrices', () => {
    const { mvp, normalMat } = computeMatrices({ rotX: -0.3, rotY: 0.4, zoom: 1.2, aspect: 1.6 });
    expect(mvp).toHaveLength(16);
    expect(normalMat).toHaveLength(9);
    expect([...mvp, ...normalMat].every(Number.isFinite)).toBe(true);
  });
});

describe('buildGeometry (mesh displacement)', () => {
  it('is flat with +Z normals when there is no heightmap', () => {
    const { positions, normals } = buildGeometry(undefined, 1, 2);
    expect(zValues(positions).every((z) => z === 0)).toBe(true);
    expect(normals[0]).toBeCloseTo(0, 6); // nx
    expect(normals[1]).toBeCloseTo(0, 6); // ny
    expect(normals[2]).toBeCloseTo(1, 6); // nz
  });

  it('displaces along Z from the heightmap and scales with relief', () => {
    // Horizontal gradient: left black → right white.
    const h = createImage(8, 1, [0, 0, 0, 255]);
    for (let x = 4; x < 8; x++) h.data.set([255, 255, 255, 255], x * 4);

    const a = buildGeometry(h, 1, 2);
    const za = zValues(a.positions);
    const maxA = Math.max(...za);
    expect(maxA).toBeGreaterThan(0); // bright side pushed up
    expect(Math.min(...za)).toBeLessThan(0); // dark side pushed down

    // A slope in x tilts the surface normals off straight-up.
    let nx = 0;
    for (let i = 0; i < a.normals.length; i += 3) nx = Math.max(nx, Math.abs(a.normals[i]));
    expect(nx).toBeGreaterThan(0.01);

    // Higher relief ⇒ larger displacement.
    const b = buildGeometry(h, 1, 6);
    expect(Math.max(...zValues(b.positions))).toBeGreaterThan(maxA);
  });
});

describe('createGlossRenderer', () => {
  it('returns null when WebGL is unavailable (headless) instead of throwing', () => {
    const canvas = document.createElement('canvas');
    expect(createGlossRenderer(canvas)).toBeNull();
  });

  it('drives the full GL pipeline against a stub context', () => {
    const { gl, calls, uniforms } = fakeGl();
    const r = createGlossRenderer(fakeCanvas(gl));
    expect(r).not.toBeNull();
    if (!r) return;

    // No art yet → render clears but draws nothing.
    r.render({
      rotX: 0,
      rotY: 0,
      zoom: 1,
      azimuth: 135,
      elevation: 45,
      shininess: 32,
      intensity: 1,
      matte: 0,
      relief: 2,
    });
    expect(r.hasArt()).toBe(false);
    expect(calls.draws).toHaveLength(0);

    r.setTextures({
      art: createImage(4, 4, [200, 100, 50, 255]),
      gloss: createImage(4, 4, [255, 255, 255, 255]),
      heightmap: createImage(4, 4, [128, 128, 128, 255]),
    });
    expect(r.hasArt()).toBe(true);
    // Only art + gloss are GPU textures; the heightmap is CPU-sampled to displace
    // the mesh geometry.
    expect(calls.textureUploads).toBe(2);

    r.resize(320, 200);
    r.render({
      rotX: -0.3,
      rotY: 0.4,
      zoom: 1.2,
      azimuth: 135,
      elevation: 45,
      shininess: 32,
      intensity: 1.5,
      matte: 0.2,
      relief: 2,
    });

    // A textured, gloss-masked, displaced-mesh draw happened…
    expect(calls.draws).toHaveLength(1);
    expect(calls.draws[0].mode).toBe(gl.TRIANGLES);
    expect(calls.draws[0].count).toBeGreaterThan(0);
    expect(uniforms.uHasGloss).toBe(1);
    // …and both an MVP (16) and a normal (9) matrix were uploaded.
    expect(calls.matrices.some((m) => m.length === 16)).toBe(true);
    expect(calls.matrices.some((m) => m.length === 9)).toBe(true);

    r.dispose();
  });
});
