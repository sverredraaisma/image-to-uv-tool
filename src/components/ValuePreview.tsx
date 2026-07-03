import { useMemo } from 'react';
import type { DataValue } from '../types';
import { rasterToThumbnail } from '../lib/canvas';

/** A small clickable preview of a port value (image thumbnail / text / stl). */
export function ValuePreview({
  value,
  onClick,
  size = 46,
}: {
  value: DataValue | undefined;
  onClick?: () => void;
  size?: number;
}) {
  const thumb = useMemo(() => {
    if (value?.kind === 'image') {
      try {
        return rasterToThumbnail(value, size * 2);
      } catch {
        return null;
      }
    }
    return null;
  }, [value, size]);

  const style = { width: size, height: size };

  let inner;
  if (!value) {
    inner = <span className="preview-empty">–</span>;
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
      disabled={!value}
      title={value ? 'Click to enlarge' : 'No value yet'}
    >
      {inner}
    </button>
  );
}
