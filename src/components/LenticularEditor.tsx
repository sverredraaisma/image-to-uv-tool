import { useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store/store';
import { platform } from '../lib/platform';
import { downloadBlob } from '../lib/download';
import { encodeGray16Png } from '../lib/png16';
import {
  calibrationValues,
  clampGrid,
  gridCellCounts,
  gridInterlacedSize,
  gridSwitchViews,
  gridTilesOffPixelGrid,
  interlacedSize,
  lensGeometry,
  outputSize,
  packingFill,
  radialInterlacedSize,
  radialSwitchViews,
  radialViews,
  renderDepthMap,
  renderGridDepthMap,
  renderGridInterlaced,
  renderInterlaced,
  renderRadialDepthMap,
  renderRadialInterlaced,
  stripsOffPixelGrid,
  switchFrames,
  clampRadialViews,
  type CalibrationParam,
  type CalibrationSpec,
  type DepthMapResult,
  type LenticularSettings,
  type OutputSize,
  type RenderOptions,
} from '../lib/lenticular';
import { lensGridCellInputs, radialViewInputs } from '../engine/ports';
import { settingsFromConfig } from '../nodes/lenticular';
import { gridSettingsFromConfig } from '../nodes/lensGrid';
import { radialSettingsFromConfig } from '../nodes/radialGrid';
import { bool, num } from '../nodes/helpers';
import type { NodeConfig, RasterImage } from '../types';

const CALIBRATIONS: { param: CalibrationParam; label: string; minKey: string; maxKey: string }[] = [
  { param: 'height', label: 'Height', minKey: 'heightMin', maxKey: 'heightMax' },
  { param: 'ri', label: 'RI', minKey: 'riMin', maxKey: 'riMax' },
  { param: 'lpi', label: 'LPI', minKey: 'lpiMin', maxKey: 'lpiMax' },
];

/** A blank gutter so neighbouring calibration bands can't bleed together. */
const BAND_GAP_MM = 0.4;

/** Round for a filename: 0.85 → "0-85". */
const slug = (v: number) => String(Math.round(v * 1000) / 1000).replace('.', '-');

/**
 * What the shared print editor needs to know about the node it is editing —
 * everything the 1D lenticular and the 2D grid do differently.
 */
interface PrintKind {
  /** Filename stem, e.g. `lenticular` or `lensgrid`. */
  slug: string;
  settings: LenticularSettings;
  /** Source images, in the order the renderer consumes them. */
  views: RasterImage[];
  /** All views present — false disables every download. */
  ready: boolean;
  /** Shown when `ready` is false. */
  missing: ReactNode;
  /** Extra rows for the geometry table. */
  rows?: ReactNode;
  /** Extra paragraph under the downloads note, on how the artwork is rastered. */
  artNote?: ReactNode;
  /** Physical gutter between calibration bands. */
  bandGapMm: number;
  artSize: OutputSize | null;
  renderArt(views: RasterImage[], options: RenderOptions): RasterImage;
  renderDepth(options: RenderOptions): DepthMapResult;
  /** Solid views that read as a hard flip, for the switch sheet. */
  switchViews(): RasterImage[];
}

/**
 * Shared editor body for both print nodes: the solved lens geometry, plus the
 * downloads that can't travel down a wire — the 16-bit gloss depth map (the
 * canvas is 8-bit, and 8 bits over a 0.9 mm stack terraces the lens) and the
 * Height / RI / LPI calibration sheets.
 */
function PrintEditor({ config, kind }: { config: NodeConfig; kind: PrintKind }) {
  const addToast = useStore((s) => s.addToast);
  const [busy, setBusy] = useState<string | null>(null);

  const { settings, views, ready } = kind;
  const geometry = lensGeometry(settings);
  const depthSize = views[0] ? outputSize(settings, views[0]) : null;
  const mm = (v: number) => `${v.toFixed(3)} mm`;

  const autoHeight = bool(config.lpiAutoHeight, true);
  const calibrationSpec = (calib: (typeof CALIBRATIONS)[number]): CalibrationSpec => ({
    param: calib.param,
    min: num(config[calib.minKey], 0),
    max: num(config[calib.maxKey], 0),
    bands: Math.max(2, Math.round(num(config.calibBands, 9))),
    autoHeight,
  });

  const downloadDepth16 = (map: DepthMapResult, name: string) => {
    const png = encodeGray16Png(map.width, map.height, map.depth);
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
      const map = kind.renderDepth({});
      downloadDepth16(map, `${kind.slug}-depth16-${settings.lpi}lpi-${slug(settings.heightMm)}mm.png`);
    });

  const downloadCalibration = (calib: (typeof CALIBRATIONS)[number]) =>
    run(calib.param, async () => {
      const spec = calibrationSpec(calib);
      const values = calibrationValues(spec);
      const options: RenderOptions = { calibration: spec, bandGapMm: kind.bandGapMm };
      const art = kind.renderArt(views, options);
      const stem = `${kind.slug}-calib-${calib.param}-${slug(values[0])}-to-${slug(values[values.length - 1])}-${values.length}bands`;
      downloadBlob(await platform.encodePngBlob(art), `${stem}-interlaced.png`);

      // The same sheet with the artwork replaced by a hard white→black switch:
      // where the print flips, with none of the art's own detail in the way.
      // Forced onto the artwork's raster so the two sheets overlay exactly.
      const switched = kind.renderArt(kind.switchViews(), {
        ...options,
        interlacedSize: { width: art.width, height: art.height },
      });
      downloadBlob(await platform.encodePngBlob(switched), `${stem}-switch.png`);

      // The depth scale rides in the filename: with auto height each LPI band
      // gets its own stack, so "what does white mean" changes per sheet.
      const map = kind.renderDepth(options);
      downloadDepth16(map, `${stem}-depth16-max${slug(map.scaleMm)}mm.png`);
    });

  return (
    <div className="lenticular-editor">
      <h4>Solved lens</h4>
      <dl className="lenticular-geometry">
        <dt>Pitch</dt>
        <dd>
          {mm(geometry.pitchMm)} ({geometry.pitchPx.toFixed(2)} px)
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
        <dt>Depth map</dt>
        <dd>{depthSize ? `${depthSize.width} × ${depthSize.height} px @ ${settings.ppi} PPI` : '—'}</dd>
        <dt>Artwork</dt>
        <dd>{kind.artSize ? `${kind.artSize.width} × ${kind.artSize.height} px` : '— connect the inputs'}</dd>
        {kind.rows}
      </dl>

      {!geometry.feasible && (
        <p className="lenticular-warning">
          ⚠ At {settings.lpi} LPI and RI {settings.ri} no lens can focus in {mm(settings.heightMm)}. The
          strongest printable lens (a hemisphere) focuses {mm(geometry.focusMm)} down. Raise Height to at
          least {mm(geometry.minHeightMm)}, raise LPI, or use a higher-RI varnish.
        </p>
      )}

      {!ready && <p className="lenticular-warning">⚠ {kind.missing}</p>}

      <h4>Downloads</h4>
      <p className="lenticular-note">
        The 16-bit depth map is the printable gloss height field: 65535 = {mm(geometry.totalMm)}. The
        node&apos;s Gloss depth output is an 8-bit preview only. It stays on the PPI raster because it{' '}
        <em>is</em> the lens; the interlaced artwork is flat ink, so it ships at the smallest size that keeps
        both the interlace and your source resolution — scale it to the sheet in the printing tool.
      </p>
      {kind.artNote}
      <div className="lenticular-actions">
        <button type="button" className="btn" disabled={!ready || !!busy} onClick={downloadMain}>
          {busy === 'depth' ? 'Rendering…' : '16-bit gloss depth map'}
        </button>
      </div>

      <h4>Calibration sheets</h4>
      <p className="lenticular-note">
        Each sheet sweeps one setting across {Math.max(2, Math.round(num(config.calibBands, 9)))} bands (min →
        max, set under Advanced) while every other setting stays as it is here. Print one, and read off the
        band that flips cleanest. Each button downloads three files: the interlaced artwork, a white→black{' '}
        <em>switch</em> sheet on the same raster (the flip with no artwork detail in the way), and the 16-bit
        depth map.
      </p>
      {autoHeight ? (
        <p className="lenticular-note">
          The LPI sweep gives each band its own gloss height so they all view the same{' '}
          {geometry.viewAngleDeg.toFixed(1)}° cone — finer-pitch bands need a shorter stack, so they come out
          darker in the depth map. Turn off <em>LPI calib.: auto height</em> under Advanced to hold the height
          fixed instead.
        </p>
      ) : (
        <p className="lenticular-note">
          The LPI sweep holds Height at {mm(settings.heightMm)} for every band, so coarse-pitch bands may not
          focus at all. Turn on <em>LPI calib.: auto height</em> under Advanced to match viewing angles
          instead.
        </p>
      )}
      <div className="lenticular-actions">
        {CALIBRATIONS.map((calib) => {
          const values = calibrationValues(calibrationSpec(calib));
          return (
            <button
              key={calib.param}
              type="button"
              className="btn"
              disabled={!ready || !!busy}
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

/** Resolved image on one input port of a node, if it has computed. */
function imageOn(
  edges: { target: string; targetHandle: string; source: string; sourceHandle: string }[],
  runtime: Record<string, { outputs?: Record<string, unknown> } | undefined>,
  nodeId: string,
  portId: string,
): RasterImage | undefined {
  const edge = edges.find((e) => e.target === nodeId && e.targetHandle === portId);
  const value = edge ? runtime[edge.source]?.outputs?.[edge.sourceHandle] : undefined;
  return value && (value as RasterImage).kind === 'image' ? (value as RasterImage) : undefined;
}

/** Editor for the Lenticular Print node. */
export function LenticularEditor({ nodeId }: { nodeId: string }) {
  const node = useStore((s) => s.nodes.find((n) => n.id === nodeId));
  // Frames in connection order — the same order the node itself interlaces in.
  // Shallow-compared: the selector builds a fresh array on every store change.
  const frames = useStore(
    useShallow((s) => {
      const values = s.edges
        .filter((e) => e.target === nodeId && e.targetHandle === 'frames')
        .map((e) => s.runtime[e.source]?.outputs?.[e.sourceHandle]);
      // A Sequence on one wire (a decoded GIF) contributes all of its frames,
      // in order — the same flattening the node itself does.
      return values.flatMap((v) =>
        v?.kind === 'sequence' ? v.frames : v?.kind === 'image' ? [v as RasterImage] : [],
      );
    }),
  );

  if (!node) return null;
  const settings = settingsFromConfig(node.config);
  const ready = frames.length >= 2;
  return (
    <PrintEditor
      config={node.config}
      kind={{
        slug: 'lenticular',
        settings,
        views: frames,
        ready,
        missing: 'Connect at least 2 images to the Frames input — they interlace in connection order.',
        artNote: stripsOffPixelGrid(settings) ? (
          <p className="lenticular-note">
            At {settings.orientationDeg}° the edges between frame strips are diagonals, which no coarse raster
            can place — a pixel straddling two frames takes whichever one its centre lands in, and the
            boundary steps a whole strip at a time. So this sheet ignores the minimal raster and goes out on
            the printer&apos;s own {settings.ppi} PPI raster, the same one as the depth map. Straighten the
            array to 0° or 90° and it drops back to the small one.
          </p>
        ) : null,
        bandGapMm: BAND_GAP_MM,
        artSize: ready ? interlacedSize(settings, frames) : null,
        renderArt: (v, options) => renderInterlaced(v, settings, options),
        renderDepth: (options) => renderDepthMap(frames, settings, options),
        switchViews: () => switchFrames(frames.length),
      }}
    />
  );
}

/** Editor for the Radial Lens Print node. */
export function RadialGridEditor({ nodeId }: { nodeId: string }) {
  const node = useStore((s) => s.nodes.find((n) => n.id === nodeId));
  const views = useStore(
    useShallow((s) => {
      const nd = s.nodes.find((n) => n.id === nodeId);
      if (!nd) return [];
      // A Sequence on `all` carries the whole ring; a bearing wired
      // individually overrides it. Same precedence as the node's own gather.
      const bundle = s.edges.find((e) => e.target === nodeId && e.targetHandle === 'all');
      const bundled = bundle ? s.runtime[bundle.source]?.outputs?.[bundle.sourceHandle] : undefined;
      const frames = bundled?.kind === 'sequence' ? bundled.frames : [];
      return radialViewInputs(nd.config).map(
        (port, i) => imageOn(s.edges, s.runtime, nodeId, port.id) ?? frames[i],
      );
    }),
  );

  if (!node) return null;
  const settings = radialSettingsFromConfig(node.config);
  const n = clampRadialViews(settings.views);
  const present = views.filter((v): v is RasterImage => !!v);
  const ready = present.length === n;
  const missingLabels = radialViewInputs(node.config)
    .filter((_, i) => !views[i])
    .map((p) => p.label);
  const cells = ready ? gridCellCounts({ ...settings, grid: 2, mirrorViews: true }, present[0]) : null;

  return (
    <PrintEditor
      config={node.config}
      kind={{
        slug: 'radial',
        settings,
        views: present,
        ready,
        missing: `Connect all ${n} views. Missing: ${missingLabels.join(', ')}.`,
        // One whole cell of gutter, as the grid uses: a band edge would
        // otherwise leave a row of half-printed lenslets.
        bandGapMm: Math.max(BAND_GAP_MM, 25.4 / Math.max(1, settings.lpi)),
        artSize: ready ? radialInterlacedSize(settings, present) : null,
        rows: (
          <>
            <dt>Views</dt>
            <dd>
              {n} around the circle, one every {(360 / n).toFixed(1)}°
            </dd>
            <dt>Bearings</dt>
            <dd>
              {radialViews(n)
                .map((v) => v.label)
                .join(' · ')}
            </dd>
            <dt>Wedge at the rim</dt>
            <dd>{((lensGeometry(settings).pitchPx * Math.PI) / n).toFixed(2)} px</dd>
            <dt>Per-view resolution</dt>
            <dd>{cells ? `${cells.width} × ${cells.height} px (one per lenslet)` : '—'}</dd>
          </>
        ),
        artNote: (
          <p className="lenticular-note">
            The wedge edges are radial lines, so no orientation makes them run along the pixels and they
            converge to a point at the centre of every lenslet. The artwork therefore always ships on the
            printer&apos;s own {settings.ppi} PPI raster — the finest the print can resolve, spent where the
            views separate. That convergence is the effect, not a defect: it is what makes all {n} views merge
            when you look at the sheet square on.
          </p>
        ),
        renderArt: (v, options) => renderRadialInterlaced(v, settings, options),
        renderDepth: (options) => renderRadialDepthMap(present, settings, options),
        switchViews: () => radialSwitchViews(n),
      }}
    />
  );
}

/** Editor for the Lens Grid Print node. */
export function LensGridEditor({ nodeId }: { nodeId: string }) {
  const node = useStore((s) => s.nodes.find((n) => n.id === nodeId));
  const views = useStore(
    useShallow((s) => {
      const nd = s.nodes.find((n) => n.id === nodeId);
      if (!nd) return [];
      // A Sequence wired to `views` carries the whole grid; a cell port wired
      // individually overrides it. Same precedence as the node's own gather.
      const bundle = s.edges.find((e) => e.target === nodeId && e.targetHandle === 'views');
      const bundled = bundle ? s.runtime[bundle.source]?.outputs?.[bundle.sourceHandle] : undefined;
      const frames = bundled?.kind === 'sequence' ? bundled.frames : [];
      return lensGridCellInputs(nd.config).map(
        (port, i) => imageOn(s.edges, s.runtime, nodeId, port.id) ?? frames[i],
      );
    }),
  );

  if (!node) return null;
  const settings = gridSettingsFromConfig(node.config);
  const grid = clampGrid(settings.grid);
  const present = views.filter((v): v is RasterImage => !!v);
  const ready = present.length === grid * grid;
  const missingLabels = lensGridCellInputs(node.config)
    .filter((_, i) => !views[i])
    .map((p) => p.label);
  const cells = ready ? gridCellCounts(settings, present[0]) : null;
  const offGrid = gridTilesOffPixelGrid(settings);

  return (
    <PrintEditor
      config={node.config}
      kind={{
        slug: 'lensgrid',
        settings,
        views: present,
        ready,
        missing: `Connect all ${grid * grid} views of the ${grid}×${grid} grid. Missing: ${missingLabels.join(', ')}.`,
        // One whole cell of gutter: with lenslets in both axes a band edge
        // would otherwise leave a row of half-printed lenses.
        bandGapMm: Math.max(BAND_GAP_MM, 25.4 / Math.max(1, settings.lpi)),
        artSize: ready ? gridInterlacedSize(settings, present) : null,
        rows: (
          <>
            <dt>Grid</dt>
            <dd>
              {grid} × {grid} = {grid * grid} views
            </dd>
            <dt>Packing</dt>
            <dd>
              {settings.packing === 'hex' ? 'Hexagonal (offset rows)' : 'Square (rows and columns)'} —{' '}
              {(packingFill(settings.packing) * 100).toFixed(1)}% under a cap
            </dd>
            <dt>Per-view resolution</dt>
            <dd>{cells ? `${cells.width} × ${cells.height} px (one per lenslet)` : '—'}</dd>
          </>
        ),
        artNote: offGrid ? (
          <p className="lenticular-note">
            {settings.packing === 'hex' ? 'Staggered rows' : `A ${settings.orientationDeg}° array`} put the
            edges between view tiles on diagonals, which no coarse raster can place — a pixel straddling two
            views takes whichever one its centre lands in, and the boundary steps a whole tile at a time. So
            this sheet ignores the minimal raster and goes out on the printer&apos;s own {settings.ppi} PPI
            raster, the same one as the depth map: the finest the print can resolve, spent where it shows.
          </p>
        ) : (
          <p className="lenticular-note">
            A square array on the axes tiles the artwork in whole pixels, so the minimal raster places every
            tile edge exactly and a bigger one would buy nothing. Hex packing (or turning the array off the
            axes) puts those edges on diagonals and moves the artwork onto the full {settings.ppi} PPI raster.
          </p>
        ),
        renderArt: (v, options) => renderGridInterlaced(v, settings, options),
        renderDepth: (options) => renderGridDepthMap(present, settings, options),
        switchViews: () => gridSwitchViews(grid),
      }}
    />
  );
}
