import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store/store';
import { platform } from '../lib/platform';
import { downloadBlob } from '../lib/download';
import { encodeGray16Png } from '../lib/png16';
import {
  calibrationValues,
  lensGeometry,
  outputSize,
  renderLenticular,
  type CalibrationParam,
  type CalibrationSpec,
  type LenticularRender,
} from '../lib/lenticular';
import { settingsFromConfig } from '../nodes/lenticular';
import { num } from '../nodes/helpers';
import type { RasterImage } from '../types';

const CALIBRATIONS: { param: CalibrationParam; label: string; minKey: string; maxKey: string }[] = [
  { param: 'height', label: 'Height', minKey: 'heightMin', maxKey: 'heightMax' },
  { param: 'ri', label: 'RI', minKey: 'riMin', maxKey: 'riMax' },
  { param: 'lpi', label: 'LPI', minKey: 'lpiMin', maxKey: 'lpiMax' },
];

/** Round for a filename: 0.85 → "0-85". */
const slug = (v: number) => String(Math.round(v * 1000) / 1000).replace('.', '-');

/**
 * Editor for the Lenticular Print node: the solved lens geometry, plus the
 * downloads that can't travel down a wire — the 16-bit gloss depth map (the
 * canvas is 8-bit, and 8 bits over a 0.9 mm stack terraces the lens) and the
 * Height / RI / LPI calibration sheets.
 */
export function LenticularEditor({ nodeId }: { nodeId: string }) {
  const node = useStore((s) => s.nodes.find((n) => n.id === nodeId));
  // Frames in connection order — the same order the node itself interlaces in.
  // Shallow-compared: the selector builds a fresh array on every store change.
  const frames = useStore(
    useShallow((s) => {
      const values = s.edges
        .filter((e) => e.target === nodeId && e.targetHandle === 'frames')
        .map((e) => s.runtime[e.source]?.outputs?.[e.sourceHandle]);
      return values.filter((v): v is RasterImage => !!v && v.kind === 'image');
    }),
  );
  const addToast = useStore((s) => s.addToast);
  const [busy, setBusy] = useState<string | null>(null);

  if (!node) return null;
  const settings = settingsFromConfig(node.config);
  const geometry = lensGeometry(settings);
  const size = frames[0] ? outputSize(settings, frames[0]) : null;
  const mm = (v: number) => `${v.toFixed(3)} mm`;

  const downloadDepth16 = (render: LenticularRender, name: string) => {
    const png = encodeGray16Png(render.width, render.height, render.depth);
    downloadBlob(new Blob([png as BlobPart], { type: 'image/png' }), name);
  };

  const run = async (job: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(job);
    try {
      // Yield once so the button's busy state paints before the render blocks.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await work();
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const downloadMain = () =>
    run('depth', async () => {
      const render = renderLenticular(frames, settings);
      downloadDepth16(render, `lenticular-depth16-${settings.lpi}lpi-${slug(settings.heightMm)}mm.png`);
    });

  const downloadCalibration = (calib: (typeof CALIBRATIONS)[number]) =>
    run(calib.param, async () => {
      const spec: CalibrationSpec = {
        param: calib.param,
        min: num(node.config[calib.minKey], 0),
        max: num(node.config[calib.maxKey], 0),
        bands: Math.max(2, Math.round(num(node.config.calibBands, 9))),
      };
      const values = calibrationValues(spec);
      // A blank gutter (~0.4 mm) keeps neighbouring bands from bleeding into
      // each other on press, so a band that flips cleanly is unambiguous.
      const bandGapPx = Math.round((settings.ppi / 25.4) * 0.4);
      const render = renderLenticular(frames, settings, { calibration: spec, bandGapPx });
      const stem = `lenticular-calib-${calib.param}-${slug(values[0])}-to-${slug(values[values.length - 1])}-${values.length}bands`;
      downloadBlob(await platform.encodePngBlob(render.interlaced), `${stem}-interlaced.png`);
      downloadDepth16(render, `${stem}-depth16.png`);
    });

  return (
    <div className="lenticular-editor">
      <h4>Solved lens</h4>
      <dl className="lenticular-geometry">
        <dt>Pitch</dt>
        <dd>
          {mm(geometry.pitchMm)} ({geometry.pitchPx.toFixed(2)} px
          {frames.length > 1 && <> · {(geometry.pitchPx / frames.length).toFixed(2)} px per frame</>})
        </dd>
        <dt>Lens sag</dt>
        <dd>{mm(geometry.sagMm)}</dd>
        <dt>Flat base under lens</dt>
        <dd>{mm(geometry.baseMm)}</dd>
        <dt>Radius of curvature</dt>
        <dd>{mm(geometry.radiusMm)}</dd>
        <dt>Focus below apex</dt>
        <dd>{mm(geometry.focusMm)}</dd>
        <dt>Viewing angle</dt>
        <dd>{geometry.viewAngleDeg.toFixed(1)}°</dd>
        <dt>Output</dt>
        <dd>{size ? `${size.width} × ${size.height} px` : '— connect frames'}</dd>
      </dl>

      {!geometry.feasible && (
        <p className="lenticular-warning">
          ⚠ At {settings.lpi} LPI and RI {settings.ri} no lens can focus in {mm(settings.heightMm)}. The
          strongest printable lens (a hemisphere) focuses {mm(geometry.focusMm)} down. Raise Height to at
          least {mm(geometry.minHeightMm)}, raise LPI, or use a higher-RI varnish.
        </p>
      )}

      {frames.length < 2 && (
        <p className="lenticular-warning">
          ⚠ Connect at least 2 images to the Frames input — they interlace in connection order.
        </p>
      )}

      <h4>Downloads</h4>
      <p className="lenticular-note">
        The 16-bit depth map is the printable gloss height field: 65535 = {mm(geometry.totalMm)}. The
        node&apos;s Gloss depth output is an 8-bit preview only.
      </p>
      <div className="lenticular-actions">
        <button type="button" className="btn" disabled={frames.length < 2 || !!busy} onClick={downloadMain}>
          {busy === 'depth' ? 'Rendering…' : '16-bit gloss depth map'}
        </button>
      </div>

      <h4>Calibration sheets</h4>
      <p className="lenticular-note">
        Each sheet sweeps one setting across {Math.max(2, Math.round(num(node.config.calibBands, 9)))} bands
        (min → max, set under Advanced) while every other setting stays as it is here. Print one, and read off
        the band that flips cleanest. Each button downloads the interlaced artwork plus its 16-bit depth map.
      </p>
      <div className="lenticular-actions">
        {CALIBRATIONS.map((calib) => {
          const values = calibrationValues({
            param: calib.param,
            min: num(node.config[calib.minKey], 0),
            max: num(node.config[calib.maxKey], 0),
            bands: Math.max(2, Math.round(num(node.config.calibBands, 9))),
          });
          return (
            <button
              key={calib.param}
              type="button"
              className="btn"
              disabled={frames.length < 2 || !!busy}
              title={values.map((v) => Math.round(v * 1000) / 1000).join(', ')}
              onClick={() => downloadCalibration(calib)}
            >
              {busy === calib.param
                ? 'Rendering…'
                : `${calib.label}: ${values[0]} → ${values[values.length - 1]}`}
            </button>
          );
        })}
      </div>
    </div>
  );
}
