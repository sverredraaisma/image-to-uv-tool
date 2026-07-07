import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { rasterToDataUrl } from '../lib/canvas';
import { createGlossRenderer, type GlossRenderer } from '../lib/glossRender';
import { num } from '../nodes/helpers';
import type { RasterImage } from '../types';

const DEG = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Resolve the image wired into one of this node's input ports. */
function useInputImage(nodeId: string, handle: string): RasterImage | undefined {
  return useStore((s) => {
    const edge = s.edges.find((e) => e.target === nodeId && e.targetHandle === handle);
    const v = edge ? s.runtime[edge.source]?.outputs?.[edge.sourceHandle] : undefined;
    return v && v.kind === 'image' ? (v as RasterImage) : undefined;
  });
}

/**
 * Interactive 3D gloss preview: orbit the print to watch the varnish catch a
 * fixed light, or switch to "Move light" to reposition the highlight (persisted
 * to the node's azimuth/elevation). Falls back to the flat preview without WebGL.
 */
export function Gloss3DEditor({ nodeId }: { nodeId: string }) {
  const node = useStore((s) => s.nodes.find((n) => n.id === nodeId));
  const art = useInputImage(nodeId, 'art');
  const gloss = useInputImage(nodeId, 'gloss');
  const heightmap = useInputImage(nodeId, 'heightmap');
  const statsText = useStore((s) => {
    const v = s.runtime[nodeId]?.outputs?.stats;
    return v && v.kind === 'text' ? v.text : '';
  });
  const previewImg = useStore((s) => {
    const v = s.runtime[nodeId]?.outputs?.preview;
    return v && v.kind === 'image' ? (v as RasterImage) : undefined;
  });
  const updateNodeConfig = useStore((s) => s.updateNodeConfig);

  const cfg = node?.config ?? {};
  const shininess = num(cfg.shininess, 32);
  const intensity = num(cfg.intensity, 1);
  const matte = num(cfg.matte, 0);
  const relief = num(cfg.heightStrength, 2);
  const smooth = num(cfg.heightSmooth, 2);
  const azimuth = num(cfg.azimuth, 135);
  const elevation = num(cfg.elevation, 45);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<GlossRenderer | null>(null);
  const view = useRef({ rotX: -18 * DEG, rotY: -22 * DEG, zoom: 1 });
  const light = useRef({ azimuth, elevation });
  const drag = useRef<{ x: number; y: number; mode: 'view' | 'light' } | null>(null);
  const rafRef = useRef(0);
  const drawRef = useRef<() => void>(() => {});

  const [supported, setSupported] = useState(true);
  const [mode, setMode] = useState<'view' | 'light'>('view');
  const [autoRotate, setAutoRotate] = useState(false);

  // Keep the light ref synced with the config unless the user is mid light-drag.
  useEffect(() => {
    if (!drag.current || drag.current.mode !== 'light') light.current = { azimuth, elevation };
  }, [azimuth, elevation]);

  const draw = useCallback(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.render({
      rotX: view.current.rotX,
      rotY: view.current.rotY,
      zoom: view.current.zoom,
      azimuth: light.current.azimuth,
      elevation: light.current.elevation,
      shininess,
      intensity,
      matte,
      relief,
      smooth,
    });
  }, [shininess, intensity, matte, relief, smooth]);
  drawRef.current = draw;

  // Create / dispose the renderer once.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const r = createGlossRenderer(canvas);
    rendererRef.current = r;
    setSupported(!!r);
    return () => {
      r?.dispose();
      rendererRef.current = null;
    };
  }, []);

  // Size the drawing buffer to the container (DPR-aware).
  useEffect(() => {
    const wrap = wrapRef.current;
    const r = rendererRef.current;
    if (!wrap || !r) return;
    const apply = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = wrap.clientWidth || 480;
      const h = Math.max(240, Math.round(w * 0.62));
      r.resize(w * dpr, h * dpr);
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      drawRef.current();
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [supported]);

  // Upload textures whenever an input image changes.
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.setTextures({ art, gloss, heightmap });
    drawRef.current();
  }, [art, gloss, heightmap]);

  // Redraw on material / light changes.
  useEffect(() => {
    drawRef.current();
  }, [draw, azimuth, elevation]);

  // Non-passive wheel-to-zoom (so it doesn't scroll the modal).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !supported) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      view.current.zoom = clamp(view.current.zoom * (1 - e.deltaY * 0.0012), 0.4, 3);
      drawRef.current();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [supported]);

  // Auto-rotate loop.
  useEffect(() => {
    if (!autoRotate) return;
    const tick = () => {
      view.current.rotY += 0.006;
      drawRef.current();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [autoRotate]);

  const onPointerDown = (e: React.PointerEvent) => {
    try {
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    drag.current = { x: e.clientX, y: e.clientY, mode };
    setAutoRotate(false);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    if (d.mode === 'light') {
      light.current.azimuth = light.current.azimuth + dx * 0.6;
      light.current.elevation = clamp(light.current.elevation - dy * 0.4, 0, 90);
    } else {
      view.current.rotY += dx * 0.008;
      view.current.rotX = clamp(view.current.rotX + dy * 0.008, -1.4, 1.4);
    }
    drawRef.current();
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.mode === 'light') {
      updateNodeConfig(nodeId, {
        azimuth: Math.round(((light.current.azimuth % 360) + 360) % 360),
        elevation: Math.round(light.current.elevation),
      });
    }
    try {
      (e.target as Element).releasePointerCapture?.(e.pointerId);
    } catch {
      /* pointer may not be captured */
    }
  };
  const resetView = () => {
    view.current = { rotX: -18 * DEG, rotY: -22 * DEG, zoom: 1 };
    setAutoRotate(false);
    drawRef.current();
  };

  const fallbackSrc = useMemo(() => (previewImg ? rasterToDataUrl(previewImg) : null), [previewImg]);

  if (!node) return null;

  return (
    <div className="gloss3d">
      <div className="gloss3d-controls">
        <div className="seg" role="group" aria-label="Drag mode">
          <button type="button" className={mode === 'view' ? 'active' : ''} onClick={() => setMode('view')}>
            Rotate
          </button>
          <button type="button" className={mode === 'light' ? 'active' : ''} onClick={() => setMode('light')}>
            Move light
          </button>
        </div>
        <button type="button" className="btn" onClick={() => setAutoRotate((v) => !v)}>
          {autoRotate ? 'Stop spin' : 'Auto-rotate'}
        </button>
        <button type="button" className="btn" onClick={resetView}>
          Reset view
        </button>
        {statsText && <span className="gloss3d-stat">{statsText}</span>}
      </div>

      {supported ? (
        <div className="gloss3d-stage" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            className={`gloss3d-canvas ${mode === 'light' ? 'is-light' : ''}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          />
          {!art && (
            <div className="gloss3d-empty">Connect artwork to the “Art” input to preview the print.</div>
          )}
        </div>
      ) : (
        <div className="gloss3d-fallback">
          {fallbackSrc ? (
            <img src={fallbackSrc} alt="gloss preview" className="gloss3d-fallback-img" />
          ) : (
            <span>Connect artwork and a gloss mask to preview.</span>
          )}
          <div className="gloss3d-note">
            3D preview couldn’t start (WebGL unavailable) — showing the flat preview.
          </div>
        </div>
      )}

      <div className="gloss3d-hint">
        Drag to orbit the print and watch the varnish catch the light; scroll to zoom. Switch to{' '}
        <strong>Move light</strong> to reposition the highlight (saved to the node).
      </div>
    </div>
  );
}
