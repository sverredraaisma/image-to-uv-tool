import { useMemo } from 'react';
import { useStore } from '../store/store';
import { rasterToDataUrl, browserPlatform } from '../lib/canvas';
import { downloadBlob, downloadText, previewFileName } from '../lib/download';
import { stlToAscii, stlToBinary } from '../lib/stl';

export function PreviewModal() {
  const preview = useStore((s) => s.preview);
  const close = useStore((s) => s.closePreview);
  const addToast = useStore((s) => s.addToast);

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
    try {
      if (value.kind === 'image') {
        const blob = await browserPlatform.encodePngBlob(value);
        downloadBlob(blob, previewFileName(title, 'png'));
      } else if (value.kind === 'stl') {
        downloadBlob(new Blob([stlToBinary(value)], { type: 'model/stl' }), previewFileName(title, 'stl'));
      } else if (value.kind === 'text') {
        downloadText(value.text, previewFileName(title, 'txt'));
      }
    } catch (e) {
      addToast('error', `Download failed: ${e instanceof Error ? e.message : 'unknown error'}`);
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
              <div className="preview-meta">
                {value.triangleCount} triangles — downloads as binary STL
              </div>
              <pre className="preview-textfull">{stlToAscii(value, 'heightmap', 40)}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
