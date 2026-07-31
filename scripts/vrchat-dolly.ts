// Build a VRChat camera dolly path that films a world into the views a
// lenticular print needs.
//
//   npm run dolly -- --views 16 --distance 4 --heading 180 --out sweep.json
//
// The path is one continuous sweep across the lens's viewing cone, with a path
// point per view and no holds anywhere: you record it once and pull the frames
// out of the video afterwards, which `npm run frames` will do for you using the
// plan this writes alongside the path.
//
// The optics come from src/lib — the same cone the print solves and the same
// tan-spaced eye positions the mesh renderer uses — so a sweep and a print made
// from the same LPI/height/RI agree without anybody reconciling two copies of
// the arithmetic. See `npm run dolly -- --help`.

import { writeFileSync, readFileSync } from 'node:fs';
import {
  MAX_HAZE_LENSLETS,
  MAX_STEP_LENSLETS,
  blurLenslets,
  dollyFile,
  dollyPoints,
  maxViewsForLens,
  reportFor,
  viewsForDepth,
  type DollyOptions,
  type PrintTarget,
} from '../src/lib/vrchatDolly.ts';

const HELP = `
Camera dolly sweeps for lenticular capture in VRChat.

  npm run dolly -- [options]

One sweep, recorded in a single take. Lenticular prints only: a 2D lens grid
needs a raster of sweeps, which is not something a camera on rails can fly.

The print these shots are for — the lens sets how wide the sweep goes
  --views N          frames the print will interlace                (default 16)
  --lpi N            lenticules per inch                            (default 45)
  --height MM        gloss stack height                             (default 0.9)
  --ri N             refractive index of the cured varnish          (default 1.5)
  --cone DEG         state the cone outright instead of solving it
  --print-width MM   printed sheet width                            (default 100)
  --ppi N            printer resolution, which caps the view count (default 1440)
  --samples N        artwork pixels per frame strip                  (default 2)

The shot
  --distance M       metres from the camera plane to the subject     (default 4)
  --anchor X,Y,Z     the point that prints sharp                   (default 0,1,0)
  --heading DEG      which way the cameras face, Unity yaw           (default 0)
  --pitch DEG        camera pitch, + looks down                      (default 0)
  --fov DEG          the camera's horizontal field of view           (default 60)
                     — set it to what the camera is really on: it decides how
                     much sheet a metre of subject movement covers, and a wider
                     frame is the forgiving one
  --floor Y          warn about points below this height             (default 0)

The recording
  --duration S       how long the whole sweep takes                 (default 20)
  --fps N            frame rate you will record at                   (default 60)
  --zoom N           VRChat camera zoom, passed through              (default 50)
  --aperture N       passed through                                  (default 15)
  --focus M          focal distance; defaults to --distance

Output
  --out FILE         where to write the path              (default sweep.json)
  --template FILE    copy per-point fields from a path you exported from your
                     own client, so the file matches that build exactly
  --no-plan          skip the <out>.plan.json that npm run frames reads

Planning
  --depth M          how deep the scene is behind the focal plane; the summary
                     then says how many views that actually needs
`;

