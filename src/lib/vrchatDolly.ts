// Camera dolly paths for VRChat, so a world can be filmed into the views a
// lenticular print needs.
//
// The print does not want "some shots from different angles". It wants the one
// arrangement `render3d.ts` describes: the eye TRANSLATES across a plane and
// never rotates, every shot shares one view direction and one focal plane, and
// the positions span exactly the lens's own viewing cone. Aim the camera at the
// subject for each shot instead ("toe-in") and every frame is keystoned
// differently, which under a lens reads as a wobble no amount of care in the
// print will fix.
//
// So a path built here is a straight line of camera positions with **one
// rotation repeated at every point**. That is the whole trick, and it is why
// this is worth generating rather than flying by hand.
//
// The path is meant to be *recorded*, not photographed stop by stop. It is one
// continuous sweep across the cone at a steady pace, and the views come out of
// the recording afterwards: a path point per view, so every view has a known
// timestamp, and no holds anywhere. A 16-view run is then twenty seconds of
// video rather than sixteen trips into the camera menu — and because the
// camera is always moving, the gap between neighbouring views is only ever as
// wide as the cone divided by the views, which is the number the print cares
// about.
//
// The cone and the spacing come from the same functions the renderer and the
// print node use — `lensGeometry()` for the angle the lens can show,
// `eyeOffsetsMm()` for the tan-spaced positions across it — so a path and a
// print made from the same numbers agree by construction.

import { lensGeometry, type LenticularSettings } from './lenticular';
import { disparityAtDepth, eyeOffsetsMm } from './render3d';

/** A point in world space, metres, Unity's left-handed Y-up axes. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Unity rotation quaternion. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Where the cone comes from: solved from the lens, or stated outright. */
export type ConeSource =
  { kind: 'lens'; lpi: number; heightMm: number; ri: number } | { kind: 'manual'; coneDeg: number };

export interface DollyOptions {
  /**
   * How many views the print will interlace. One path point each, so this is
   * also how finely the sweep is sampled — see `maxViewsForLens`, which is what
   * the lenticule can actually carry.
   */
  views: number;
  cone: ConeSource;
  /**
   * The point that will print sharp. Everything on the plane through it,
   * perpendicular to the camera, lands in the same place in every shot; depth
   * is bought by how far the rest of the scene sits off that plane.
   */
  anchor: Vec3;
  /** Metres from the anchor plane back to the camera plane. */
  distanceM: number;
  /** Which way the cameras face. Unity Euler, degrees: yaw about Y, then pitch. */
  headingDeg: number;
  pitchDeg: number;
  /** How long the whole sweep takes, seconds. Slower is less motion blur. */
  durationSeconds: number;
  /** VRChat's camera zoom value, passed through to every point untouched. */
  zoom: number;
  /** Focal distance for depth of field; defaults to the anchor distance. */
  focus?: number;
  aperture: number;
}

