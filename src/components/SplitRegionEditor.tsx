import { useMemo, useState } from 'react';
import { useStore } from '../store/store';
import { rasterToDataUrl } from '../lib/canvas';
import { num } from '../nodes/helpers';
import { PanZoom } from './PanZoom';
import type { RasterImage } from '../types';

type Tool = 'select' | 'pan';

interface Drag {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Editor for the Split Region node: drag a rectangle on the image to set the
 *  crop x/y/width/height (same click-and-drag feel as the Area Picker). */
export function SplitRegionEditor({ nodeId }: { nodeId: string }) {
  const node = useStore((s) => s.nodes.find((n) => n.id === nodeId));
  const inputImage = useStore((s) => {
    const edge = s.edges.find((e) => e.target === nodeId && e.targetHandle === 'in');
    const v = edge ? s.runtime[edge.source]?.outputs?.[edge.sourceHandle] : undefined;
    return v && v.kind === 'image' ? (v as RasterImage) : undefined;
  });
  const outImage = useStore((s) => {
    const v = s.runtime[nodeId]?.outputs?.out;
    return v && v.kind === 'image' ? (v as RasterImage) : undefined;
  });
  const updateNodeConfig = useStore((s) => s.updateNodeConfig);

  const src = useMemo(() => (inputImage ? rasterToDataUrl(inputImage) : null), [inputImage]);
  const outSrc = useMemo(() => (outImage ? rasterToDataUrl(outImage) : null), [outImage]);

  const [tool, setTool] = useState<Tool>('select');
  const [drag, setDrag] = useState<Drag | null>(null);

  if (!node) return null;
  const iw = inputImage?.width ?? 1;
  const ih = inputImage?.height ?? 1;
  const rect = {
    x: num(node.config.x, 0),
    y: num(node.config.y, 0),
    width: num(node.config.width, 0),
    height: num(node.config.height, 0),
  };

  // Map a pointer event to image-pixel coordinates (works at any zoom because
  // getBoundingClientRect returns the rendered, post-transform rect).
  const toImage = (e: { clientX: number; clientY: number }, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * iw;
    const y = ((e.clientY - r.top) / r.height) * ih;
    return { x: Math.max(0, Math.min(iw, x)), y: Math.max(0, Math.min(ih, y)) };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (tool !== 'select' || !inputImage || e.button !== 0) return; // pan → PanZoom handles it
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = toImage(e, e.currentTarget);
    setDrag({ x0: x, y0: y, x1: x, y1: y });
  };
  const onPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!drag) return;
    const { x, y } = toImage(e, e.currentTarget);
    setDrag((d) => (d ? { ...d, x1: x, y1: y } : d));
  };
  const onPointerUp = () => {
    if (!drag) return;
    const x = Math.round(Math.min(drag.x0, drag.x1));
    const y = Math.round(Math.min(drag.y0, drag.y1));
    const width = Math.round(Math.abs(drag.x1 - drag.x0));
    const height = Math.round(Math.abs(drag.y1 - drag.y0));
    setDrag(null);
    if (width < 2 || height < 2) return; // ignore an accidental click
    updateNodeConfig(nodeId, { x, y, width, height });
  };

  const pct = (v: number, total: number) => `${(v / total) * 100}%`;
  const shapeStyle = (s: { x: number; y: number; width: number; height: number }) => ({
    left: pct(s.x, iw),
    top: pct(s.y, ih),
    width: pct(s.width, iw),
    height: pct(s.height, ih),
  });
  const dragShape = drag
    ? {
        x: Math.min(drag.x0, drag.x1),
        y: Math.min(drag.y0, drag.y1),
        width: Math.abs(drag.x1 - drag.x0),
        height: Math.abs(drag.y1 - drag.y0),
      }
    : null;
  // Show the live drag, or the committed region from config.
  const shown = dragShape ?? (rect.width > 0 && rect.height > 0 ? rect : null);

  return (
    <div className="area-picker">
      <div className="area-controls">
        <div className="area-tools" role="group" aria-label="Tool">
          {(['select', 'pan'] as Tool[]).map((t) => (
            <button
              key={t}
              type="button"
              className={`btn ${tool === t ? 'btn-primary' : ''}`}
              aria-pressed={tool === t}
              onClick={() => setTool(t)}
              title={
                t === 'select'
                  ? 'Select — drag a rectangle to crop'
                  : 'Pan — drag to move the image (scroll to zoom in any tool)'
              }
            >
              {t === 'select' ? '▭ Select' : '✋ Pan'}
            </button>
          ))}
        </div>
        {rect.width > 0 && rect.height > 0 && (
          <span className="area-label">
            Region: {rect.x}, {rect.y} · {rect.width}×{rect.height}px
          </span>
        )}
        <button
          type="button"
          className="btn"
          onClick={() => updateNodeConfig(nodeId, { x: 0, y: 0, width: 0, height: 0 })}
        >
          Clear
        </button>
      </div>

      {!src && <div className="area-empty">Connect an image to the input to select a region.</div>}

      <div className="area-canvases">
        {src && (
          <div className="area-stage">
            <div className="area-label">
              {tool === 'select'
                ? 'Drag to select a region · scroll to zoom'
                : 'Drag to pan · scroll to zoom'}
            </div>
            <PanZoom className="area-panzoom" dragToPan={tool === 'pan'} fitKey={src}>
              <div className="area-img-wrap">
                <img
                  src={src}
                  alt="input"
                  className={`area-img checker tool-${tool === 'select' ? 'shape' : 'pan'}`}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  draggable={false}
                />
                {shown && shown.width > 0 && shown.height > 0 && (
                  <span
                    className={`area-shape area-shape-rect ${drag ? 'area-shape-drag' : ''}`}
                    style={shapeStyle(shown)}
                    aria-hidden="true"
                  />
                )}
              </div>
            </PanZoom>
          </div>
        )}
        {outSrc && (
          <div className="area-stage">
            <div className="area-label">Cropped output</div>
            <PanZoom className="area-panzoom" fitKey={outSrc}>
              <img src={outSrc} alt="cropped" />
            </PanZoom>
          </div>
        )}
      </div>
    </div>
  );
}
