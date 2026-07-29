import { useMemo } from 'react';
import type { DataValue } from '../types';
import { rasterToThumbnail } from '../lib/canvas';

/** A small clickable preview of a port value (image thumbnail / text / stl). */
export function ValuePreview({
  value,
  onClick,
  size = 46,
  renderable = false,
}: {
  value: DataValue | undefined;
  onClick?: () => void;
  size?: number;
  /** Allow clicking even without a cached value (to render it on demand). */
  renderable?: boolean;
}) {
  // A sequence previews as its first frame with a frame-count badge.
  const frame = value?.kind === 'sequence' ? value.frames[0] : value?.kind === 'image' ? value : null;

  const thumb = useMemo(() => {
    if (frame) {
      try {
        return rasterToThumbnail(frame, size * 2);
      } catch {
        return null;
      }
    }
    return null;
  }, [frame, size]);

  const style = { width: size, height: size };

  let inner;
  if (!value) {
    inner = <span className="preview-empty">–</span>;
  } else if (value.kind === 'sequence') {
    inner = (
      <>
        {thumb ? (
          <img src={thumb} alt="preview" className="preview-img" />
        ) : (
          <span className="preview-empty">▦</span>
        )}
        <span className="preview-badge">×{value.frames.length}</span>
      </>
    );
  } else if (value.kind === 'image' && thumb) {
    inner = <img src={thumb} alt="preview" className="preview-img" />;
  } else if (value.kind === 'text') {
    inner = <span className="preview-text">{value.text.slice(0, 24) || '""'}</span>;
  } else if (value.kind === 'stl') {
    inner = <span className="preview-text">STL · {value.triangleCount}△</span>;
  } else {
    inner = <span className="preview-empty">?</span>;
  }

  return (
    <button
      type="button"
      className="value-preview"
      style={style}
      onClick={onClick}
      disabled={!value && !renderable}
      title={value ? 'Click to enlarge' : renderable ? 'Click to render preview' : 'No value yet'}
    >
      {inner}
    </button>
  );
}
