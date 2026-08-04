// Flying a camera through a splat scene.
//
// The preview is not a preview. It is the middle view of the run the print node
// will render — same projection, same code path, same sheet — thinned to a
// splat budget so it can be drawn while you are moving. So the canvas *is* the
// sheet: what you frame is what comes out, and there is no separate "render"
// framing to reconcile it with afterwards.
//
// This module is loaded on demand (see `SettingsModal`), which is also what
// keeps `lib/splat/render` out of the main bundle. Importing it here statically
// is fine and deliberate: this file is already behind a dynamic import, so the
// rasteriser lands in a chunk with it rather than in the entry.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { cameraAxes, framingCamera } from '../lib/splat/cloud';
import { renderSplatPreview } from '../lib/splat/render';
import { num } from '../nodes/helpers';
import type { SplatValue, TransformValue } from '../types';

/** Keys we consume, so the modal never sees them as scrolling or typing. */
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight']);

/** Idle for this long and the preview redraws with every splat it has. */
const SETTLE_MS = 350;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The splat cloud wired into this node's input, if it has run. */
function useInputCloud(nodeId: string): SplatValue | undefined {
  return useStore((s) => {
    const edge = s.edges.find((e) => e.target === nodeId && e.targetHandle === 'splat');
    const v = edge ? s.runtime[edge.source]?.outputs?.[edge.sourceHandle] : undefined;
    return v && v.kind === 'splat' ? v : undefined;
  });
}

