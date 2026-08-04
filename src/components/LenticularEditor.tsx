import { useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store/store';
import { platform } from '../lib/platform';
import { downloadBlob } from '../lib/download';
import { runChunked } from '../lib/chunked';
import { encodeGray16Png } from '../lib/png16';
import {
  calibrationPixelsPerLens,
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
  radialDepthMapChunks,
  radialInterlaceChunks,
  depthMapChunks,
  gridDepthMapChunks,
  gridInterlaceChunks,
  interlaceChunks,
  OversizeOutputError,
  stripsOffPixelGrid,
  switchFrames,
  clampRadialViews,
  lpiForPixelsPerLens,
  pplFit,
  snapPixelsPerLens,
  type PplParity,
  type CalibrationParam,
  type ChunkProgress,
  type CalibrationSpec,
  type DepthMapResult,
  type LenticularSettings,
  type OutputSize,
  type RenderOptions,
} from '../lib/lenticular';
import { lensGridCellSlots, radialViewInputs, summariseMissing } from '../engine/ports';
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
  /** The node this editor belongs to — oversize consent is held per node. */
  nodeId: string;
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
  // Chunked, like the node's own run: a calibration sheet is the same size as
  // the print and takes just as long, so it gets the same progress and the
  // same "this is a big one" question rather than freezing the editor.
  renderArt(views: RasterImage[], options: RenderOptions): Generator<ChunkProgress, RasterImage>;
  renderDepth(options: RenderOptions): Generator<ChunkProgress, DepthMapResult>;
  /** Solid views that read as a hard flip, for the switch sheet. */
  switchViews(): RasterImage[];
}

/**
 * Choose the pitch as pixels per lens rather than as lines per inch.
 *
 * LPI is what a lens sheet is sold by, so it is what the node stores — this
 * writes straight back to it and keeps no state of its own, which is why the
 * two controls can never disagree. But PPI / LPI is what you want to *pick*,
 * because it is the only number that decides whether every lens on the sheet
 * comes out the same: see the note in `lib/lenticular.ts`.
 */
function PitchControl({
  nodeId,
  settings,
  views,
}: {
  nodeId: string;
  settings: LenticularSettings;
  views: number;
}) {
  const updateNodeConfig = useStore((s) => s.updateNodeConfig);
  const fit = pplFit(settings, views);
  const setPpl = (ppl: number) =>
    updateNodeConfig(nodeId, { lpi: lpiForPixelsPerLens(settings.ppi, ppl) });

  const snapTo = (parity: PplParity) => snapPixelsPerLens(fit.ppl, parity);
  const round3 = (v: number) => Math.round(v * 1000) / 1000;

  return (
    <div className="pitch-control">
      <label className="pitch-field">
        <span>Pixels per lens</span>
        <input
          type="number"
          min={2}
          step={1}
          value={round3(fit.ppl)}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v) && v > 0) setPpl(v);
          }}
        />
      </label>
      <span className="pitch-derived">
        = {round3(settings.lpi)} LPI at {settings.ppi} PPI
      </span>
      <span className="seg" role="group" aria-label="Snap pixels per lens">
        {(['any', 'even', 'odd'] as PplParity[]).map((parity) => (
          <button
            key={parity}
            type="button"
            className={fit.whole && (parity === 'any' || fit.parity === parity) ? 'active' : ''}
            title={`Snap to ${snapTo(parity)} px per lens`}
            onClick={() => setPpl(snapTo(parity))}
          >
            {parity === 'any' ? `Whole (${snapTo('any')})` : `${parity === 'even' ? 'Even' : 'Odd'} (${snapTo(parity)})`}
          </button>
        ))}
      </span>

      {fit.whole ? (
        <p className="lenticular-note">
          {Math.round(fit.ppl)} px per lens, {fit.parity} — every one of the {Math.round(fit.lensCount)}{' '}
          lenses on this sheet covers the same pixel columns, so they print identically and the interlace
          never drifts.{' '}
          {fit.parity === 'even'
            ? 'The lens axis falls on a pixel boundary, which splits the strips evenly either side of it — what an even number of views wants.'
            : 'One pixel sits centred on the lens axis, which is the head-on view — what an odd number of views wants.'}
          {views > 0 &&
            (fit.pxPerView
              ? ` At ${views} views that is exactly ${fit.pxPerView} px per view.`
              : ` ${views} views do not divide ${Math.round(fit.ppl)} px, so the strips under one lens are not all the same width — pick a pitch that is a multiple of ${views}.`)}
        </p>
      ) : (
        <p className="lenticular-warning">
          ⚠ {round3(fit.ppl)} px per lens is not a whole number, so no two lenses on the sheet are alike:
          the strip pattern slides {fit.driftPx.toFixed(1)} px from one edge of the print to the other, which
          reads as slow banding. Snap it above.
        </p>
      )}
    </div>
  );
}

