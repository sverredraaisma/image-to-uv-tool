import { useCallback, useEffect, useRef, useState } from 'react';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

interface Transform {
  scale: number;
  x: number;
  y: number;
}

interface PanZoomProps {
  children: React.ReactNode;
  className?: string;
  /** Left-drag pans the content (default true). When false, left-drag passes
   *  through to the children (e.g. the Area Picker's draw tools) — pan with the
   *  middle mouse button or the on-screen controls instead. */
  dragToPan?: boolean;
  minScale?: number;
  maxScale?: number;
  /** When this value changes, the view refits (e.g. a new image). */
  fitKey?: unknown;
}

/**
 * Reusable pan + zoom viewport. Wheel zooms toward the cursor, drag pans, and
 * an overlay gives zoom-in/out/fit buttons. Auto-fits its content until the
 * user interacts, then leaves the view alone (except an explicit fit / a new
 * fitKey). Kept generic so both the preview modal and node editors can use it.
 */
export function PanZoom({
  children,
  className,
  dragToPan = true,
  minScale = 0.1,
  maxScale = 16,
  fitKey,
}: PanZoomProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ sx: number; sy: number; tx: number; ty: number } | null>(null);
  const interacted = useRef(false);
  const [t, setT] = useState<Transform>({ scale: 1, x: 0, y: 0 });
  const [panning, setPanning] = useState(false);

  // Centre the content in the viewport at a scale that fits (never upscales).
  const fit = useCallback(() => {
    const c = containerRef.current;
    const el = contentRef.current;
    if (!c || !el) return;
    const cw = c.clientWidth;
    const ch = c.clientHeight;
    const nw = el.offsetWidth;
    const nh = el.offsetHeight;
    if (!nw || !nh || !cw || !ch) return;
    const scale = Math.min(cw / nw, ch / nh, 1);
    setT({ scale, x: (cw - nw * scale) / 2, y: (ch - nh * scale) / 2 });
  }, []);

  // Refit on a new fitKey (allow auto-fit to resume for the new content).
  useEffect(() => {
    interacted.current = false;
    const raf = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(raf);
  }, [fit, fitKey]);

  // Auto-fit while the container/content resizes (e.g. an image finishes
  // loading), but only until the user has taken over the view.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (!interacted.current) fit();
    });
    if (containerRef.current) ro.observe(containerRef.current);
    if (contentRef.current) ro.observe(contentRef.current);
    return () => ro.disconnect();
  }, [fit]);

  // Non-passive wheel listener so we can preventDefault the page scroll.
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      interacted.current = true;
      const rect = c.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setT((prev) => {
        const scale = clamp(prev.scale * factor, minScale, maxScale);
        const k = scale / prev.scale;
        return { scale, x: cx - (cx - prev.x) * k, y: cy - (cy - prev.y) * k };
      });
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, [minScale, maxScale]);

  const zoomBy = (factor: number) => {
    const c = containerRef.current;
    const cx = (c?.clientWidth ?? 0) / 2;
    const cy = (c?.clientHeight ?? 0) / 2;
    interacted.current = true;
    setT((prev) => {
      const scale = clamp(prev.scale * factor, minScale, maxScale);
      const k = scale / prev.scale;
      return { scale, x: cx - (cx - prev.x) * k, y: cy - (cy - prev.y) * k };
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const wantPan = e.button === 1 || (dragToPan && e.button === 0);
    if (!wantPan) return;
    e.preventDefault();
    interacted.current = true;
    containerRef.current?.setPointerCapture(e.pointerId);
    panRef.current = { sx: e.clientX, sy: e.clientY, tx: t.x, ty: t.y };
    setPanning(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = panRef.current;
    if (!p) return;
    const dx = e.clientX - p.sx;
    const dy = e.clientY - p.sy;
    setT((prev) => ({ ...prev, x: p.tx + dx, y: p.ty + dy }));
  };
  const endPan = (e: React.PointerEvent) => {
    if (!panRef.current) return;
    panRef.current = null;
    setPanning(false);
    try {
      containerRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  return (
    <div
      ref={containerRef}
      className={`panzoom ${dragToPan ? 'panzoom-draggable' : ''} ${panning ? 'panzoom-panning' : ''} ${
        className ?? ''
      }`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onDoubleClick={dragToPan ? () => fit() : undefined}
    >
      <div
        ref={contentRef}
        className="panzoom-content"
        style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`, transformOrigin: '0 0' }}
      >
        {children}
      </div>
      <div className="panzoom-controls nodrag">
        <button type="button" className="icon-btn" title="Zoom in" onClick={() => zoomBy(1.3)}>
          ＋
        </button>
        <button type="button" className="icon-btn" title="Zoom out" onClick={() => zoomBy(1 / 1.3)}>
          －
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Fit to view"
          onClick={() => {
            interacted.current = false;
            fit();
          }}
        >
          ⤢
        </button>
        <span className="panzoom-scale">{Math.round(t.scale * 100)}%</span>
      </div>
    </div>
  );
}
