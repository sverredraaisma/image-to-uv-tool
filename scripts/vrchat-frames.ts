// Turn a recorded dolly sweep into a GIF the tool can print.
//
//   npm run frames -- --video sweep.mp4 --plan sweep.plan.json --start 3.4
//
// The sweep put one path point per view, so every view sits at a known moment
// of the recording; this pulls exactly those frames out, crops them to the
// sheet's shape, and writes them as a GIF in viewing order. Drop that GIF on an
// **Animation Input** and wire its Frames output straight into **Lenticular
// Print** — the whole animation travels on one wire, and the print interlaces
// the frames in the order they arrive.
//
// ffmpeg does the work; this decides what to ask it for. `--dry-run` prints the
// commands instead of running them, which is also the answer if ffmpeg lives on
// a different machine to this one.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cropFilter, viewTimestamps } from '../src/lib/vrchatDolly.ts';

const HELP = `
Pull the views out of a recorded sweep and write them as a GIF.

  npm run frames -- --video FILE [options]

Where the views are
  --plan FILE        the .plan.json written next to the dolly path
  --views N          …or state it by hand, with --duration
  --duration S       length of the sweep, seconds
  --start S          when the sweep begins in the recording        (default 0)
                     — the moment the camera starts moving, not when you hit
                     record; this is the one number to get right

The crop
  --aspect W:H       shape of the printed sheet                  (default 4:3)
  --zoom F           crop in by this factor, 1 = as wide as it goes (default 1)
  --offset X,Y       move the crop, in fractions of the frame     (default 0,0)
  --width PX         output width; the default is one pixel per lenslet, which
                     is all a print can resolve — more is only for looking at

The GIF
  --out FILE         where to write it                       (default views.gif)
  --delay MS         frame delay, purely for previewing        (default 100)
  --keep-frames DIR  also keep the extracted PNGs
  --dry-run          print the ffmpeg commands instead of running them
  --ffmpeg PATH      ffmpeg to use                            (default ffmpeg)
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

interface Plan {
  views: number;
  durationSeconds: number;
  printWidthMm?: number;
  lpi?: number;
  timestamps?: number[];
}

/** Where each view sits in the recording, seconds from its start. */
const viewTimes = (plan: Plan): number[] =>
  plan.timestamps?.length ? plan.timestamps : viewTimestamps(plan.views, plan.durationSeconds);

function run(ffmpeg: string, args: string[], dryRun: boolean): void {
  if (dryRun) {
    // Quoted so the printed line can be pasted into a shell as it stands —
    // the crop filter carries escaped commas that a shell would otherwise eat.
    const quoted = args.map((a) => (/[\s"',()\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a));
    console.log(`${ffmpeg} ${quoted.join(' ')}`);
    return;
  }
  const result = spawnSync(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (result.error) {
    throw new Error(
      `could not run ${ffmpeg}: ${result.error.message}\n` +
        `Install ffmpeg, or pass --dry-run to print the commands and run them elsewhere.`,
    );
  }
  if (result.status !== 0) {
    const tail = (result.stderr ?? '').trim().split('\n').slice(-6).join('\n');
    throw new Error(`ffmpeg failed (${result.status}):\n${tail}`);
  }
}

function main(argv: string[]): void {
  const args = parseArgs(argv);
  if (args.help || args.h || argv.length === 0) {
    console.log(HELP.trim());
    return;
  }

  const video = str(args, 'video');
  if (!video) throw new Error('--video is required (the recording of the sweep)');
  if (!existsSync(video)) throw new Error(`--video ${video} does not exist`);

  const planPath = str(args, 'plan');
  let plan: Plan;
  if (planPath) {
    plan = JSON.parse(readFileSync(planPath, 'utf8')) as Plan;
  } else if (args.views !== undefined && args.duration !== undefined) {
    plan = { views: num(args, 'views', 16), durationSeconds: num(args, 'duration', 20) };
  } else {
    throw new Error('give --plan, or both --views and --duration');
  }

  const times = viewTimes(plan);
  const start = num(args, 'start', 0);
  const aspectRaw = str(args, 'aspect') ?? '4:3';
  const [aw, ah] = aspectRaw.split(':').map(Number);
  if (!Number.isFinite(aw) || !Number.isFinite(ah) || aw <= 0 || ah <= 0) {
    throw new Error(`--aspect wants W:H, e.g. 4:3 — got "${aspectRaw}"`);
  }
  const aspect = aw / ah;
  const zoom = Math.max(0.05, num(args, 'zoom', 1));
  const offsetRaw = (str(args, 'offset') ?? '0,0').split(',').map(Number);
  const offset = { x: offsetRaw[0] || 0, y: offsetRaw[1] || 0 };

  // One pixel per lenslet is everything the print can resolve; anything past
  // that is for looking at on screen, not for the sheet.
  const lensletWidth = Math.round(((plan.printWidthMm ?? 100) * (plan.lpi ?? 45)) / 25.4);
  const width = Math.max(16, Math.round(num(args, 'width', lensletWidth)));
  const height = Math.max(16, Math.round(width / aspect));
  const outPath = str(args, 'out') ?? 'views.gif';
  const delayMs = Math.max(10, num(args, 'delay', 100));
  const ffmpeg = str(args, 'ffmpeg') ?? 'ffmpeg';
  const dryRun = !!args['dry-run'];

  const keepDir = str(args, 'keep-frames');
  if (keepDir) mkdirSync(keepDir, { recursive: true });
  const workDir = keepDir ?? (dryRun ? '<tmp>' : mkdtempSync(join(tmpdir(), 'lenticular-')));

  const filters = `${cropFilter(aspect, zoom, offset)},scale=${width}:${height}:flags=lanczos`;
  const pad = String(times.length).length;
  const framePath = (i: number) => join(workDir, `view-${String(i + 1).padStart(pad, '0')}.png`);

  try {
    times.forEach((t, i) => {
      // Seek before -i so ffmpeg seeks rather than decodes its way there; it
      // still lands on the frame containing that instant.
      run(
        ffmpeg,
        ['-y', '-ss', (start + t).toFixed(3), '-i', video, '-frames:v', '1', '-vf', filters, framePath(i)],
        dryRun,
      );
    });

    // Two passes, because a GIF gets 256 colours and letting ffmpeg choose them
    // from the actual frames is the difference between a print and a poster of
    // a print. The frame rate here is only for previewing: the print reads the
    // frames in order and ignores their timing.
    const fps = 1000 / delayMs;
    const pattern = join(workDir, `view-%0${pad}d.png`);
    const palette = join(workDir, 'palette.png');
    run(ffmpeg, ['-y', '-i', pattern, '-vf', 'palettegen=stats_mode=diff', palette], dryRun);
    run(
      ffmpeg,
      [
        '-y',
        '-framerate',
        fps.toFixed(3),
        '-i',
        pattern,
        '-i',
        palette,
        '-lavfi',
        'paletteuse=dither=bayer:bayer_scale=3',
        '-loop',
        '0',
        outPath,
      ],
      dryRun,
    );
  } finally {
    if (!keepDir && !dryRun) rmSync(workDir, { recursive: true, force: true });
  }

  if (dryRun) return;
  console.log(
    [
      `Wrote ${outPath}: ${times.length} views at ${width}×${height}, cropped to ${aspectRaw}.`,
      `Pulled from ${(start + times[0]).toFixed(2)} s to ${(start + times[times.length - 1]).toFixed(2)} s.`,
      keepDir ? `Frames kept in ${keepDir}.` : '',
      '',
      'Drop it on an Animation Input and wire Frames into Lenticular Print. Check the first and',
      'last views before printing: if the sweep starts or ends outside the recording you will see',
      'it there first, and --start is what fixes it.',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
