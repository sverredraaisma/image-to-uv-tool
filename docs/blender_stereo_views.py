"""Render the views a lenticular "stereo window" print needs, from Blender.

This is the Model -> Stereo Views node's camera, rebuilt in Blender so the views
can come from a real renderer — your materials, your lights, Cycles if you want
it — instead of the tool's own rasteriser. The optics are identical, and they
have to be: a lenticular print is unforgiving about exactly two things, and both
of them are camera setup.

    1. The eye SHIFTS; it never rotates.

       Aiming a camera at the subject for each view ("toe-in") keystones every
       view differently and adds vertical parallax between views that should
       differ only horizontally. Under a lens that reads as a wobble as your
       head moves, and nothing downstream can fix it. So every view here shares
       one view direction and one focal plane, and only the eye position moves:
       each view is a shear of the same projection, which in Blender means
       sliding the camera along X and cancelling the slide with `shift_x`.

    2. The subject stands BEHIND the sheet.

       The print is then a window you look into. Nothing floats in front of the
       paper, so nothing can be cut off by the paper's edge while appearing to
       be nearer than it; the sheet's own edges occlude the subject as you move,
       which is where most of the depth you actually see comes from; and a point
       Z behind the window moves s*Z/(D+Z) per eye step rather than s*Z/(D-Z),
       so depth behind the glass is simply cheaper than depth in front of it.

See docs/printed-lenses.md for the algebra, and the "The window" section in
particular. This script is MIT-licensed like the rest of the repository.

--------------------------------------------------------------------------
Using it
--------------------------------------------------------------------------

From a shell, on a scene you have already lit:

    blender scene.blend --background --python docs/blender_stereo_views.py -- \
        --out ./views --views 12 --width-mm 100 --height-mm 75 \
        --depth-mm 6 --setback-mm 0 --distance-mm 400 --lpi 45

Or open it in Blender's Scripting tab, edit SETTINGS at the top, and press Run.
Either way it:

  * creates (or reuses) an Empty called "StereoWindow" — move, rotate and scale
    that to put the window where you want it in your scene, then run again;
  * parents a camera to it, solved so the window rectangle exactly fills the
    frame from every eye position;
  * renders one image per view into --out, in the order Lenticular Print wants
    them;
  * writes stereo-views.json beside them with every solved number, so nothing
    about the setup is a mystery afterwards.

Then in the tool: wire the images into Lenticular Print's Frames input in file
order (or bundle them into a GIF and use one Animation Input).

--------------------------------------------------------------------------
Checking it without Blender
--------------------------------------------------------------------------

    python docs/blender_stereo_views.py --selftest

runs the optics against the figures the TypeScript implementation is tested
against. The Blender half is guarded, so the maths can be checked anywhere.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys

# Blender on Windows can hand us a console that cannot encode the typography in
# this file's own docstring. Printing must never be the thing that fails.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # not a real stream, or already fixed
        pass

# --------------------------------------------------------------------------
# SETTINGS — edit these when running from Blender's Scripting tab. Command-line
# arguments (after a bare `--`) override them.
# --------------------------------------------------------------------------

SETTINGS = {
    # The print, in millimetres.
    "width_mm": 100.0,
    "height_mm": 75.0,
    # How far away the print is meant to be looked at.
    "distance_mm": 400.0,
    # The lens you are going to print, which is what decides the view cone.
    "lpi": 45.0,
    "gloss_height_mm": 0.9,
    "ri": 1.5,
    # Or set this to override the solved cone (degrees). None = solve it.
    "cone_deg": None,
    # How many views across the cone. A 1D print spends resolution on one axis
    # only, so this can be generous; every extra view shrinks the eye step and
    # buys depth back.
    "views": 12,
    # The box the subject lives in, behind the window: its near face `setback`
    # behind the glass, `depth` deep. 0 setback stands it against the glass.
    "setback_mm": 0.0,
    "depth_mm": 6.0,
    # Scale of the rig: how many Blender units one printed millimetre is. The
    # default treats 1 unit as 1 mm; for a scene modelled in metres, 0.001.
    # You can also just scale the StereoWindow empty by hand.
    "units_per_mm": 1.0,
    # Render width. None = one pixel per lenticule, times `supersample` — which
    # is all the print can resolve. Height follows the window's aspect.
    "render_width": None,
    "supersample": 4,
    # A lenticule shows its leftmost strip to an eye on the *right*, and
    # Lenticular Print interlaces frames in the order they arrive, so the run
    # is written right-eye-first. Turn off for the raw left-to-right order.
    "mirror_views": True,
    # True always fits the window to the subject, False never does, None (the
    # default) fits only when the window has just been created.
    "fit": None,
    "out": "./stereo-views",
    "file_prefix": "view",
}

#: More than this per eye step and the far face ghosts instead of gliding.
MAX_STEP_LENTICULES = 1.5
#: Less than this and the views are so alike the print reads as flat.
MIN_STEP_LENTICULES = 0.15


# --------------------------------------------------------------------------
# The optics. Pure arithmetic — no bpy — so `--selftest` can check it anywhere.
# --------------------------------------------------------------------------


def lens_geometry(lpi: float, height_mm: float, ri: float) -> dict:
    """Solve the printed lens, and with it the cone the views must span.

    The same solve as `lensGeometry()` in src/lib/lenticular.ts: a lens whose
    focus lands on the artwork, `height_mm` below the apex. An infeasible
    combination falls back to a hemisphere — the strongest lens that pitch can
    make — and reports the focus it actually achieves rather than refusing.
    """
    lpi = max(1e-6, lpi)
    n = max(1.0001, ri)
    h = max(1e-6, height_mm)
    pitch_mm = 25.4 / lpi
    half = pitch_mm / 2

    min_height_mm = (n * pitch_mm) / (2 * (n - 1))
    disc = h * h * (n - 1) ** 2 - n * n * half * half
    feasible = disc >= 0
    sag_mm = ((h * (n - 1) - math.sqrt(disc)) / n) if feasible else half
    radius_mm = (sag_mm * sag_mm + half * half) / (2 * sag_mm)
    focus_mm = (n * radius_mm) / (n - 1)

    # Marginal ray from the focus to the lens edge, refracted back out to air.
    sin_inside = half / math.hypot(half, focus_mm)
    view_angle_deg = 2 * math.degrees(math.asin(min(1.0, n * sin_inside)))

    return {
        "pitch_mm": pitch_mm,
        "sag_mm": sag_mm,
        "base_mm": max(0.0, h - sag_mm),
        "radius_mm": radius_mm,
        "focus_mm": focus_mm,
        "feasible": feasible,
        "min_height_mm": min_height_mm,
        "view_angle_deg": view_angle_deg,
    }


def eye_offsets_mm(count: int, cone_deg: float, distance_mm: float) -> list[float]:
    """Where each eye sits, mm off the window's axis; negative is left.

    The run spans the whole cone, so the outermost views sit at exactly
    +/-cone/2. `tan` because these are positions on a plane, not arc lengths:
    at 53.3 degrees and 400 mm the outer eye is 200 mm off-axis, not 186.
    """
    n = max(1, int(round(count)))
    if n == 1:
        return [0.0]
    half = math.radians(max(0.0, cone_deg)) / 2
    return [math.tan((i / (n - 1) * 2 - 1) * half) * max(1e-6, distance_mm) for i in range(n)]


def disparity_at_depth(step_mm: float, z_mm: float, distance_mm: float, lpi: float) -> dict:
    """How far a point at depth `z_mm` slides when the eye moves `step_mm`.

    Positive z is in front of the window, negative behind it. From the
    projection, dX/de = 1 - t with t = D/(D - z), so the movement is
    s*z/(D - z) — which for a point behind the glass is s*Z/(D + Z).
    """
    d = max(1e-6, distance_mm)
    mm = math.inf if z_mm >= d else abs(step_mm * z_mm / (d - z_mm))
    return {"mm": mm, "lenticules": mm / (25.4 / max(1e-6, lpi))}


def window_fit_scale(distance_mm: float, near_mm: float) -> float:
    """How much bigger the subject has to be to fill a window it stands behind.

    Seen from the eye, a subject `Z` back subtends D/(D + Z) of what it would
    at the glass, so it has to be scaled by the reciprocal. Measured at the
    near face — the plane that projects largest — so nothing spills past the
    edge of the aperture.
    """
    d = max(1e-6, distance_mm)
    return (d + max(0.0, near_mm)) / d


def solve(s: dict) -> dict:
    """Everything the render needs, plus everything worth warning about."""
    lens = lens_geometry(s["lpi"], s["gloss_height_mm"], s["ri"])
    cone_deg = s["cone_deg"] if s["cone_deg"] else lens["view_angle_deg"]
    views = max(2, int(s["views"]))
    offsets = eye_offsets_mm(views, cone_deg, s["distance_mm"])
    # The widest step is between the outermost pair, so that is the one the
    # print has to survive.
    step_mm = max(abs(b - a) for a, b in zip(offsets, offsets[1:]))

    near_mm = max(0.0, s["setback_mm"])
    far_mm = near_mm + max(0.0, s["depth_mm"])
    step = disparity_at_depth(step_mm, -far_mm, s["distance_mm"], s["lpi"])

    lenticules_across = s["width_mm"] * s["lpi"] / 25.4
    render_width = s["render_width"] or max(512, int(math.ceil(lenticules_across * s["supersample"])))
    render_height = max(1, int(round(render_width * s["height_mm"] / s["width_mm"])))

    warnings = []
    if not lens["feasible"]:
        warnings.append(
            f"At {s['lpi']} LPI / RI {s['ri']} no lens focuses in {s['gloss_height_mm']} mm - "
            f"the cone below is a hemisphere's. Raise the gloss height to "
            f"{lens['min_height_mm']:.3f} mm or raise LPI."
        )
    if step["lenticules"] > MAX_STEP_LENTICULES:
        budget = far_mm * MAX_STEP_LENTICULES / step["lenticules"]
        warnings.append(
            f"{step['lenticules']:.2f} lenticules per view step at the far face is too much - the print "
            f"will ghost rather than read as depth. Keep the subject within about {budget:.1f} mm of "
            f"the window, add views, or raise LPI."
        )
    elif step["lenticules"] < MIN_STEP_LENTICULES and far_mm > 0:
        warnings.append(
            f"Only {step['lenticules']:.2f} lenticules per view step - the views are nearly identical "
            f"and the print will look flat. Give the subject more depth, or push it further back."
        )
    if render_width < lenticules_across:
        warnings.append(
            f"Rendering {render_width} px wide but the print resolves {lenticules_across:.0f} - the "
            f"views will be upsampled."
        )

    return {
        "lens": lens,
        "lpi": s["lpi"],
        "cone_deg": cone_deg,
        "cone_from": "settings" if s["cone_deg"] else "lens",
        "views": views,
        "eye_offsets_mm": offsets,
        "eye_step_mm": step_mm,
        "window_mm": [s["width_mm"], s["height_mm"]],
        "distance_mm": s["distance_mm"],
        "subject_behind_mm": [near_mm, far_mm],
        "fit_scale": window_fit_scale(s["distance_mm"], near_mm),
        "parallax_per_step": step,
        "parallax_across_cone_lenticules": step["lenticules"] * (views - 1),
        "lenticules_across": lenticules_across,
        "render": [render_width, render_height],
        "warnings": warnings,
    }


def report(plan: dict, s: dict) -> str:
    """The same report the node's Info output gives, for the console.

    Deliberately ASCII: this gets printed to whatever console Blender was
    launched from, and a Windows one is not reliably UTF-8.
    """
    near, far = plan["subject_behind_mm"]
    cone_from = "solved from the lens" if plan["cone_from"] == "lens" else "set by hand"
    lines = [
        f"{plan['views']} views | {plan['render'][0]}x{plan['render'][1]} px each",
        f"Window {plan['window_mm'][0]}x{plan['window_mm'][1]} mm, viewed from {plan['distance_mm']} mm",
        f"Cone {plan['cone_deg']:.1f} deg ({cone_from}) - outer eye "
        f"{plan['eye_offsets_mm'][-1]:.0f} mm off-axis, {plan['eye_step_mm']:.1f} mm per step",
        f"Subject {near:.1f}-{far:.1f} mm behind the window, all of it - nothing crosses the plane",
        f"Fill the window from the near face by scaling x{plan['fit_scale']:.3f}",
        f"Parallax {plan['parallax_per_step']['lenticules']:.2f} lenticules per step at the far face "
        f"({plan['parallax_per_step']['mm']:.3f} mm at {s['lpi']} LPI), "
        f"{plan['parallax_across_cone_lenticules']:.2f} across the whole cone",
        f"Each view prints at {plan['lenticules_across']:.0f} px across - one per lenticule",
    ]
    lines += [f"WARNING: {w}" for w in plan["warnings"]]
    return "\n".join(lines)


# --------------------------------------------------------------------------
# The Blender half.
# --------------------------------------------------------------------------

RIG_NAME = "StereoWindow"
CAMERA_NAME = "StereoWindowCamera"


def subject_objects(rig, cam_obj) -> list:
    """What the print is of: the selection if there is one, else every mesh."""
    import bpy

    skip = {rig.name, cam_obj.name}
    selected = [o for o in bpy.context.selected_objects if o.type == "MESH" and o.name not in skip]
    if selected:
        return selected
    return [o for o in bpy.context.scene.objects if o.type == "MESH" and o.name not in skip]


def subject_bounds(objects, matrix) -> dict | None:
    """The subject's bounding box in the space `matrix` maps world space into.

    Evaluated, so modifiers and instancing count — a subdivided or arrayed
    object is measured as it will render, not as it is authored.
    """
    import bpy
    from mathutils import Vector

    depsgraph = bpy.context.evaluated_depsgraph_get()
    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    found = False
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        for corner in evaluated.bound_box:
            p = matrix @ (evaluated.matrix_world @ Vector(corner))
            for i in range(3):
                lo[i] = min(lo[i], p[i])
                hi[i] = max(hi[i], p[i])
            found = True
    if not found:
        return None
    low, high = Vector(lo), Vector(hi)
    return {"min": low, "max": high, "centre": (low + high) / 2, "size": high - low}


def fit_rig_to_subject(rig, cam_obj, plan: dict) -> None:
    """Place and scale the window so the subject sits in the box behind it.

    The rig's *rotation* is left alone — that is your choice of viewing
    direction, and the one thing this cannot guess. Everything else follows:
    the scale that makes the subject fill the window seen from the near face,
    and the position that puts its nearest point `setback` mm behind the glass.

    Nothing about the subject is touched. Fitting moves the window, not the
    model, so the scene is exactly as you left it afterwards.
    """
    from mathutils import Matrix, Vector

    # Measure in the rig's *orientation* but not its scale or position, so the
    # numbers do not depend on where the rig happens to be right now.
    orientation = rig.matrix_world.to_quaternion().to_matrix().to_4x4()
    bounds = subject_bounds(subject_objects(rig, cam_obj), orientation.inverted())
    if bounds is None:
        print("[stereo] nothing to fit to - leaving the window where it is")
        return

    near_mm = plan["subject_behind_mm"][0]
    margin = 1.0 - 0.08  # a little air around the subject, as the node leaves
    # Half-window at the near face, in mm: what the subject has to fit inside.
    grow = plan["fit_scale"]
    target_x = plan["window_mm"][0] / 2 * margin * grow
    target_y = plan["window_mm"][1] / 2 * margin * grow
    # Blender units per printed mm, so the subject exactly fills that.
    scale = max(bounds["size"].x / 2 / target_x, bounds["size"].y / 2 / target_y, 1e-9)

    # The window plane sits `setback` mm in front of the subject's near face,
    # along the rig's own +Z (which is where the camera is).
    centre = bounds["centre"]
    origin_local = Vector((centre.x, centre.y, bounds["max"].z + near_mm * scale))
    rig.matrix_world = orientation @ Matrix.Translation(origin_local) @ Matrix.Scale(scale, 4)
    print(
        f"[stereo] fitted the window: 1 mm = {scale:.6g} units, "
        f"subject {bounds['size'].z / scale:.1f} mm deep"
    )


def check_subject(rig, cam_obj, plan: dict) -> list[str]:
    """Measure the scene against the window and say what is wrong with it.

    This is the check the whole arrangement exists for. A subject that crosses
    the window plane can be clipped by the edge of the paper while appearing to
    float in front of it, which is the one thing a stereo print must never do.
    """
    bounds = subject_bounds(subject_objects(rig, cam_obj), rig.matrix_world.inverted())
    if bounds is None:
        return ["Nothing renderable in the scene - the views will be empty."]

    problems = []
    # Rig space is millimetres of print: +Z is toward the viewer, so anything
    # above zero is in front of the glass.
    front_mm, back_mm = bounds["max"].z, bounds["min"].z
    if front_mm > 0.01:
        problems.append(
            f"The subject sticks {front_mm:.1f} mm out in FRONT of the window. It can be cut off by the "
            f"edge of the sheet while looking nearer than it, which is the one thing to avoid. Move it "
            f"back, or re-run with --fit."
        )
    depth_mm = front_mm - back_mm
    configured = plan["subject_behind_mm"][1] - plan["subject_behind_mm"][0]
    if depth_mm > configured * 1.05:
        actual = disparity_at_depth(plan["eye_step_mm"], back_mm, plan["distance_mm"], plan["lpi"])
        problems.append(
            f"The subject is {depth_mm:.1f} mm deep, not the {configured:.1f} mm this was solved for: "
            f"its far face moves {actual['lenticules']:.2f} lenticules per view step"
            + (" and will ghost." if actual["lenticules"] > MAX_STEP_LENTICULES else ".")
        )
    return problems


def build_rig(plan: dict, s: dict):
    """The window rig: an Empty you can place, and a camera parented to it.

    The Empty *is* the window — its local XY plane, `width_mm` x `height_mm`
    across, with the camera out along +Z and the subject at negative Z behind
    it. Move, rotate and scale it to frame your subject and run again; scaling
    it scales the whole setup together, so the geometry stays right whatever
    units your scene is in.
    """
    import bpy

    rig = bpy.data.objects.get(RIG_NAME)
    fresh = rig is None
    if fresh:
        rig = bpy.data.objects.new(RIG_NAME, None)
        rig.empty_display_type = "PLAIN_AXES"
        # Local units are printed millimetres, so this draws the window's width.
        rig.empty_display_size = s["width_mm"] / 2
        rig.scale = (s["units_per_mm"],) * 3
        bpy.context.scene.collection.objects.link(rig)

    cam_obj = bpy.data.objects.get(CAMERA_NAME)
    if cam_obj is None:
        cam_data = bpy.data.cameras.new(CAMERA_NAME)
        cam_obj = bpy.data.objects.new(CAMERA_NAME, cam_data)
        bpy.context.scene.collection.objects.link(cam_obj)
    cam_obj.parent = rig
    # Local coordinates, please: the camera's transform is the eye position in
    # printed millimetres, not wherever it happened to be sitting before.
    cam_obj.matrix_parent_inverse.identity()
    cam_obj.rotation_euler = (0.0, 0.0, 0.0)  # never aimed: it looks down -Z
    cam_obj.scale = (1.0, 1.0, 1.0)

    cam = cam_obj.data
    cam.type = "PERSP"
    # Horizontal fit, so `shift_x` is measured in frame widths whatever the
    # render aspect turns out to be.
    cam.sensor_fit = "HORIZONTAL"
    # The focal length that makes the window exactly fill the frame at the
    # viewing distance: W/D = sensor/lens.
    cam.lens = cam.sensor_width * plan["distance_mm"] / plan["window_mm"][0]
    cam.shift_x = 0.0
    cam.shift_y = 0.0
    return rig, cam_obj, fresh


def calibrate_shift(scene, cam_obj, eye_mm: float, plan: dict) -> float:
    """The `shift_x` that puts the window back in frame after moving the eye.

    Solved by measurement rather than from Blender's sign convention: the
    projection is affine in `shift_x`, so two probes give the exact line. That
    also means this keeps working if a Blender release ever changes what the
    sign means.
    """
    import bpy
    from bpy_extras.object_utils import world_to_camera_view
    from mathutils import Vector

    half_w = plan["window_mm"][0] / 2
    corner = Vector((half_w, 0.0, 0.0))  # on the window plane, right-hand edge

    def probe(shift: float) -> float:
        cam_obj.data.shift_x = shift
        bpy.context.view_layer.update()
        # world_to_camera_view wants world space; the corner is in rig space.
        world = cam_obj.parent.matrix_world @ corner if cam_obj.parent else corner
        return world_to_camera_view(scene, cam_obj, world).x

    at_zero = probe(0.0)
    slope = probe(0.1) - at_zero
    if abs(slope) < 1e-9:
        raise RuntimeError("shift_x has no effect on the projection - is the camera orthographic?")
    # The right edge of the window must land on the right edge of the frame.
    shift = (1.0 - at_zero) * 0.1 / slope
    landed = probe(shift)
    if abs(landed - 1.0) > 1e-4:
        raise RuntimeError(
            f"Could not frame the window from eye {eye_mm:.1f} mm: the right edge landed at "
            f"{landed:.6f} of the frame instead of 1.0."
        )
    return shift


def render_views(plan: dict, s: dict) -> list[dict]:
    """Render one image per eye position and return what went where."""
    import bpy
    from bpy_extras.object_utils import world_to_camera_view
    from mathutils import Vector

    scene = bpy.context.scene
    rig, cam_obj, fresh = build_rig(plan, s)
    # A window that has just been created is at the origin facing +Z, which is
    # meaningless, so fit it. An existing one is left where you put it unless
    # you ask.
    if s["fit"] is True or (s["fit"] is None and fresh):
        fit_rig_to_subject(rig, cam_obj, plan)
    bpy.context.view_layer.update()

    for problem in check_subject(rig, cam_obj, plan):
        print(f"[stereo] WARNING: {problem}")

    previous_camera = scene.camera
    previous_res = (scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage)
    previous_path = scene.render.filepath
    previous_format = scene.render.image_settings.file_format
    scene.camera = cam_obj
    scene.render.resolution_x, scene.render.resolution_y = plan["render"]
    scene.render.resolution_percentage = 100
    scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1.0
    # PNG whatever the scene was set to, so the files match the names below.
    scene.render.image_settings.file_format = "PNG"

    out_dir = os.path.abspath(s["out"])
    os.makedirs(out_dir, exist_ok=True)

    # File order is the order Lenticular Print interlaces in, which is the
    # reverse of eye order — a lenticule shows its leftmost strip to an eye on
    # the right. The manifest records which eye each file actually is.
    order = list(range(plan["views"]))
    if s["mirror_views"]:
        order.reverse()

    written = []
    try:
        for file_index, view_index in enumerate(order):
            eye_mm = plan["eye_offsets_mm"][view_index]
            cam_obj.location = (eye_mm, 0.0, plan["distance_mm"])
            shift = calibrate_shift(scene, cam_obj, eye_mm, plan)

            path = os.path.join(out_dir, f"{s['file_prefix']}_{file_index:02d}.png")
            scene.render.filepath = path
            print(f"[stereo] {file_index + 1}/{plan['views']}  eye {eye_mm:+.1f} mm  shift {shift:+.5f}")
            bpy.ops.render.render(write_still=True)

            # Proof rather than assertion: the window plane really is common to
            # every view, so a point on it must land in the same place in all
            # of them. This is the one property the whole print depends on.
            centre = world_to_camera_view(scene, cam_obj, rig.matrix_world @ Vector((0.0, 0.0, 0.0)))
            if abs(centre.x - 0.5) > 1e-4 or abs(centre.y - 0.5) > 1e-4:
                raise RuntimeError(
                    f"The window centre moved to ({centre.x:.6f}, {centre.y:.6f}) in view {file_index} - "
                    "the views are not sharing a focal plane."
                )
            written.append(
                {
                    "file": os.path.basename(path),
                    "eye_offset_mm": eye_mm,
                    "bearing_deg": math.degrees(math.atan2(eye_mm, plan["distance_mm"])),
                    "shift_x": shift,
                }
            )
    finally:
        scene.camera = previous_camera
        scene.render.filepath = previous_path
        scene.render.image_settings.file_format = previous_format
        (
            scene.render.resolution_x,
            scene.render.resolution_y,
            scene.render.resolution_percentage,
        ) = previous_res

    manifest = {
        "generated_by": "docs/blender_stereo_views.py",
        "wire_into": "Lenticular Print | Frames (in file order)",
        "settings": {k: v for k, v in s.items() if k != "out"},
        "solved": {k: v for k, v in plan.items() if k != "warnings"},
        "warnings": plan["warnings"],
        "views": written,
    }
    with open(os.path.join(out_dir, "stereo-views.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    return written


# --------------------------------------------------------------------------
# Entry points.
# --------------------------------------------------------------------------


def parse_args(argv: list[str]) -> dict:
    """Settings from the command line, over the SETTINGS defaults."""
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--selftest", action="store_true", help="check the optics; no Blender needed")
    p.add_argument("--out", default=SETTINGS["out"])
    p.add_argument("--file-prefix", default=SETTINGS["file_prefix"])
    p.add_argument("--views", type=int, default=SETTINGS["views"])
    p.add_argument("--width-mm", type=float, default=SETTINGS["width_mm"])
    p.add_argument("--height-mm", type=float, default=SETTINGS["height_mm"])
    p.add_argument("--distance-mm", type=float, default=SETTINGS["distance_mm"])
    p.add_argument("--depth-mm", type=float, default=SETTINGS["depth_mm"])
    p.add_argument("--setback-mm", type=float, default=SETTINGS["setback_mm"])
    p.add_argument("--lpi", type=float, default=SETTINGS["lpi"])
    p.add_argument("--gloss-height-mm", type=float, default=SETTINGS["gloss_height_mm"])
    p.add_argument("--ri", type=float, default=SETTINGS["ri"])
    p.add_argument("--cone-deg", type=float, default=SETTINGS["cone_deg"])
    p.add_argument("--units-per-mm", type=float, default=SETTINGS["units_per_mm"])
    p.add_argument("--render-width", type=int, default=SETTINGS["render_width"])
    p.add_argument("--supersample", type=int, default=SETTINGS["supersample"])
    p.add_argument("--no-mirror", dest="mirror_views", action="store_false", default=SETTINGS["mirror_views"])
    p.add_argument(
        "--fit",
        dest="fit",
        action="store_true",
        default=SETTINGS["fit"],
        help="move and scale the window to frame the subject (never touches the subject itself)",
    )
    p.add_argument("--no-fit", dest="fit", action="store_false", help="leave the window exactly where it is")
    p.add_argument("--dry-run", action="store_true", help="solve and report, render nothing")
    args = p.parse_args(argv)
    s = dict(SETTINGS)
    s.update({k: v for k, v in vars(args).items() if k not in ("selftest", "dry_run")})
    return s, args


def selftest() -> None:
    """Check the optics against the figures the TypeScript is tested against."""
    close = lambda a, b, tol=1e-3: abs(a - b) <= tol  # noqa: E731

    lens = lens_geometry(45, 0.9, 1.5)
    assert close(lens["pitch_mm"], 0.5644), lens["pitch_mm"]
    assert close(lens["view_angle_deg"], 53.3, 0.1), lens["view_angle_deg"]
    assert lens["feasible"]

    # Below the feasibility floor the solve falls back to a hemisphere.
    assert not lens_geometry(20, 0.9, 1.5)["feasible"]

    # The run spans the whole cone, symmetrically, tan-spaced.
    offsets = eye_offsets_mm(5, 53.3, 400)
    assert close(offsets[2], 0.0)
    assert close(offsets[0], -offsets[4])
    assert close(offsets[4], math.tan(math.radians(53.3) / 2) * 400)

    # Behind the window is the gentler side.
    behind = disparity_at_depth(30, -10, 400, 45)["mm"]
    front = disparity_at_depth(30, 10, 400, 45)["mm"]
    assert close(behind, 30 * 10 / 410, 1e-9) and close(front, 30 * 10 / 390, 1e-9)
    assert behind < front

    # A subject at the glass needs no scaling; one 100 mm back needs 500/400.
    assert close(window_fit_scale(400, 0), 1.0)
    assert close(window_fit_scale(400, 100), 1.25)

    # The shift calibration solves from two probes instead of trusting a sign
    # convention, so check the algebra against both — and against a Blender
    # that scaled shift differently, which is the other thing that could
    # change under us. Every case must land the window edge on the frame edge.
    for sign in (1.0, -1.0):
        for gain in (1.0, 2.0):
            for eye_term in (-0.5, 0.0, 0.37):
                probe = lambda shift: (1.0 + eye_term) + sign * gain * shift  # noqa: E731
                at_zero = probe(0.0)
                slope = probe(0.1) - at_zero
                shift = (1.0 - at_zero) * 0.1 / slope
                assert close(probe(shift), 1.0, 1e-12), (sign, gain, eye_term)

    # The tool's stereo example: 12 views, 6 mm deep, against the glass. The
    # node reports 1.07 lenticules per step for this, and so must this.
    plan = solve({**SETTINGS, "views": 12, "depth_mm": 6.0, "setback_mm": 0.0})
    assert close(plan["parallax_per_step"]["lenticules"], 1.07, 0.01), plan["parallax_per_step"]
    assert not plan["warnings"], plan["warnings"]

    # Too deep a box ghosts, and says so.
    deep = solve({**SETTINGS, "views": 12, "depth_mm": 60.0})
    assert any("ghost" in w for w in deep["warnings"]), deep["warnings"]
    # Too shallow reads flat, and says that.
    flat = solve({**SETTINGS, "views": 12, "depth_mm": 0.2})
    assert any("flat" in w for w in flat["warnings"]), flat["warnings"]

    print("selftest: optics OK")
    print()
    print(report(plan, SETTINGS))


def main() -> None:
    # Blender passes everything after a bare `--` to the script.
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    s, args = parse_args(argv)

    if args.selftest:
        selftest()
        return

    plan = solve(s)
    print(report(plan, s))
    if args.dry_run:
        return

    try:
        import bpy  # noqa: F401
    except ImportError:
        sys.exit(
            "\nThis needs to run inside Blender:\n"
            "  blender scene.blend --background --python docs/blender_stereo_views.py -- --out ./views\n"
            "Or check the optics without it:  python docs/blender_stereo_views.py --selftest"
        )

    written = render_views(plan, s)
    print(f"\nWrote {len(written)} views to {os.path.abspath(s['out'])}")
    print("Wire them into Lenticular Print's Frames input in file order.")


if __name__ == "__main__":
    main()
