import { useStore } from '../store/store';
import { MAX_OUTPUT_PIXELS } from '../lib/lenticular';
import { Modal } from './Modal';

const mp = (pixels: number) => (pixels / 1e6).toFixed(pixels < 1e8 ? 1 : 0);

/**
 * The "this is a big one" prompt. A raster over {@link MAX_OUTPUT_PIXELS} used
 * to be refused outright; now the user is told what it would cost and gets to
 * decide. Saying yes runs the same render in chunks, with a progress bar on the
 * node and Cancel ✕ still working between chunks.
 */
export function OversizeModal() {
  const request = useStore((s) => s.oversize);
  const confirm = useStore((s) => s.confirmOversize);
  const dismiss = useStore((s) => s.dismissOversize);
  if (!request) return null;

  const { label, what, width, height, chunks, fix } = request;
  const pixels = width * height;

  return (
    <Modal title={`${label}: that is a big render`} onClose={dismiss}>
      <p>
        The <strong>{what.toLowerCase()}</strong> would be{' '}
        <strong>
          {width.toLocaleString()} × {height.toLocaleString()} px
        </strong>{' '}
        — {mp(pixels)} megapixels, against the {MAX_OUTPUT_PIXELS / 1e6} MP this renders without asking.
      </p>
      <p>
        It can be done: the work splits into <strong>{chunks} chunks</strong> of a few million pixels each,
        and the node shows how far along it is. Expect it to take a while, and expect the finished raster to
        sit in memory — {mp(pixels)} MP is about {Math.round((pixels * 4) / 1e9) || '<1'} GB of image data.
        You can cancel between chunks.
      </p>
      <p className="lenticular-note">If you would rather it were smaller: {fix.toLowerCase()}.</p>
      <div className="oversize-actions">
        <button type="button" className="btn" onClick={dismiss}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={confirm}>
          Render in {chunks} chunks
        </button>
      </div>
    </Modal>
  );
}