/**
 * The pitches a snapped LPI sweep actually lands on, in printed pixels per lens.
 *
 * Worth printing on screen rather than leaving in a tooltip, because it is the
 * list you work from once the sheet is in your hand: you pick the band that
 * flips cleanest, count along to its position, and this says what to set the
 * print to. The LPI it corresponds to is rarely a number anyone would choose —
 * 28 px at 1440 PPI is 51.43 LPI — which is exactly why the pixel figure is
 * the one to carry around.
 */
function SnappedPitches({ spec, asked }: { spec: CalibrationSpec; asked: number }) {
  const ppls = calibrationPixelsPerLens(spec);
  if (!ppls.length) return null;
  const whole = ppls.map((v) => Math.round(v));
  const wanted = Math.max(2, Math.round(asked));
  return (
    <p className="lenticular-note">
      The LPI sweep is snapped to whole pixels per lens, so every band is a pitch the raster can actually
      repeat. Bands, left to right:{' '}
      <strong className="calib-pitches">{whole.join(' · ')}</strong> px per lens
      {whole.length < wanted && (
        <>
          {' '}
          — {wanted - whole.length} of the {wanted} bands asked for collapsed onto pitches already in the
          sweep, because there are only {whole.length} whole ones between those LPI values. Widen the range
          for more.
        </>
      )}
      . Turn off <em>LPI calib.: snap to whole pixels</em> under Advanced to sweep raw LPI instead.
    </p>
  );
}

/**
 * Shared editor body for both print nodes: the solved lens geometry, plus the
 * downloads that can't travel down a wire — the 16-bit gloss depth map (the
 * canvas is 8-bit, and 8 bits over a 0.9 mm stack terraces the lens) and the
 * Height / RI / LPI calibration sheets.
 */
