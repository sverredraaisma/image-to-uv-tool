// Build a VRChat camera dolly path that photographs a world into the views a
// lenticular or lens-grid print needs.
//
//   npm run dolly -- --grid 3 --distance 4 --heading 180 --out cube.json
//
// The optics come from src/lib — the same cone the print solves and the same
// tan-spaced eye positions the mesh renderer uses — so a path and a print made
// from the same LPI/height/RI agree without anybody reconciling two copies of
// the arithmetic. See `npm run dolly -- --help`.

import { writeFileSync, readFileSync } from 'node:fs';
import {
  MAX_HAZE_LENSLETS,
  MAX_STEP_LENSLETS,
  dollyFile,
  dollyPoints,
  reportFor,
  viewsForDepth,
  type DollyOptions,
} from '../src/lib/vrchatDolly.ts';

const HELP = `
Camera dolly paths for lenticular capture in VRChat.

  npm run dolly -- [options]

Layout
  --views N          1D run of N shots, for Lenticular Print       (default 12)
  --grid N           N×N grid of shots, for Lens Grid Print        (2–15)

The print these shots are for — the lens sets how wide the shots spread
  --lpi N            lenticules per inch                           (default 45)
  --height MM        gloss stack height                            (default 0.9)
  --ri N             refractive index of the cured varnish         (default 1.5)
  --cone DEG         state the cone outright instead of solving it
  --print-width MM   printed sheet width                          (default 100)

The shot
  --distance M       metres from the camera plane to the subject   (default 4)
  --anchor X,Y,Z     the point that prints sharp                   (default 0,1,0)
  --heading DEG      which way the cameras face, Unity yaw         (default 0)
  --pitch DEG        camera pitch, + looks down                    (default 0)
  --fov DEG          the camera's horizontal field of view         (default 60)
                     — set it to what the camera is really on: it decides how
                     much sheet a metre of subject movement covers, and a wider
                     frame is the forgiving one
  --hold S           seconds to sit at each stop                   (default 4)
  --zoom N           VRChat camera zoom, passed through            (default 50)
  --aperture N       passed through                                (default 15)
  --focus M          focal distance; defaults to --distance

Output
  --out FILE         where to write the path      (default vrchat-dolly.json)
  --template FILE    copy per-point fields from a path you exported from your
                     own client, so the file matches that build exactly
  --shot-list FILE   also write the capture order as text

  --floor Y          warn about stops below this height       (default 0)

Planning
  --depth M          how deep the scene is behind the focal plane; the summary
                     then says how many shots that actually needs
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

function main(argv: string[]): void {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    console.log(HELP.trim());
    return;
  }

  const grid = args.grid !== undefined ? Math.round(num(args, 'grid', 3)) : undefined;
  if (grid !== undefined && (grid < 2 || grid > 15)) {
    throw new Error(`--grid is 2 to 15 (a 15×15 is already 225 shots); got ${grid}`);
  }
  const lpi = num(args, 'lpi', 45);
  const distanceM = num(args, 'distance', 4);

  const options: DollyOptions = {
    layout:
      grid !== undefined
        ? { kind: 'grid', grid }
        : { kind: 'sequence', views: Math.round(num(args, 'views', 12)) },
    cone:
      args.cone !== undefined
        ? { kind: 'manual', coneDeg: num(args, 'cone', 53.3) }
        : { kind: 'lens', lpi, heightMm: num(args, 'height', 0.9), ri: num(args, 'ri', 1.5) },
    anchor: vec3(str(args, 'anchor'), { x: 0, y: 1, z: 0 }),
    distanceM,
    headingDeg: num(args, 'heading', 0),
    pitchDeg: num(args, 'pitch', 0),
    holdSeconds: num(args, 'hold', 4),
    zoom: num(args, 'zoom', 50),
    aperture: num(args, 'aperture', 15),
    focus: args.focus !== undefined ? num(args, 'focus', distanceM) : undefined,
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

  const outPath = str(args, 'out') ?? 'vrchat-dolly.json';
  writeFileSync(outPath, JSON.stringify(dollyFile(points, options, template), null, 2) + '\n');

  const target = {
    lpi,
    printWidthMm: num(args, 'print-width', 100),
    fovDeg: num(args, 'fov', 60),
  };
  const report = reportFor(options, target);
  const crisp = report.depthBudgetM(1);
  const haze = report.depthBudgetM(MAX_HAZE_LENSLETS);
  const layout =
    options.layout.kind === 'grid'
      ? `${options.layout.grid}×${options.layout.grid} grid`
      : `${options.layout.views}-view run`;

  const lines = [
    `Wrote ${outPath}: ${report.shots} stops, ${layout}.`,
    `Cone ${report.coneDeg.toFixed(1)}°${
      options.cone.kind === 'lens'
        ? ` (solved from ${lpi} LPI / ${options.cone.heightMm} mm / RI ${options.cone.ri})`
        : ' (set by hand)'
    } at ${m(distanceM)} — the outermost stop is ${m(report.outerM)} off the centre line,`,
    `${m(report.stepM)} between neighbouring stops at the widest.`,
    '',
    `Framing at ${target.fovDeg}° horizontal: the frame is ${m(report.frameWidthM)} wide where it is`,
    `sharp, and prints as ${Math.round(report.lensletsAcross)} lenslets across ${target.printWidthMm} mm —`,
    `so one lenslet is ${(report.metresPerLenslet * 1000).toFixed(0)} mm of subject. Check that width`,
    'against what you actually see through the camera before shooting the whole path.',
    '',
    'Scene depth, measured off the focal plane through the anchor:',
    `  crisp within ${m(crisp.inFront)} in front and ${m(crisp.behind)} behind (1 lenslet per step),`,
    `  then haze out to ${m(haze.inFront)} / ${m(haze.behind)} — soft, and worth having,`,
    `  past that it doubles rather than softens (over ${MAX_HAZE_LENSLETS} lenslets).`,
    `  ${MAX_STEP_LENSLETS} lenslets is where the print node starts calling it haze.`,
    '',
    'Capture order — the order the print node reads its views:',
  ];
  for (const p of points.slice(0, 4)) lines.push(`  ${p.index + 1}. ${p.label}`);
  if (points.length > 5) lines.push(`  …`);
  if (points.length > 4) {
    const last = points[points.length - 1];
    lines.push(`  ${last.index + 1}. ${last.label}`);
  }
  console.log(lines.join('\n'));

  // A grid at world scale spreads vertically as far as it does sideways, which
  // at a few metres puts the bottom row underground more often than not.
  const floorY = num(args, 'floor', 0);
  const below = points.filter((p) => p.position.y < floorY);
  if (below.length) {
    console.log(
      `