/** One stop on the path: where the camera stands, and what it is looking at. */
export interface DollyPoint {
  /** 0-based index in capture order — the order the print node reads. */
  index: number;
  /** `View 3/12`, in the order Lenticular Print reads its frames. */
  label: string;
  /** Seconds into the recording, so the frame can be pulled from the video. */
  timeSeconds: number;
  position: Vec3;
  /** The same rotation at every point, by construction. */
  rotation: Quat;
  /** Offset from the centre of the sweep, metres; negative is to the left. */
  offsetM: number;
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Unity composes Euler angles Z, then X, then Y. Roll is always 0 here. */
export function quaternionFromYawPitch(headingDeg: number, pitchDeg: number): Quat {
  const y = rad(headingDeg) / 2;
  const p = rad(pitchDeg) / 2;
  const [sy, cy] = [Math.sin(y), Math.cos(y)];
  const [sp, cp] = [Math.sin(p), Math.cos(p)];
  // q = Ry * Rx
  return { x: cy * sp, y: sy * cp, z: -sy * sp, w: cy * cp };
}

/** Rotate a vector by a quaternion. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const { x, y, z, w } = q;
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return {
    x: v.x + w * tx + (y * tz - z * ty),
    y: v.y + w * ty + (z * tx - x * tz),
    z: v.z + w * tz + (x * ty - y * tx),
  };
}

/** The camera's own axes at the path's rotation. */
export function cameraBasis(q: Quat): { right: Vec3; up: Vec3; forward: Vec3 } {
  return {
    right: rotate(q, { x: 1, y: 0, z: 0 }),
    up: rotate(q, { x: 0, y: 1, z: 0 }),
    forward: rotate(q, { x: 0, y: 0, z: 1 }),
  };
}

/** The cone the shots must span, in degrees. */
export function coneDegrees(cone: ConeSource): number {
  if (cone.kind === 'manual') return Math.min(170, Math.max(1, cone.coneDeg));
  const settings: LenticularSettings = {
    widthMm: 100,
    ppi: 1440,
    lpi: Math.max(1, cone.lpi),
    phase: 0,
    heightMm: Math.max(0.01, cone.heightMm),
    ri: Math.max(1.01, cone.ri),
    orientationDeg: 0,
    stripSamples: 2,
  };
  return lensGeometry(settings).viewAngleDeg;
}

/**
 * Every point of the sweep, left eye first — the order Lenticular Print reads
 * its frames in, before it reverses them for the lens.
 *
 * One point per view, spaced across the cone the way the renderer spaces its
 * eyes: evenly in *angle*, which is not evenly in position. That spacing is
 * what puts each view at a known moment of the recording, whatever the client
 * does between points, and it is why the timestamps below can be trusted.
 */
export function dollyPoints(o: DollyOptions): DollyPoint[] {
  const views = Math.max(2, Math.round(o.views));
  const coneDeg = coneDegrees(o.cone);
  const rotation = quaternionFromYawPitch(o.headingDeg, o.pitchDeg);
  const { right, forward } = cameraBasis(rotation);
  const distance = Math.max(0.01, o.distanceM);
  const times = viewTimestamps(views, o.durationSeconds);

  // The same tan-spaced positions the renderer puts its eyes at, in metres.
  const offsets = eyeOffsetsMm(views, coneDeg, distance * 1000).map((mm) => mm / 1000);

  return offsets.map((offset, index) => ({
    index,
    label: `View ${index + 1}/${views}`,
    timeSeconds: times[index],
    position: {
      x: o.anchor.x - forward.x * distance + right.x * offset,
      y: o.anchor.y - forward.y * distance + right.y * offset,
      z: o.anchor.z - forward.z * distance + right.z * offset,
    },
    rotation,
    offsetM: offset,
  }));
}

// ---------------------------------------------------------------------------
// The file VRChat reads
// ---------------------------------------------------------------------------

/**
 * One point as VRChat's camera-path export writes it.
 *
 * This is the shape the in-game dolly reads back, and it is the one part of
 * this module that depends on somebody else's format rather than on optics —
 * so it is kept in one place, and `--template` on the CLI will copy the fields
 * out of a path you exported from your own client instead, which is the only
 * way to be certain they match the build you are running.
 */
export interface DollyFilePoint {
  Position: Vec3;
  Rotation: Quat;
  Duration: number;
  LookAtMe: boolean;
  LocalPlayer: boolean;
  Zoom: number;
  Focus: number;
  Aperture: number;
  Hue: number;
  Saturation: number;
  Lightness: number;
  LookAtMeXOffset: number;
  LookAtMeYOffset: number;
}

/**
 * …plus whatever else the client's own file carried. Kept as a separate type
 * because an index signature on {@link DollyFilePoint} itself would swallow the
 * named fields whenever they are picked apart.
 */
export type DollyFileEntry = DollyFilePoint & Record<string, unknown>;

/** Defaults for everything the path does not care about. */
export const DEFAULT_FILE_FIELDS: Omit<DollyFilePoint, 'Position' | 'Rotation' | 'Duration'> = {
  // Off, and it has to stay off: a camera that turns to face anything is a
  // camera that keystones every shot differently.
  LookAtMe: false,
  LocalPlayer: false,
  Zoom: 50,
  Focus: 1.5,
  Aperture: 15,
  Hue: 0,
  Saturation: 1,
  Lightness: 1,
  LookAtMeXOffset: 0,
  LookAtMeYOffset: 0,
};

/**
 * The path as VRChat's dolly reads it. `template` is a point taken from a file
 * exported by the client itself: any field it carries that we do not set is
 * copied through, so a client that has since gained new fields still gets them.
 */
export function dollyFile(
  points: DollyPoint[],
  o: DollyOptions,
  template?: Record<string, unknown>,
): DollyFileEntry[] {
  return points.map((p) => {
    const point: DollyFilePoint = {
      // Position, rotation and duration first, as the client writes them.
      Position: roundVec(p.position),
      Rotation: roundQuat(p.rotation),
      // The leg from this point to the next. Equal for every point, so the
      // sweep runs at one steady pace and view k sits at k·Duration into the
      // recording — which is the whole basis for pulling frames by timestamp.
      Duration: legSeconds(o),
      ...DEFAULT_FILE_FIELDS,
      // …and the ones this path is actually about, which nothing may override.
      Zoom: o.zoom,
      Focus: o.focus ?? o.distanceM,
      Aperture: o.aperture,
      LookAtMe: false,
      LocalPlayer: false,
    };
    // Anything the client's own file carries that this does not know about
    // rides along; everything above wins over it.
    return { ...template, ...point };
  });
}

/**
 * When each view passes, seconds from the start of the sweep. The frames come
 * out of the recording at these times, so this is the one number the path and
 * the extraction have to agree on — hence one function, used by both.
 */
export function viewTimestamps(views: number, durationSeconds: number): number[] {
  const count = Math.max(2, Math.round(views));
  const leg = Math.max(0.01, durationSeconds) / (count - 1);
  return Array.from({ length: count }, (_, i) => i * leg);
}

/**
 * The crop, as an ffmpeg expression rather than a number.
 *
 * `iw`/`ih` are resolved by ffmpeg itself, so this needs neither ffprobe nor
 * any idea of what the recording's resolution turned out to be: take the
 * largest rectangle of the sheet's shape that fits, divide by the zoom, and
 * offset it from the centre.
 */
export function cropFilter(aspect: number, zoom = 1, offset = { x: 0, y: 0 }): string {
  const a = Math.max(0.01, aspect);
  const z = Math.max(0.05, zoom);
  // The commas inside min() have to survive as commas: ffmpeg splits a
  // filtergraph on them, so an unescaped one ends the crop filter halfway
  // through its own argument.
  return (
    `crop=min(iw\\,ih*${a})/${z}:min(ih\\,iw/${a})/${z}:` +
    `(iw-out_w)/2+iw*${offset.x}:(ih-out_h)/2+ih*${offset.y}`
  );
}

/** Seconds per leg: the sweep, divided by the gaps between its views. */
export const legSeconds = (o: DollyOptions): number =>
  Math.max(0.01, o.durationSeconds) / Math.max(1, Math.round(o.views) - 1);

/** Six decimals is a micrometre at these scales, and keeps the file readable. */
const mm = (n: number): number => Math.round(n * 1e6) / 1e6;
const roundVec = (v: Vec3): Vec3 => ({ x: mm(v.x), y: mm(v.y), z: mm(v.z) });
const roundQuat = (q: Quat): Quat => ({ x: mm(q.x), y: mm(q.y), z: mm(q.z), w: mm(q.w) });

// ---------------------------------------------------------------------------
// What the numbers mean for the print
// ---------------------------------------------------------------------------

/** More than this much movement per step and the lens stops resolving it. */
export const MAX_STEP_LENSLETS = 1.5;
/** …and past this it is not haze any more, it is a double image. */
export const MAX_HAZE_LENSLETS = 4;

/** The print the shots are being taken for, and the lens on the camera. */
export interface PrintTarget {
  lpi: number;
  /** Printed sheet width, mm — with the LPI, this is how many lenslets across. */
  printWidthMm: number;
  /**
   * Horizontal field of view of the VRChat camera, degrees. This is the piece
   * that ties world metres to millimetres of print: it decides how wide a slice
   * of the world lands inside the frame, and therefore how much sheet a metre
   * of subject movement covers. Set it to what the camera is actually on.
   */
  fovDeg: number;
  /** Frames a second the recording is made at. */
  fps: number;
  /** Printer resolution, which with the LPI caps how many views can be shown. */
  ppi: number;
  /** Artwork pixels per frame strip — the print node's own setting. */
  stripSamples: number;
}

/**
 * How many views a lenticule can actually carry: the artwork under it is
 * `ppi / lpi` printed dots wide, and each frame strip needs `stripSamples` of
 * them. Ask for more views than this and the extra ones have nowhere to go —
 * which a recording makes very easy to do by accident, since frames are free
 * once the camera is rolling.
 */
export const maxViewsForLens = (target: PrintTarget): number =>
  Math.max(2, Math.floor(target.ppi / Math.max(1e-6, target.lpi * Math.max(1, target.stripSamples))));

export interface DollyReport {
  coneDeg: number;
  /** Views the sweep is sampled into — one path point each. */
  shots: number;
  /** How far the camera travels end to end, metres. */
  sweepM: number;
  /** How long the sweep takes, seconds, and the gap between views. */
  durationS: number;
  legS: number;
  /**
   * How far the camera moves during one frame of the recording, metres. This
   * is the motion blur: a recorded frame is not an instant, it is a slice of
   * the sweep.
   */
  metresPerRecordedFrame: number;
  /** Recorded frames that fall between one view and the next. */
  framesPerView: number;
  /** Widest gap between neighbouring stops, metres — the one that decides. */
  stepM: number;
  /** Distance from the outermost stop to the centre line, metres. */
  outerM: number;
  /** How wide the frame is at the focal plane, metres. */
  frameWidthM: number;
  /** Lenslets across the printed sheet: the real resolution of one view. */
  lensletsAcross: number;
  /**
   * How far a subject may move at the focal plane before it has crossed one
   * lenslet on the sheet, metres. The whole budget is this number against the
   * step between stops.
   */
  metresPerLenslet: number;
  /**
   * How far off the focal plane the scene may sit before a feature moves more
   * than `lenslets` of parallax per step, metres. Behind the plane and in front
   * of it are not the same distance, hence both.
   */
  depthBudgetM: (lenslets: number) => { behind: number; inFront: number };
}

/**
 * What the path is worth as a print: the parallax budget, in the units the
 * print node warns in.
 *
 * The chain is worth stating, because it is the one place world metres and
 * printed millimetres meet. A point `Z` off the focal plane moves `s·Z/(D ∓ Z)`
 * metres between neighbouring shots (minus in front of the plane, plus behind —
 * see `disparityAtDepth`). The frame is `2·D·tan(fov/2)` metres wide at that
 * plane and prints as `printWidth × LPI / 25.4` lenslets, so one lenslet is
 * `frame / lenslets` metres of subject. Divide, and the parallax is in the same
 * units the print node warns about; solve for `Z` instead, and you get the
 * depth the scene may occupy — which is the number worth having *before*
 * walking a path rather than after printing one.
 */
export function reportFor(o: DollyOptions, target: PrintTarget): DollyReport {
  const points = dollyPoints(o);
  const coneDeg = coneDegrees(o.cone);
  const views = Math.max(2, Math.round(o.views));
  const xs = eyeOffsetsMm(views, coneDeg, o.distanceM * 1000);
  const stepM = Math.abs(xs[1] - xs[0]) / 1000;
  const D = o.distanceM;
  const legS = legSeconds(o);
  const fps = Math.max(1, target.fps);

  const frameWidthM = 2 * D * Math.tan(rad(Math.min(179, Math.max(1, target.fovDeg))) / 2);
  const lensletsAcross = (Math.max(1, target.printWidthMm) * Math.max(1, target.lpi)) / 25.4;
  const metresPerLenslet = frameWidthM / lensletsAcross;

  return {
    coneDeg,
    shots: points.length,
    sweepM: (2 * Math.abs(xs[xs.length - 1])) / 1000,
    durationS: legS * (views - 1),
    legS,
    // The widest leg divided by the frames it is filmed over: the camera is
    // fastest at the ends of the sweep, so this is the worst case, which is
    // the one worth quoting.
    metresPerRecordedFrame: stepM / (legS * fps),
    framesPerView: legS * fps,
    stepM,
    outerM: Math.abs(xs[xs.length - 1]) / 1000,
    frameWidthM,
    lensletsAcross,
    metresPerLenslet,
    depthBudgetM: (lenslets: number) => {
      // s·Z/(D + Z) = k·(metres per lenslet)  ⇒  Z = move·D / (s − move), and
      // the signs the other way round for a subject in front of the plane.
      const move = lenslets * metresPerLenslet;
      return {
        behind: move >= stepM ? Infinity : (move * D) / (stepM - move),
        inFront: (move * D) / (stepM + move),
      };
    },
  };
}

/** Nothing sensible needs more shots than this; the search stops there. */
const MAX_SHOTS = 4096;

/**
 * How many shots a scene of a given depth needs, if nothing is to move more
 * than `lenslets` per step.
 *
 * This is the same relation read the other way round, and it is the one to ask
 * first, because the answer is often "more than you were going to take". With
 * `s = 2·D·tan(cone/2)/(N−1)` and one lenslet worth `2·D·tan(fov/2)/across`
 * metres at the plane, the viewing distance nearly cancels:
 *
 *     N − 1 ≈ across · tan(cone/2) · Z / ( k · tan(fov/2) · (D + Z) )
 *
 * So it is the *framing* that decides — how much world one sheet is being asked
 * to hold — far more than how far away you stand. A **wider** field of view is
 * the forgiving one: each lenslet then covers more of the world, so the same
 * camera step crosses fewer of them. You pay for it in subject size, which is
 * the trade the shot is really about.
 *
 * That formula is only the starting guess, though. The stops are spread evenly
 * in *angle*, so the outermost gap is wider than the average one, and it is the
 * widest gap that decides whether the print ghosts — hence the walk upwards
 * against the real spacing rather than trusting the closed form.
 */
export function viewsForDepth(
  o: DollyOptions,
  target: PrintTarget,
  depthM: number,
  lenslets = MAX_STEP_LENSLETS,
): number {
  const D = Math.max(0.01, o.distanceM);
  const Z = Math.max(0, depthM);
  if (Z === 0) return 2;
  const across = (Math.max(1, target.printWidthMm) * Math.max(1, target.lpi)) / 25.4;
  const halfCone = Math.tan(rad(coneDegrees(o.cone)) / 2);
  const halfFov = Math.tan(rad(Math.min(179, Math.max(1, target.fovDeg))) / 2);
  const guess = (across * halfCone * Z) / (Math.max(1e-6, lenslets) * halfFov * (D + Z));

  let views = Math.max(2, Math.ceil(guess) + 1);
  while (views < MAX_SHOTS && parallaxAt(withViews(o, views), target, Z) > lenslets) views++;
  return views;
}

/** The same sweep sampled into a different number of views. */
const withViews = (o: DollyOptions, views: number): DollyOptions => ({ ...o, views });

/**
 * How far a feature `depthM` behind the focal plane smears *within* one
 * recorded frame, in lenslets.
 *
 * A photograph is an instant; a video frame is a slice of the sweep, and the
 * camera keeps moving through it. Under a lens that smear is not a soft edge —
 * it is the view itself being mixed with its neighbour before the print ever
 * gets to interlace them. Keeping it well under a lenslet is what makes a fast
 * sweep safe; the way to buy it back is a slower sweep or a higher frame rate,
 * both of which cost nothing but time.
 */
export function blurLenslets(o: DollyOptions, target: PrintTarget, depthM: number): number {
  const report = reportFor(o, target);
  const D = Math.max(0.01, o.distanceM);
  const moved = (report.metresPerRecordedFrame * Math.abs(depthM)) / (D + depthM);
  return moved / report.metresPerLenslet;
}

/** Parallax a feature `depthM` behind the focal plane will show, in lenslets. */
export function parallaxAt(o: DollyOptions, target: PrintTarget, depthM: number): number {
  const report = reportFor(o, target);
  // disparityAtDepth works in whatever unit it is handed; metres here, turned
  // into lenslets by the metres-per-lenslet the framing gives.
  const moved = disparityAtDepth(report.stepM, -depthM, o.distanceM, 1).mm;
  return moved / report.metresPerLenslet;
}