function PrintEditor({ config, kind }: { config: NodeConfig; kind: PrintKind }) {
  const addToast = useStore((s) => s.addToast);
  const requestOversize = useStore((s) => s.requestOversize);
  const oversizeAllowed = useStore((s) => s.oversizeAllowed);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const { settings, views, ready } = kind;
  const geometry = lensGeometry(settings);
  const depthSize = views[0] ? outputSize(settings, views[0]) : null;
  const mm = (v: number) => `${v.toFixed(3)} mm`;

  const autoHeight = bool(config.lpiAutoHeight, true);
  const snapPpl = bool(config.lpiSnapPpl, true);
  const calibrationSpec = (calib: (typeof CALIBRATIONS)[number]): CalibrationSpec => ({
    param: calib.param,
    min: num(config[calib.minKey], 0),
    max: num(config[calib.maxKey], 0),
    bands: Math.max(2, Math.round(num(config.calibBands, 9))),
    autoHeight,
    snapPpl,
    ppi: settings.ppi,
  });

  const downloadDepth16 = (map: DepthMapResult, name: string) => {
    const png = encodeGray16Png(map.width, map.height, map.depth);
    downloadBlob(new Blob([png as BlobPart], { type: 'image/png' }), name);
  };

  /** Render options with whatever the user has already agreed to. */
  const withConsent = (options: RenderOptions): RenderOptions => ({
    ...options,
    allowOversize: oversizeAllowed(kind.nodeId),
  });

  /** Run one chunked render, reporting its chunks under the busy button. */
  const drive = <T,>(gen: Generator<ChunkProgress, T>): Promise<T> =>
    runChunked(gen, { onProgress: (message) => setProgress(message) });

  /**
   * A download job. An oversize raster stops the job and puts the question to
   * the user instead of failing it — saying yes runs the very same job again,
   * this time with consent in hand.
   */
  const run = (job: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(job);
    void (async () => {
      try {
        // Yield once so the button's busy state paints before work starts.
        await new Promise((resolve) => setTimeout(resolve, 0));
        await work();
      } catch (err) {
        if (err instanceof OversizeOutputError) {
          requestOversize({
            nodeId: kind.nodeId,
            label: 'This sheet',
            what: err.what,
            width: err.width,
            height: err.height,
            chunks: err.chunks,
            fix: err.fix,
            retry: () => run(job, work),
          });
        } else {
          addToast('error', err instanceof Error ? err.message : String(err));
        }
      } finally {
        setBusy(null);
        setProgress(null);
      }
    })();
  };

  const downloadMain = () =>
    run('depth', async () => {
      const map = await drive(kind.renderDepth(withConsent({})));
      downloadDepth16(map, `${kind.slug}-depth16-${settings.lpi}lpi-${slug(settings.heightMm)}mm.png`);
    });

  const downloadCalibration = (calib: (typeof CALIBRATIONS)[number]) =>
    run(calib.param, async () => {
      const spec = calibrationSpec(calib);
      const values = calibrationValues(spec);
      const options = withConsent({ calibration: spec, bandGapMm: kind.bandGapMm });
      const art = await drive(kind.renderArt(views, options));
      // A snapped LPI sweep names itself in pixels per lens, because that is
      // what you read off the sheet and type back in — and because the LPI
      // values it lands on are things like 51.428.
      const ppls = calibrationPixelsPerLens(spec);
      const stem =
        calib.param === 'lpi' && snapPpl && ppls.length
          ? `${kind.slug}-calib-lpi-${slug(ppls[0])}-to-${slug(ppls[ppls.length - 1])}px-${values.length}bands`
          : `${kind.slug}-calib-${calib.param}-${slug(values[0])}-to-${slug(values[values.length - 1])}-${values.length}bands`;
      downloadBlob(await platform.encodePngBlob(art), `${stem}-interlaced.png`);

      // The same sheet with the artwork replaced by alternating black and white
      // views: the fastest switch the view count allows, so a band that is
      // holding its views apart stays black and white and one that is not goes
      // grey. None of the art's own detail is in the way.
      // Forced onto the artwork's raster so the two sheets overlay exactly.
      const switched = await drive(
        kind.renderArt(kind.switchViews(), {
          ...options,
          interlacedSize: { width: art.width, height: art.height },
        }),
      );
      downloadBlob(await platform.encodePngBlob(switched), `${stem}-switch.png`);

      // The depth scale rides in the filename: with auto height each LPI band
      // gets its own stack, so "what does white mean" changes per sheet.
      const map = await drive(kind.renderDepth(options));
      downloadDepth16(map, `${stem}-depth16-max${slug(map.scaleMm)}mm.png`);
    });

  return (
    <div className="lenticular-editor">
      <h4>Solved lens</h4>
      <dl className="lenticular-geometry">
        <dt>Pitch</dt>
        <dd>
          {mm(geometry.pitchMm)} ({geometry.pitchPx.toFixed(2)} px per lens)
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

      <PitchControl nodeId={kind.nodeId} settings={settings} views={views.length} />

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
          {busy === 'depth' ? (progress ?? 'Rendering…') : '16-bit gloss depth map'}
        </button>
      </div>

      <h4>Calibration sheets</h4>
      <p className="lenticular-note">
        Each sheet sweeps one setting across {Math.max(2, Math.round(num(config.calibBands, 9)))} bands (min →
        max, set under Advanced) while every other setting stays as it is here. Print one, and read off the
        band that flips cleanest. Each button downloads three files: the interlaced artwork, a{' '}
        <em>switch</em> sheet on the same raster, and the 16-bit depth map.
      </p>
      <p className="lenticular-note">
        The switch sheet is the one to judge by. Its views alternate pure black and pure white, so every
        adjacent pair is the fastest flip the view count allows — and any two views the lens fails to keep
        apart average into a grey that was never printed. So the band you want is simply the one that stays
        black and white as you tilt it; the ones that have given up are visibly, unmistakably grey. There is
        no gradient to interpret, which is the point: a lens that has failed produces a gradient all by
        itself.
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
          const round3 = (v: number) => Math.round(v * 1000) / 1000;
          return (
            <button
              key={calib.param}
              type="button"
              className="btn"
              disabled={!ready || !!busy}
              title={values.map(round3).join(', ')}
              onClick={() => downloadCalibration(calib)}
            >
              {busy === calib.param
                ? 'Rendering…'
                : `${calib.label}: ${round3(values[0])} → ${round3(values[values.length - 1])}`}
            </button>
          );
        })}
      </div>
      {snapPpl && <SnappedPitches spec={calibrationSpec(CALIBRATIONS[2])} asked={num(config.calibBands, 9)} />}
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
        nodeId,
        settings,
        views: frames,
        ready,
        missing: 'Connect at least 2 images to the Frames input — they interlace in connection order.',
        artNote: stripsOffPixelGrid(settings) ? (
          <p className="lenticular-note">
            At {settings.orientationDeg}° the edges between frame strips are diagonals, which no raster places
            exactly — a pixel straddling two frames takes whichever one its centre lands in, so the boundary
            steps. How coarse those steps are is the size of this artwork: a quarter of a strip at two
            samples, a fraction of a printed dot at the {settings.ppi} PPI cap. Raise{' '}
            <em>Artwork px per strip</em> under Advanced to spend towards that cap, or straighten the array to
            0° or 90° and the question goes away.
          </p>
        ) : null,
        bandGapMm: BAND_GAP_MM,
        artSize: ready ? interlacedSize(settings, frames) : null,
        renderArt: (v, options) => interlaceChunks(v, settings, options),
        renderDepth: (options) => depthMapChunks(frames, settings, options),
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
        nodeId,
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
            The wedge edges are radial lines, so no orientation makes them run along the pixels: every pixel
            of artwork up to the {settings.ppi} PPI cap buys a straighter seam. The size above is what the
            wedges themselves need — two pixels across a wedge at the <em>rim</em>, where a wedge is widest —
            so raise <em>Artwork px per wedge</em> under Advanced to spend towards that cap if the seams look
            stepped. The wedges also converge to a point at the centre of every lenslet, and no raster can
            hold that: it is the effect rather than a defect, and it is what makes all {n} views merge when
            you look at the sheet square on.
          </p>
        ),
        renderArt: (v, options) => radialInterlaceChunks(v, settings, options),
        renderDepth: (options) => radialDepthMapChunks(present, settings, options),
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
      return lensGridCellSlots(nd.config).map(
        (port, i) => imageOn(s.edges, s.runtime, nodeId, port.id) ?? frames[i],
      );
    }),
  );

  if (!node) return null;
  const settings = gridSettingsFromConfig(node.config);
  const grid = clampGrid(settings.grid);
  const present = views.filter((v): v is RasterImage => !!v);
  const ready = present.length === grid * grid;
  const missingLabels = lensGridCellSlots(node.config)
    .filter((_, i) => !views[i])
    .map((p) => p.label);
  const cells = ready ? gridCellCounts(settings, present[0]) : null;
  const offGrid = gridTilesOffPixelGrid(settings);

  return (
    <PrintEditor
      config={node.config}
      kind={{
        slug: 'lensgrid',
        nodeId,
        settings,
        views: present,
        ready,
        missing: `Connect all ${grid * grid} views of the ${grid}×${grid} grid. Missing: ${summariseMissing(missingLabels)}.`,
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
            edges between view tiles on diagonals, which no raster places exactly — a pixel straddling two
            views takes whichever one its centre lands in, so the boundary steps. How coarse those steps are
            is the size of this artwork, and the ceiling is the printer&apos;s own {settings.ppi} PPI raster,
            where they come out at one printed dot. Raise <em>Artwork px per view tile</em> under Advanced to
            spend towards it.
          </p>
        ) : (
          <p className="lenticular-note">
            A square array on the axes tiles the artwork in whole pixels, so this raster places every tile
            edge exactly and a bigger one would buy nothing. Hex packing (or turning the array off the axes)
            puts those edges on diagonals, where more pixels — up to the {settings.ppi} PPI cap — do buy
            something.
          </p>
        ),
        renderArt: (v, options) => gridInterlaceChunks(v, settings, options),
        renderDepth: (options) => gridDepthMapChunks(present, settings, options),
        switchViews: () => gridSwitchViews(grid),
      }}
    />
  );
}