interface Args {
  [key: string]: string | boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const num = (args: Args, key: string, fallback: number): number => {
  const raw = args[key];
  if (raw === undefined || typeof raw === 'boolean') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${key} needs a number, got "${raw}"`);
  return value;
};

const str = (args: Args, key: string): string | undefined =>
  typeof args[key] === 'string' ? (args[key] as string) : undefined;

function vec3(raw: string | undefined, fallback: { x: number; y: number; z: number }) {
  if (!raw) return fallback;
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 3 || parts.some((p) => !Number.isFinite(p))) {
    throw new Error(`--anchor needs three numbers, e.g. 0,1.5,0 — got "${raw}"`);
  }
  return { x: parts[0], y: parts[1], z: parts[2] };
}

const m = (metres: number): string =>
  Math.abs(metres) >= 100 ? `${metres.toFixed(0)} m` : `${metres.toFixed(2)} m`;

const mm = (metres: number): string => `${(metres * 1000).toFixed(1)} mm`;

function main(argv: string[]): void {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    console.log(HELP.trim());
    return;
  }

  const lpi = num(args, 'lpi', 45);
  const distanceM = num(args, 'distance', 4);
  const views = Math.round(num(args, 'views', 16));
  if (views < 2) throw new Error(`--views needs at least 2; got ${views}`);

  const options: DollyOptions = {
    views,
    cone:
      args.cone !== undefined
        ? { kind: 'manual', coneDeg: num(args, 'cone', 53.3) }
        : { kind: 'lens', lpi, heightMm: num(args, 'height', 0.9), ri: num(args, 'ri', 1.5) },
    anchor: vec3(str(args, 'anchor'), { x: 0, y: 1, z: 0 }),
    distanceM,
    headingDeg: num(args, 'heading', 0),
    pitchDeg: num(args, 'pitch', 0),
    durationSeconds: num(args, 'duration', 20),
    zoom: num(args, 'zoom', 50),
    aperture: num(args, 'aperture', 15),
    focus: args.focus !== undefined ? num(args, 'focus', distanceM) : undefined,
  };
  const target: PrintTarget = {
    lpi,
    printWidthMm: num(args, 'print-width', 100),
    fovDeg: num(args, 'fov', 60),
    fps: num(args, 'fps', 60),
    ppi: num(args, 'ppi', 1440),
    stripSamples: num(args, 'samples', 2),
  };

  const points = dollyPoints(options);
  const templatePath = str(args, 'template');
  let template: Record<string, unknown> | undefined;
  if (templatePath) {
    const parsed: unknown = JSON.parse(readFileSync(templatePath, 'utf8'));
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!first || typeof first !== 'object') {
      throw new Error(`--template ${templatePath} does not look like a dolly path`);
    }
    template = first as Record<string, unknown>;
  }

  const outPath = str(args, 'out') ?? 'sweep.json';
  writeFileSync(outPath, JSON.stringify(dollyFile(points, options, template), null, 2) + '\n');

  // The plan travels with the path, so pulling the frames out of the recording
  // afterwards needs the video and a start time and nothing else.
  const planPath = `${outPath.replace(/\.json$/i, '')}.plan.json`;
  if (!args['no-plan']) {
    writeFileSync(
      planPath,
      JSON.stringify(
        {
          views: options.views,
          durationSeconds: options.durationSeconds,
          fps: target.fps,
          fovDeg: target.fovDeg,
          printWidthMm: target.printWidthMm,
          lpi: target.lpi,
          timestamps: points.map((p) => Math.round(p.timeSeconds * 1000) / 1000),
        },
        null,
        2,
      ) + '\n',
    );
  }

  const report = reportFor(options, target);
  const crisp = report.depthBudgetM(1);
  const haze = report.depthBudgetM(MAX_HAZE_LENSLETS);
  const ceiling = maxViewsForLens(target);

  const lines = [
    `Wrote ${outPath}: a ${report.durationS.toFixed(1)} s sweep, ${report.shots} views.`,
    args['no-plan'] ? null : `Plan for npm run frames: ${planPath}`,
    '',
    `Cone ${report.coneDeg.toFixed(1)}°${
      options.cone.kind === 'lens'
        ? ` (solved from ${lpi} LPI / ${options.cone.heightMm} mm / RI ${options.cone.ri})`
        : ' (set by hand)'
    } at ${m(distanceM)} — ${m(report.sweepM)} of track, ${m(report.stepM)} between views at`,
    `the widest, ${report.legS.toFixed(2)} s a leg. Nothing holds: record the whole run in one take.`,
    '',
    `Framing at ${target.fovDeg}° horizontal: the frame is ${m(report.frameWidthM)} wide where it is`,
    `sharp, and prints as ${Math.round(report.lensletsAcross)} lenslets across ${target.printWidthMm} mm —`,
    `so one lenslet is ${mm(report.metresPerLenslet)} of subject. Check that width against what you`,
    'actually see through the camera before recording the whole sweep.',
    '',
    'Scene depth, measured off the focal plane through the anchor:',
    `  crisp within ${m(crisp.inFront)} in front and ${m(crisp.behind)} behind (1 lenslet per view),`,
    `  then haze out to ${m(haze.inFront)} / ${m(haze.behind)} — soft, and worth having,`,
    `  past that it doubles rather than softens (over ${MAX_HAZE_LENSLETS} lenslets).`,
    '',
    `Recording at ${target.fps} fps: ${report.framesPerView.toFixed(0)} frames a view, and the camera`,
    `covers ${mm(report.metresPerRecordedFrame)} during one of them — a subject 1 m off the plane`,
    `smears ${blurLenslets(options, target, 1).toFixed(2)} lenslets inside a single frame. Slow the`,
    'sweep or raise the frame rate if that is not comfortably under one.',
  ].filter((line): line is string => line !== null);

  if (views > ceiling) {
    lines.push(
      '',
      `⚠ ${views} views is more than the lens can show: ${target.ppi} PPI over ${lpi} LPI is ` +
        `${Math.round(target.ppi / lpi)} printed dots per lenticule, so at ${target.stripSamples} ` +
        `per strip it carries ${ceiling}. The extra frames have nowhere to go.`,
    );
  }

  const floorY = num(args, 'floor', 0);
  const below = points.filter((p) => p.position.y < floorY);
  if (below.length) {
    lines.push(
      '',
      `⚠ ${below.length} of ${points.length} points sit below y = ${floorY} — the lowest at ` +
        `${Math.min(...below.map((p) => p.position.y)).toFixed(2)}. Raise --anchor, shorten ` +
        `--distance, or tilt the sweep with --pitch; a camera inside the floor films the floor.`,
    );
  }

  if (args.depth !== undefined) {
    const depthM = num(args, 'depth', 1);
    const needed = viewsForDepth(options, target, depthM);
    lines.push(
      '',
      `For ${m(depthM)} of scene behind the plane at ${MAX_STEP_LENSLETS} lenslets a view, you want ` +
        `${needed} views; this sweep has ${views}` +
        (needed <= views
          ? '.'
          : `, and the lens tops out at ${ceiling}. Frame wider (a bigger --fov) to bring the figure ` +
            `down — each lenslet then covers more of the world — or let the far half of the scene go ` +
            `to haze, which is a depth cue rather than a fault.`),
    );
  }

  console.log(lines.join('\n'));
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
