import { useEffect, useState } from 'react';
import { useStore } from '../store/store';
import { browserPlatform } from '../lib/canvas';
import { downloadBlob, downloadText, previewFileName } from '../lib/download';
import { stlToAscii, stlToBinary, stlToObj } from '../lib/stl';
import { Modal } from './Modal';

export function PreviewModal() {
  const preview = useStore((s) => s.preview);
  const close = useStore((s) => s.closePreview);
  const addToast = useStore((s) => s.addToast);

  // Encode the preview image asynchronously to an object URL instead of a
  // synchronous full-res toDataURL in render — that blocks the frame and holds
  // ~1.33× the bytes as a base64 string. The URL is revoked on change/unmount.
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  useEffect(() => {
    if (preview?.value.kind !== 'image') {
      setImageUrl(null);
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    browserPlatform
      .encodePngBlob(preview.value)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setImageUrl(url);
      })
      .catch(() => {
        if (!cancelled) setImageUrl(null);
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
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

  const downloadObj = () => {
    if (value.kind !== 'stl') return;
    try {
      downloadText(stlToObj(value), previewFileName(title, 'obj'));
    } catch (e) {
      addToast('error', `Download failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  };

  return (
    <Modal
      title={title}
      onClose={close}
      className="preview-modal"
      bodyClassName="preview-body"
      headerActions={
        <>
          {value.kind === 'stl' && (
            <button type="button" className="btn" onClick={downloadObj}>
              OBJ
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={download}>
            {value.kind === 'stl' ? 'STL' : 'Download'}
          </button>
        </>
      }
    >
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
          <div className="preview-meta">{value.triangleCount} triangles — downloads as binary STL</div>
          <pre className="preview-textfull">{stlToAscii(value, 'heightmap', 40)}</pre>
        </>
      )}
    </Modal>
  );
}
