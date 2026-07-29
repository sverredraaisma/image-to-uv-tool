import { useEffect, useState } from 'react';
import { useStore } from '../store/store';
import { browserPlatform } from '../lib/canvas';
import { downloadBlob, downloadText, previewFileName } from '../lib/download';
import { stlToAscii, stlToBinary, stlToObj } from '../lib/stl';
import { stlToThreeMf } from '../lib/threeMf';
import { Modal } from './Modal';
import { PanZoom } from './PanZoom';

export function PreviewModal() {
  const preview = useStore((s) => s.preview);
  const close = useStore((s) => s.closePreview);
  const addToast = useStore((s) => s.addToast);

  // A sequence previews as one frame at a time, played back at its own timing.
  const sequence = preview?.value?.kind === 'sequence' ? preview.value : null;
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(true);

  // Reset playback whenever a different value is previewed.
  useEffect(() => {
    setFrameIndex(0);
    setPlaying(true);
  }, [preview?.value]);

  useEffect(() => {
    if (!sequence || !playing || sequence.frames.length < 2) return;
    const delay = Math.max(20, sequence.delaysMs?.[frameIndex] ?? 100);
    const timer = setTimeout(() => setFrameIndex((i) => (i + 1) % sequence.frames.length), delay);
    return () => clearTimeout(timer);
  }, [sequence, playing, frameIndex]);

  // The single raster actually on screen: the value itself, or the current frame.
  const shown = sequence
    ? sequence.frames[Math.min(frameIndex, sequence.frames.length - 1)]
    : preview?.value?.kind === 'image'
      ? preview.value
      : null;

  // Encode the preview image asynchronously to an object URL instead of a
  // synchronous full-res toDataURL in render — that blocks the frame and holds
  // ~1.33× the bytes as a base64 string. The URL is revoked on change/unmount.
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!shown) {
      setImageUrl(null);
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    browserPlatform
      .encodePngBlob(shown)
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
  }, [shown]);

  if (!preview) return null;
  const { value, title, loading, error } = preview;

  const download = async () => {
    if (!value) return;
    try {
      if (shown) {
        // A sequence downloads the frame on screen — that is what the slider is
        // pointing at, and PNG has nowhere to put the other frames.
        const blob = await browserPlatform.encodePngBlob(shown);
        downloadBlob(blob, previewFileName(sequence ? `${title}-frame-${frameIndex + 1}` : title, 'png'));
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
    if (value?.kind !== 'stl') return;
    try {
      downloadText(stlToObj(value), previewFileName(title, 'obj'));
    } catch (e) {
      addToast('error', `Download failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    }
  };

  const download3mf = () => {
    if (value?.kind !== 'stl') return;
    try {
      const bytes = stlToThreeMf(value);
      downloadBlob(new Blob([bytes], { type: 'model/3mf' }), previewFileName(title, '3mf'));
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
        value ? (
          <>
            {value.kind === 'stl' && (
              <>
                <button type="button" className="btn" onClick={download3mf}>
                  3MF
                </button>
                <button type="button" className="btn" onClick={downloadObj}>
                  OBJ
                </button>
              </>
            )}
            <button type="button" className="btn btn-primary" onClick={download}>
              {value.kind === 'stl' ? 'STL' : 'Download'}
            </button>
          </>
        ) : null
      }
    >
      {loading && (
        <div className="preview-loading">
          <span className="preview-spinner" aria-hidden="true" />
          <span>Rendering full resolution…</span>
        </div>
      )}
      {error && <div className="preview-loading preview-error">{error}</div>}
      {shown && imageUrl && (
        // fitKey is the frame count, not the URL: re-fitting on every frame
        // would fight the user's zoom during playback.
        <PanZoom className="preview-panzoom" fitKey={sequence ? `seq-${sequence.frames.length}` : imageUrl}>
          <img src={imageUrl} alt={title} className="checker" />
        </PanZoom>
      )}
      {sequence && (
        <div className="preview-controls nodrag">
          <button type="button" className="btn" onClick={() => setPlaying((p) => !p)}>
            {playing ? '❙❙ Pause' : '▶ Play'}
          </button>
          <input
            type="range"
            min={0}
            max={sequence.frames.length - 1}
            step={1}
            value={Math.min(frameIndex, sequence.frames.length - 1)}
            onChange={(e) => {
              setPlaying(false);
              setFrameIndex(Number(e.target.value));
            }}
          />
          <span className="preview-meta">
            frame {Math.min(frameIndex, sequence.frames.length - 1) + 1} / {sequence.frames.length}
          </span>
        </div>
      )}
      {shown && (
        <div className="preview-meta">
          {shown.width} × {shown.height} px · scroll to zoom, drag to pan
        </div>
      )}
      {value?.kind === 'text' && <pre className="preview-textfull">{value.text}</pre>}
      {value?.kind === 'stl' && (
        <>
          <div className="preview-meta">{value.triangleCount} triangles — downloads as binary STL</div>
          <pre className="preview-textfull">{stlToAscii(value, 'heightmap', 40)}</pre>
        </>
      )}
    </Modal>
  );
}
