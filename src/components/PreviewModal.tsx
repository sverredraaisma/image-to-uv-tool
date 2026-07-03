import { useMemo } from 'react';
import { useStore } from '../store/store';
import { rasterToDataUrl, browserPlatform } from '../lib/canvas';
import { downloadBlob, downloadText } from '../lib/download';

export function PreviewModal() {
  const preview = useStore((s) => s.preview);
  const close = useStore((s) => s.closePreview);

  const imageUrl = useMemo(() => {
    if (preview?.value.kind === 'image') {
      try {
        return rasterToDataUrl(preview.value);
      } catch {
        return null;
      }
    }
    return null;
  }, [preview]);

  if (!preview) return null;
  const { value, title } = preview;

  const download = async () => {
    if (value.kind === 'image') {
      const blob = await browserPlatform.encodePngBlob(value);
      downloadBlob(blob, 'output.png');
    } else if (value.kind === 'stl') {
      downloadText(value.text, 'model.stl', 'model/stl');
    } else if (value.kind === 'text') {
      downloadText(value.text, 'text.txt');
    }
  };

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{title}</span>
          <div className="modal-header-actions">
            <button type="button" className="btn btn-primary" onClick={download}>
              Download
            </button>
            <button type="button" className="icon-btn" onClick={close}>
              ✕
            </button>
          </div>
        </div>
        <div className="modal-body preview-body">
          {value.kind === 'image' && imageUrl && (
            <img src={imageUrl} alt={title} className="preview-full checker" />
          )}
          {value.kind === 'image' && (
            <div className="preview-meta">
              {value.width} × {value.height} px
            </div>
          )}
          {value.kind === 'text' && <pre className="preview-textfull">{value.text}</pre>}
          {value.kind === 'stl' && (
            <>
              <div className="preview-meta">{value.triangleCount} triangles (ASCII STL)</div>
              <pre className="preview-textfull">{value.text.slice(0, 4000)}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
