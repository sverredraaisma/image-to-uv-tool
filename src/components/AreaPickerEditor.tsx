import { useMemo } from 'react';
import { useStore } from '../store/store';
import { rasterToDataUrl } from '../lib/canvas';
import { num } from '../nodes/helpers';
import type { Point } from '../lib/magicWand';
import type { RasterImage } from '../types';

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

  if (!node) return null;
  const points = (Array.isArray(node.config.points) ? node.config.points : []) as Point[];
  const tolerance = num(node.config.tolerance, 32);

  const onImageClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!inputImage) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * inputImage.width);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * inputImage.height);
    updateNodeConfig(nodeId, { points: [...points, { x, y }] });
  };

  return (
    <div className="area-picker">
      <div className="area-controls">
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
        <button type="button" className="btn" onClick={() => updateNodeConfig(nodeId, { points: [] })}>
          Clear points ({points.length})
        </button>
        {points.length > 0 && (
          <button
            type="button"
            className="btn"
            onClick={() => updateNodeConfig(nodeId, { points: points.slice(0, -1) })}
          >
            Undo point
          </button>
        )}
      </div>

      {!src && <div className="area-empty">Connect an image to the input to pick areas.</div>}

      <div className="area-canvases">
        {src && (
          <div className="area-stage">
            <div className="area-label">Click to add points</div>
            <div className="area-img-wrap">
              <img src={src} alt="input" className="area-img checker" onClick={onImageClick} />
              {points.map((p, i) => (
                <span
                  key={i}
                  className="area-dot"
                  style={{
                    left: `${(p.x / (inputImage?.width ?? 1)) * 100}%`,
                    top: `${(p.y / (inputImage?.height ?? 1)) * 100}%`,
                  }}
                />
              ))}
            </div>
          </div>
        )}
        {maskSrc && (
          <div className="area-stage">
            <div className="area-label">Mask output</div>
            <img src={maskSrc} alt="mask" className="area-img" />
          </div>
        )}
      </div>
    </div>
  );
}
