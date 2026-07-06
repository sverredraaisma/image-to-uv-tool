import { useMemo, useState } from 'react';
import { useStore } from '../store/store';
import { rasterToDataUrl } from '../lib/canvas';
import { num } from '../nodes/helpers';
import { PanZoom } from './PanZoom';
import type { Point } from '../lib/magicWand';
import type { SelectionShape } from '../lib/selection';
import type { RasterImage } from '../types';

type Tool = 'wand' | 'rect' | 'ellipse' | 'pan';

interface Drag {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Editor for the Area Picker: magic-wand clicks + rectangle/ellipse drags,
 *  all unioned into one mask. */
export function AreaPickerEditor({ nodeId }: { nodeId: string }) {
  const node = useStore((s) => s.nodes.find((n) => n.id === nodeId));
  const inputImage = useStore((s) => {
    const edge = s.edges.find((e) => e.target === nodeId && e.targetHandle === 'in');
    const v = edge ? s.runtime[edge.source]?.outputs?.[edge.sourceHandle] : undefined;
    return v && v.kind === 'image' ? (v as RasterImage) : undefined;
  });
  const maskImage = useStore((s) => {
    const v = s.runtime[nodeId]?.outputs?.out;
    return v && v.kind === 'image' ? (v as RasterImage) : undefined;
  });
  const updateNodeConfig = useStore((s) => s.updateNodeConfig);

  const src = useMemo(() => (inputImage ? rasterToDataUrl(inputImage) : null), [inputImage]);
  const maskSrc = useMemo(() => (maskImage ? rasterToDataUrl(maskImage) : null), [maskImage]);

  const [tool, setTool] = useState<Tool>('wand');
  const [drag, setDrag] = useState<Drag | null>(null);

  if (!node) return null;
  const iw = inputImage?.width ?? 1;
  const ih = inputImage?.height ?? 1;
  const points = (Array.isArray(node.config.points) ? node.config.points : []) as Point[];
  const shapes = (Array.isArray(node.config.shapes) ? node.config.shapes : []) as SelectionShape[];
  const tolerance = num(node.config.tolerance, 32);

  // Map a pointer event to image-pixel coordinates (works at any zoom because
  // getBoundingClientRect returns the rendered, post-transform rect).
  const toImage = (e: { clientX: number; clientY: number }, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * iw;
    const y = ((e.clientY - rect.top) / rect.height) * ih;
    return { x: Math.max(0, Math.min(iw, x)), y: Math.max(0, Math.min(ih, y)) };
  };

  const onClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (tool !== 'wand' || !inputImage) return;
    const { x, y } = toImage(e, e.currentTarget);
    updateNodeConfig(nodeId, { points: [...points, { x: Math.round(x), y: Math.round(y) }] });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    // Only the shape tools draw; wand adds points on click, pan lets PanZoom pan.
    if ((tool !== 'rect' && tool !== 'ellipse') || !inputImage || e.button !== 0) return;
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
    // Ignore accidental micro-drags (a stray click with the shape tools).
    if (width < 2 || height < 2) return;
    const shape: SelectionShape = { type: tool === 'rect' ? 'rect' : 'ellipse', x, y, width, height };
    updateNodeConfig(nodeId, { shapes: [...shapes, shape] });
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

  return (
    <div className="area-picker">
      <div className="area-controls">
        <div className="area-tools" role="group" aria-label="Selection tool">
          {(['wand', 'rect', 'ellipse', 'pan'] as Tool[]).map((t) => (
            <button
              key={t}
              type="button"
              className={`btn ${tool === t ? 'btn-primary' : ''}`}
              aria-pressed={tool === t}
              onClick={() => setTool(t)}
              title={
                t === 'wand'
                  ? 'Magic wand — click to flood-fill an area'
                  : t === 'rect'
                    ? 'Rectangle — drag to select'
                    : t === 'ellipse'
                      ? 'Ellipse — drag to select'
                      : 'Pan — drag to move the image (scroll to zoom in any tool)'
              }
            >
              {t === 'wand' ? '✦ Wand' : t === 'rect' ? '▭ Rect' : t === 'ellipse' ? '◯ Ellipse' : '✋ Pan'}
            </button>
          ))}
        </div>
        <label className="field field-sm">
          <span>Tolerance: {tolerance}</span>
          <input
            type="range"
            min={0}
            max={255}
            value={tolerance}
            onChange={(e) => updateNodeConfig(nodeId, { tolerance: Number(e.target.value) })}
          />
        </label>
        {points.length > 0 && (
          <button
            type="button"
            className="btn"
            onClick={() => updateNodeConfig(nodeId, { points: points.slice(0, -1) })}
          >
            Undo point ({points.length})
          </button>
        )}
        {shapes.length > 0 && (
          <button
            type="button"
            className="btn"
            onClick={() => updateNodeConfig(nodeId, { shapes: shapes.slice(0, -1) })}
          >
            Undo shape ({shapes.length})
          </button>
        )}
        {(points.length > 0 || shapes.length > 0) && (
          <button
            type="button"
            className="btn"
            onClick={() => updateNodeConfig(nodeId, { points: [], shapes: [] })}
          >
            Clear all
          </button>
        )}
      </div>

      {!src && <div className="area-empty">Connect an image to the input to pick areas.</div>}

      <div className="area-canvases">
        {src && (
          <div className="area-stage">
            <div className="area-label">
              {tool === 'wand'
                ? 'Click to add points · scroll to zoom'
                : tool === 'pan'
                  ? 'Drag to pan · scroll to zoom'
                  : 'Drag to draw a shape · scroll to zoom'}
            </div>
            <PanZoom className="area-panzoom" dragToPan={tool === 'pan'} fitKey={src}>
              <div className="area-img-wrap">
                <img
                  src={src}
                  alt="input"
                  className={`area-img checker tool-${tool === 'rect' || tool === 'ellipse' ? 'shape' : tool}`}
                  onClick={onClick}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  draggable={false}
                />
                {shapes.map((s, i) => (
                  <span
                    key={i}
                    className={`area-shape area-shape-${s.type}`}
                    style={shapeStyle(s)}
                    aria-hidden="true"
                  />
                ))}
                {dragShape && dragShape.width > 0 && dragShape.height > 0 && (
                  <span
                    className={`area-shape area-shape-${tool === 'rect' ? 'rect' : 'ellipse'} area-shape-drag`}
                    style={shapeStyle(dragShape)}
                    aria-hidden="true"
                  />
                )}
                {points.map((p, i) => (
                  <span key={i} className="area-dot" style={{ left: pct(p.x, iw), top: pct(p.y, ih) }} />
                ))}
              </div>
            </PanZoom>
          </div>
        )}
        {maskSrc && (
          <div className="area-stage">
            <div className="area-label">Mask output</div>
            <PanZoom className="area-panzoom" fitKey={maskSrc}>
              <img src={maskSrc} alt="mask" />
            </PanZoom>
          </div>
        )}
      </div>
    </div>
  );
}
