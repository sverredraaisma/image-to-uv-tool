import { useMemo, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { rasterToDataUrl } from '../lib/canvas';
import { applyCurve, curveLut, downscaleToMax, type CurveChannel, type CurvePoint } from '../lib/image';
import type { RasterImage } from '../types';

const clamp = (v: number) => Math.max(0, Math.min(255, v));

export function CurvesEditor({ nodeId }: { nodeId: string }) {
  const node = useStore((s) => s.nodes.find((n) => n.id === nodeId));
  const inputImage = useStore((s) => {
    const edge = s.edges.find((e) => e.target === nodeId && e.targetHandle === 'in');
    const v = edge ? s.runtime[edge.source]?.outputs?.[edge.sourceHandle] : undefined;
    return v && v.kind === 'image' ? (v as RasterImage) : undefined;
  });
  const updateNodeConfig = useStore((s) => s.updateNodeConfig);
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);

  const points = useMemo(
    () =>
      ((Array.isArray(node?.config.points) ? node?.config.points : []) as CurvePoint[])
        .slice()
        .sort((a, b) => a.x - b.x),
    [node?.config.points],
  );
  const channel = (node?.config.channel as CurveChannel) ?? 'rgb';
  const lut = useMemo(() => curveLut(points), [points]);

  // Live, downscaled preview so dragging stays smooth on large images.
  const previewSrc = useMemo(() => {
    if (!inputImage) return null;
    try {
      return rasterToDataUrl(applyCurve(downscaleToMax(inputImage, 220), lut, channel));
    } catch {
      return null;
    }
  }, [inputImage, lut, channel]);

  if (!node) return null;

  const toValue = (clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: clamp(Math.round(((clientX - rect.left) / rect.width) * 255)),
      y: clamp(Math.round(255 - ((clientY - rect.top) / rect.height) * 255)),
    };
  };
  const setPoints = (pts: CurvePoint[]) => updateNodeConfig(nodeId, { points: pts });

  const addPoint = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = toValue(e.clientX, e.clientY);
    setPoints([...points, p].sort((a, b) => a.x - b.x));
  };
  const movePoint = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag === null) return;
    const p = toValue(e.clientX, e.clientY);
    const isEnd = drag === 0 || drag === points.length - 1;
    const x = drag === 0 ? 0 : drag === points.length - 1 ? 255 : clamp(p.x);
    setPoints(points.map((pt, i) => (i === drag ? { x: isEnd ? pt.x : x, y: p.y } : pt)));
  };
  const removePoint = (i: number) => {
    if (points.length <= 2 || i === 0 || i === points.length - 1) return; // keep endpoints
    setPoints(points.filter((_, idx) => idx !== i));
  };

  const curvePath = Array.from({ length: 256 }, (_, i) => `${i},${255 - lut[i]}`).join(' ');

  return (
    <div className="curves-editor">
      <div className="curves-controls">
        <button
          type="button"
          className="btn"
          onClick={() =>
            setPoints([
              { x: 0, y: 0 },
              { x: 255, y: 255 },
            ])
          }
        >
          Reset
        </button>
        <span className="model-schema-note">Click to add, drag to move, double-click to remove.</span>
      </div>
      <div className="curves-stage">
        <svg
          ref={svgRef}
          viewBox="0 0 255 255"
          className="curves-svg"
          onPointerDown={addPoint}
          onPointerMove={movePoint}
          onPointerUp={() => setDrag(null)}
          onPointerLeave={() => setDrag(null)}
        >
          {[0.25, 0.5, 0.75].map((f) => (
            <g key={f}>
              <line x1={f * 255} y1={0} x2={f * 255} y2={255} className="curves-grid" />
              <line x1={0} y1={f * 255} x2={255} y2={f * 255} className="curves-grid" />
            </g>
          ))}
          <line x1={0} y1={255} x2={255} y2={0} className="curves-diagonal" />
          <polyline points={curvePath} className="curves-line" fill="none" />
          {points.map((p, i) => (
            <circle
              key={i}
              cx={p.x}
              cy={255 - p.y}
              r={5}
              className="curves-point"
              onPointerDown={(e) => {
                e.stopPropagation();
                setDrag(i);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                removePoint(i);
              }}
            />
          ))}
        </svg>
        {previewSrc ? (
          <img src={previewSrc} alt="curve preview" className="curves-preview checker" />
        ) : (
          <div className="area-empty">Connect an image to preview the curve.</div>
        )}
      </div>
    </div>
  );
}