⚠ ${below.length} of ${points.length} stops sit below y = ${floorY} — the lowest at ` +
        `${below[below.length - 1].position.y.toFixed(2)}. Raise --anchor, shorten --distance, or ` +
        `tilt the whole path with --pitch; a camera inside the floor photographs the floor.`,
    );
  }

  if (args.depth !== undefined) {
    const depthM = num(args, 'depth', 1);
    const needed = viewsForDepth(options, target, depthM);
    const have = options.layout.kind === 'grid' ? options.layout.grid : options.layout.views;
    const what = options.layout.kind === 'grid' ? `${needed}×${needed} grid` : `${needed}-view run`;
    console.log(
      `
For ${m(depthM)} of scene behind the plane at ${MAX_STEP_LENSLETS} lenslets a step, ` +
        `you want a ${what}` +
        (needed <= have
          ? ` — this path already has ${have}.`
          : `; this path has ${have}. If that is more shots than you want, frame wider (a bigger ` +
            `--fov): each lenslet then covers more of the world, so the same step crosses fewer of ` +
            `them. You pay in subject size. Standing further back barely helps on its own.`),
    );
  }

  const shotList = str(args, 'shot-list');
  if (shotList) {
    writeFileSync(
      shotList,
      points
        .map(
          (p) =>
            `${String(p.index + 1).padStart(3)}. ${p.label.padEnd(20)} ` +
            `right ${p.offsetM.right.toFixed(3)} m, up ${p.offsetM.up.toFixed(3)} m`,
        )
        .join('\n') + '\n',
    );
    console.log(`\nShot list: ${shotList}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