export function SplatCameraEditor({ nodeId }: { nodeId: string }) {
  const node = useStore((s) => s.nodes.find((n) => n.id === nodeId));
  const cloud = useInputCloud(nodeId);
  const updateNodeConfig = useStore((s) => s.updateNodeConfig);

  const cfg = useMemo(() => node?.config ?? {}, [node?.config]);
  const widthMm = Math.max(1, num(cfg.widthMm, 100));
  const heightMm = Math.max(1, num(cfg.sheetHeightMm, 75));
  const viewDistanceMm = Math.max(10, num(cfg.viewDistanceMm, 400));
  const previewPx = Math.round(clamp(num(cfg.previewPx, 480), 96, 960));
  const previewSplats = Math.round(clamp(num(cfg.previewSplats, 150000), 5000, 400000));
  const moveSpeed = Math.max(0.01, num(cfg.moveSpeed, 0.5));

  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The live camera. A ref, not state: it changes every animation frame while
  // a key is down, and React has no business re-rendering for that.
  const cam = useRef<TransformValue>({
    kind: 'transform',
    position: [num(cfg.posX, 0), num(cfg.posY, 0), num(cfg.posZ, 0)],
    rotationDeg: [num(cfg.pitch, 0), num(cfg.yaw, 0), num(cfg.roll, 0)],
    scale: Math.max(1e-9, num(cfg.scale, 0)),
  });
  const held = useRef(new Set<string>());
  const rafRef = useRef(0);
  const lastT = useRef(0);
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [locked, setLocked] = useState(false);
  const [ready, setReady] = useState(false);
  const [busyMs, setBusyMs] = useState(0);

  /** Draw one frame at the given splat budget. */
  const draw = useCallback(
    (budget: number | undefined) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx || !cloud) return;
      const t0 = performance.now();
      const img = renderSplatPreview(cloud, cam.current, {
        widthPx: previewPx,
        widthMm,
        heightMm,
        viewDistanceMm,
        splatBudget: budget,
        nearClipMm: Math.max(0.1, num(cfg.nearClipMm, 5)),
      });
      if (canvas.width !== img.width || canvas.height !== img.height) {
        canvas.width = img.width;
        canvas.height = img.height;
      }
      // Copied, like `lib/canvas.ts` does: ImageData insists on owning a plain
      // ArrayBuffer, which the renderer's output is not guaranteed to be.
      ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
      setBusyMs(Math.round(performance.now() - t0));
      setReady(true);
    },
    [cloud, previewPx, widthMm, heightMm, viewDistanceMm, cfg.nearClipMm],
  );

  /** Redraw soon at preview quality, then again at full quality once idle. */
  const invalidate = useCallback(
    (budget: number | undefined = previewSplats) => {
      draw(budget);
      if (settleRef.current) clearTimeout(settleRef.current);
      settleRef.current = setTimeout(() => draw(undefined), SETTLE_MS);
    },
    [draw, previewSplats],
  );

  /** Persist where we ended up. Called when movement stops, not during it. */
  const persist = useCallback(() => {
    const c = cam.current;
    updateNodeConfig(nodeId, {
      posX: c.position[0],
      posY: c.position[1],
      posZ: c.position[2],
      pitch: c.rotationDeg[0],
      yaw: c.rotationDeg[1],
      roll: c.rotationDeg[2],
      scale: c.scale,
    });
  }, [nodeId, updateNodeConfig]);

  // First sight of a cloud on a camera that has never been placed: frame the
  // whole thing, so the editor opens on the scene rather than on blank paper.
  useEffect(() => {
    if (!cloud) return;
    if (cam.current.scale <= 1e-9) {
      cam.current = framingCamera(cloud, widthMm, viewDistanceMm);
      persist();
    }
    invalidate(previewSplats);
    // Only when the cloud itself arrives or changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloud]);

  // The fly loop. It only runs while something is held down; an idle editor
  // costs nothing.
  useEffect(() => {
    if (!locked) return;
    const tick = (t: number) => {
      const dt = Math.min(0.1, (t - (lastT.current || t)) / 1000);
      lastT.current = t;
      const keys = held.current;
      if (keys.size) {
        const { right, up, forward } = cameraAxes(cam.current.rotationDeg);
        // Speed is in scene units per second, so flying feels the same in a
        // capture scaled to metres as in one scaled to arbitrary units — the
        // scene's own size is what the number is relative to.
        const step = moveSpeed * dt;
        const move = (v: [number, number, number], k: number) => {
          cam.current.position[0] += v[0] * k;
          cam.current.position[1] += v[1] * k;
          cam.current.position[2] += v[2] * k;
        };
        if (keys.has('KeyW')) move(forward, step);
        if (keys.has('KeyS')) move(forward, -step);
        if (keys.has('KeyD')) move(right, step);
        if (keys.has('KeyA')) move(right, -step);
        if (keys.has('Space')) move(up, step);
        if (keys.has('ShiftLeft') || keys.has('ShiftRight')) move(up, -step);
        draw(previewSplats);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafRef.current);
      lastT.current = 0;
    };
  }, [locked, moveSpeed, draw, previewSplats]);

  // Keyboard, while the pointer is locked to the canvas.
  useEffect(() => {
    if (!locked) return;
    const keys = held.current;
    const down = (e: KeyboardEvent) => {
      if (!MOVE_KEYS.has(e.code)) return;
      e.preventDefault(); // Space would scroll the modal
      keys.add(e.code);
    };
    const up = (e: KeyboardEvent) => {
      if (!keys.delete(e.code)) return;
      e.preventDefault();
      if (keys.size === 0) {
        persist();
        invalidate(previewSplats);
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      keys.clear();
    };
  }, [locked, persist, invalidate, previewSplats]);

  // Mouse look, under pointer lock so it never runs out of screen.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onLockChange = () => {
      const now = document.pointerLockElement === canvas;
      setLocked(now);
      if (!now) {
        held.current.clear();
        persist();
        invalidate(previewSplats);
      }
    };
    const onMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== canvas) return;
      const r = cam.current.rotationDeg;
      r[1] = ((((r[1] - e.movementX * 0.12) % 360) + 540) % 360) - 180;
      // Pitch stops just short of straight up or down: at exactly ±90° yaw and
      // roll become the same rotation and the horizon spins.
      r[0] = clamp(r[0] - e.movementY * 0.12, -89.9, 89.9);
      if (!held.current.size) draw(previewSplats);
    };
    document.addEventListener('pointerlockchange', onLockChange);
    document.addEventListener('mousemove', onMove);
    return () => {
      document.removeEventListener('pointerlockchange', onLockChange);
      document.removeEventListener('mousemove', onMove);
    };
  }, [draw, persist, invalidate, previewSplats]);

  // Scroll changes how much of the scene the sheet spans — the one control that
  // is about the print rather than about where you are standing.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cam.current.scale = clamp(cam.current.scale * (1 + e.deltaY * 0.0015), 1e-6, 1e6);
      persist();
      invalidate(previewSplats);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [persist, invalidate, previewSplats]);

  useEffect(() => () => void (settleRef.current && clearTimeout(settleRef.current)), []);

  if (!node) return null;

  const c = cam.current;
  const n = (v: number) => (Math.round(v * 100) / 100).toString();

  return (
    <div className="splatcam">
      <div className="splatcam-controls">
        <button
          type="button"
          className="btn"
          onClick={() => canvasRef.current?.requestPointerLock?.()}
          disabled={!cloud}
        >
          {locked ? 'Flying — Esc to stop' : 'Click to fly'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!cloud}
          onClick={() => {
            if (!cloud) return;
            cam.current = framingCamera(cloud, widthMm, viewDistanceMm);
            persist();
            invalidate(previewSplats);
          }}
        >
          Frame the scene
        </button>
        {ready && <span className="splatcam-stat">{busyMs} ms/frame</span>}
      </div>

      <div className="splatcam-stage" style={{ aspectRatio: `${widthMm} / ${heightMm}` }}>
        <canvas
          ref={canvasRef}
          className={`splatcam-canvas ${locked ? 'is-flying' : ''}`}
          onClick={() => canvasRef.current?.requestPointerLock?.()}
        />
        {!cloud && (
          <div className="splatcam-empty">
            Connect a Gaussian Splat Input and run it — the cloud has to exist before you can stand in it.
          </div>
        )}
      </div>

      <div className="splatcam-readout">
        <span>
          Position {n(c.position[0])}, {n(c.position[1])}, {n(c.position[2])}
        </span>
        <span>
          Yaw {n(c.rotationDeg[1])}° · Pitch {n(c.rotationDeg[0])}°
        </span>
        <span>
          Scale {c.scale.toPrecision(3)} units/mm — sheet spans {n(c.scale * widthMm)} units
        </span>
      </div>

      <div className="splatcam-hint">
        Click the picture to take the mouse, then <strong>W A S D</strong> to move, <strong>Space</strong>{' '}
        and <strong>Shift</strong> for up and down, and the mouse to look. <strong>Esc</strong> gives the
        mouse back. Scroll to change how much of the scene the sheet spans. The canvas is the sheet: this is
        the head-on view of the print, not a separate preview.
      </div>
    </div>
  );
}

export default SplatCameraEditor;
