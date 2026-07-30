// Per-node help: what a node is for, and concrete things people actually build
// with it. The node's own `description` is the terse one-liner shown on the
// canvas; this is the longer answer behind the ? button.
//
// Every registered node type must have an entry — `nodeHelp.test.ts` fails the
// build if a new node ships without one, because a node nobody can explain is a
// node nobody uses. `helpFor()` still degrades gracefully at runtime so an
// unknown/plugin node opens a useful window instead of nothing.

import type { NodeDefinition } from '../types';

export interface NodeUse {
  /** Short name of the thing you would build. */
  title: string;
  detail: string;
  /** The node chain that does it, rendered as A → B → C. */
  chain?: string[];
}

export interface NodeHelp {
  /** A fuller answer to "what is this?" than the node's own description. */
  summary: string;
  uses: NodeUse[];
  tips?: string[];
}

// ---------------------------------------------------------------------------
// Shared help for the AI families — the individual models differ in quality,
// speed and price, not in what you wire them to, so the wiring advice is
// written once and each model adds its own summary.
// ---------------------------------------------------------------------------

const textToImage = (summary: string, tips?: string[]): NodeHelp => ({
  summary,
  uses: [
    {
      title: 'Source art for a gloss print',
      detail: 'Generate the artwork, then derive the varnish layer from it instead of hand-painting a mask.',
      chain: ['Prompt Input', 'this node', 'Highlight Extract', 'Auto Threshold', 'Gloss Preview'],
    },
    {
      title: 'Lenticular frames from one prompt',
      detail:
        'Run the node twice with slightly different prompts (or seeds) and wire both results into a Lenticular Print to get a flip.',
      chain: ['Prompt Input', 'this node ×2', 'Lenticular Print'],
    },
  ],
  tips: [
    'Manual node: it only runs when you press Run ▶, so a stray edit never spends credits.',
    ...(tips ?? []),
  ],
});

const imageToImage = (summary: string, uses: NodeUse[]): NodeHelp => ({
  summary,
  uses,
  tips: ['Manual node: press Run ▶. Results are cached, so re-running with identical inputs is free.'],
});

const vlm = (summary: string): NodeHelp => ({
  summary,
  uses: [
    {
      title: 'Describe art before generating a matching prompt',
      detail: 'Caption an uploaded image, then feed the text into an LLM node to rewrite it as a prompt.',
      chain: ['Image Input', 'this node', 'Claude 3.5 Haiku', 'Flux Dev'],
    },
    {
      title: 'Sanity-check a batch',
      detail: 'Ask what is actually in the frame before you commit it to a print run.',
    },
  ],
  tips: ['Manual node: press Run ▶.'],
});

const llm = (summary: string): NodeHelp => ({
  summary,
  uses: [
    {
      title: 'Prompt expansion',
      detail:
        'Turn a short brief ("art-deco peacock, gold") into a full image prompt, then wire it into a generator.',
      chain: ['Prompt Input', 'this node', 'Flux Dev'],
    },
    {
      title: 'Rewrite a caption into a style variant',
      detail:
        'Caption an image, ask for the same scene "at night", and generate the second lenticular frame.',
      chain: ['Image Caption (BLIP)', 'this node', 'SDXL', 'Lenticular Print'],
    },
  ],
  tips: ['Needs an OpenRouter key (Settings), not the Replicate one.'],
});

// ---------------------------------------------------------------------------

export const NODE_HELP: Record<string, NodeHelp> = {
  // ---- Input ----
  imageInput: {
    summary:
      'The way your own artwork gets into a graph. The file is stored out-of-band (IndexedDB) and only a short reference is kept in the saved workflow, so big uploads do not blow the local-storage budget.',
    uses: [
      {
        title: 'Prepare a photo for a spot-gloss print',
        detail: 'Upload the art once and branch it: one path stays the print, the other becomes the varnish.',
        chain: ['Image Input', 'Highlight Extract', 'Auto Threshold', 'Gloss Preview'],
      },
      {
        title: 'Work at a sane resolution',
        detail:
          'Set Max size to 1024 while you build the graph, then set it back to 0 for the final full-resolution run.',
      },
    ],
    tips: ['Max size 0 keeps the original pixels. Every downstream node inherits whatever you set here.'],
  },
  animationInput: {
    summary:
      'Decodes an animated GIF, WebP or APNG into its frames and hands them onward as one Sequence value, so a whole animation travels on a single wire.',
    uses: [
      {
        title: 'Print an animation as a lenticular',
        detail:
          'Drop the Frames output on a Lenticular Print: the frames expand in place, and tilting the finished sheet plays the animation and repeats it.',
        chain: ['Animation Input', 'Lenticular Print'],
      },
      {
        title: 'Retime a busy GIF for print',
        detail:
          'A 47-frame GIF cannot fit under a lenticule. Set Frames to 8 and the node resamples the motion evenly across the loop.',
      },
      {
        title: 'Grade the whole animation at once',
        detail:
          'Wire the Sequence straight into any image node — Curves, Blur, Combine — and it runs once per frame, handing back the whole animation with its timings intact.',
        chain: ['Animation Input', 'Curves', 'Gloss Preview'],
      },
      {
        title: 'Grab a single frame to work on',
        detail:
          'Send the Sequence into Sequence Frame to pull out frame 0 and treat it like any other image.',
        chain: ['Animation Input', 'Sequence Frame', 'Curves'],
      },
    ],
    tips: [
      'A still wired alongside the animation is reused for every frame, which is how one overlay composites onto a whole GIF through Combine or Apply Mask.',
      'Frames must fit one lenticule: PPI ÷ LPI ÷ strip samples (32 at 1440 PPI / 45 LPI). The Info output does the arithmetic and warns you.',
      'Ping-pong makes tilting back play the motion in reverse, so the print never snaps — use it unless the source loops seamlessly.',
      'GIF decodes in every browser; WebP/APNG need a browser with WebCodecs, otherwise you get the first frame only.',
    ],
  },
  frameSelect: {
    summary:
      'Takes one frame out of a Sequence as an ordinary image, for when you want a still rather than the whole run — an image node fed the Sequence itself maps over every frame instead.',
    uses: [
      {
        title: 'Colour-grade a GIF frame',
        detail: 'Pull a frame, run it through the adjust chain, and use it as a still.',
        chain: ['Animation Input', 'Sequence Frame', 'Levels', 'Gloss Preview'],
      },
      {
        title: 'Build a two-frame flip by hand',
        detail:
          'Take frame 0 and frame -1 of a GIF and wire both into a Lenticular Print for a first/last flip instead of the whole loop.',
        chain: ['Animation Input', 'Sequence Frame ×2', 'Lenticular Print'],
      },
    ],
    tips: ['-1 is the last frame, -2 the one before it; anything out of range clamps to the ends.'],
  },
  promptInput: {
    summary: 'A block of text as a graph value: prompts, negative prompts, or anything a node reads as text.',
    uses: [
      {
        title: 'Drive a generator',
        detail: 'One prompt node can feed several models at once, so you can compare them side by side.',
        chain: ['Prompt Input', 'Flux Schnell + SDXL', 'A/B Compare'],
      },
      {
        title: 'Name what to segment',
        detail: 'Grounded SAM masks whatever the text describes — "the neon sign", "the dog".',
        chain: ['Prompt Input', 'Grounded SAM', 'Apply Mask'],
      },
    ],
  },
  solidColor: {
    summary: 'A flat colour image of any size — the simplest source there is.',
    uses: [
      {
        title: 'Background to flatten onto',
        detail: 'Give a cut-out subject an opaque backdrop before printing.',
        chain: ['Remove Colour', 'Combine (over)', 'Solid Colour'],
      },
      {
        title: 'Full-coverage gloss',
        detail: 'A pure white mask varnishes everything — useful to test the printer, not the design.',
        chain: ['Solid Colour', 'Gloss Preview'],
      },
    ],
  },
  gradient: {
    summary: 'A linear two-colour ramp, horizontal or vertical.',
    uses: [
      {
        title: 'Heightmap for a wedge',
        detail: 'Black-to-white ramps become sloped solids, handy for testing a printer profile.',
        chain: ['Gradient', 'Heightmap → STL'],
      },
      {
        title: 'Falloff mask',
        detail: 'Multiply a gradient into a mask so the varnish fades out towards one edge.',
        chain: ['Gradient', 'Combine (multiply)', 'Gloss Preview'],
      },
    ],
  },
  radialGradient: {
    summary:
      'Circular ramps in three flavours: radial (centre outwards), ring (a band with a feathered edge) and conic (one sweep around the centre).',
    uses: [
      {
        title: 'Loading spinner',
        detail: 'Multiply a ring by a conic: the ring gives the track, the conic the sweep.',
        chain: ['Radial Gradient (ring)', 'Combine (multiply)', 'Radial Gradient (conic)'],
      },
      {
        title: 'Spotlight vignette',
        detail:
          'A soft radial multiplied into art darkens the edges without the Vignette node’s fixed shape.',
      },
      {
        title: 'Lenticular frames',
        detail: 'Four conics at 0°, 90°, 180° and 270° make a four-state spinner that animates as you tilt.',
        chain: ['Radial Gradient ×4', 'Lenticular Print'],
      },
    ],
  },
  noise: {
    summary: 'Seeded value noise — a repeatable procedural greyscale texture.',
    uses: [
      {
        title: 'Surface relief',
        detail: 'Blur the noise, convert to a normal map, and you have a fabric/plaster micro-texture.',
        chain: ['Noise', 'Box Blur', 'Normal Map'],
      },
      {
        title: 'Break up a flat varnish',
        detail: 'Multiply light noise into a gloss mask so a large varnished area reads as textured.',
      },
    ],
    tips: ['Same seed = same texture, so a saved workflow reproduces exactly.'],
  },

  // ---- Compose ----
  combine: {
    summary: 'Blends two images with a chosen mode (over, multiply, screen, add, difference…).',
    uses: [
      {
        title: 'Stack a mask onto art',
        detail: 'Multiply is how you restrict one signal by another — art × mask keeps only the masked part.',
      },
      {
        title: 'Composite a cut-out',
        detail: 'Over places a transparent subject on a new background.',
        chain: ['Solid Colour', 'Combine (over)', 'BiRefNet'],
      },
    ],
    tips: ['A is the base, B the layer on top. Swap the wires if the result looks inverted.'],
  },
  compare: {
    summary: 'A split view of two images — half A, half B — so you can see what a step actually changed.',
    uses: [
      {
        title: 'Judge an upscale',
        detail: 'Original on the left, Real-ESRGAN result on the right, at the same scale.',
        chain: ['Image Input', 'Real-ESRGAN upscale', 'A/B Compare'],
      },
      {
        title: 'Tune a threshold',
        detail: 'Compare the gloss mask against the art to check it lands on the right features.',
      },
    ],
  },
  flatten: {
    summary: 'Composites the image onto a solid colour, removing transparency.',
    uses: [
      {
        title: 'Prepare for print',
        detail: 'Printers want opaque pixels; flatten onto white before exporting.',
      },
      {
        title: 'See what a mask really covers',
        detail: 'Flatten a semi-transparent result onto magenta to spot stray soft edges.',
      },
    ],
  },
  placeImage: {
    summary:
      'Composites an overlay onto a base at given coordinates and size — the counterpart to Split Region.',
    uses: [
      {
        title: 'Process one region and put it back',
        detail:
          'Cut a face out, restore it with GFPGAN, and drop it back exactly where it came from by wiring Coords across.',
        chain: ['Split Region', 'GFPGAN face restore', 'Place Image'],
      },
      {
        title: 'Stamp a logo',
        detail: 'Set x/y/width/height by hand to place a badge in a corner.',
      },
    ],
    tips: ['A wired Coords input wins over the manual x/y/width/height fields.'],
  },

  // ---- Mask ----
  applyMask: {
    summary: "Uses a mask's luminance as the image's alpha: white keeps, black cuts away.",
    uses: [
      {
        title: 'Cut out a segmented subject',
        detail: 'Turn any mask-producing node into a real cut-out.',
        chain: ['Grounded SAM', 'Apply Mask', 'Flatten'],
      },
      {
        title: 'Fade with a gradient',
        detail: 'A gradient as the mask gives a soft dissolve instead of a hard edge.',
      },
    ],
  },
  extractChannel: {
    summary: 'Pulls one channel (R, G, B, A or luminance) out as a greyscale image.',
    uses: [
      {
        title: 'Alpha as a mask',
        detail: 'Recover the cut-out shape of a transparent PNG so you can varnish exactly the subject.',
        chain: ['Image Input', 'Extract Channel (alpha)', 'Gloss Preview'],
      },
      {
        title: 'Unpack a packed texture',
        detail: 'Read back a roughness/metallic/AO map channel by channel.',
      },
    ],
  },
  highlightExtract: {
    summary:
      'Finds painted speculars — pixels that are locally bright *and* desaturated — and outputs them as a greyscale gloss signal. It looks for where the artist put a glint, not simply for what is white.',
    uses: [
      {
        title: 'Varnish the highlights an illustrator painted',
        detail: 'The core of the spot-gloss recipe: extract, clean, threshold, preview.',
        chain: ['Image Input', 'Highlight Extract', 'Box Blur', 'Auto Threshold', 'Despeckle'],
      },
      {
        title: 'Gloss on metal and glass',
        detail: 'Product shots respond well — chrome and glass are exactly locally-bright and unsaturated.',
      },
    ],
    tips: [
      'A big radius keeps whole white skies and paper backgrounds out of the mask; a small one picks up fine glints.',
      'Saturation rejection is what stops a bright red from counting as a highlight.',
    ],
  },
  chromaKey: {
    summary: 'Builds a mask of every pixel within tolerance of a target colour.',
    uses: [
      {
        title: 'Key a studio background',
        detail: 'Mask the green screen, invert it, and you have the subject.',
        chain: ['Chroma Key', 'Invert', 'Apply Mask'],
      },
      {
        title: 'Select a flat brand colour',
        detail: 'Varnish only the logo’s red by masking that exact colour.',
      },
    ],
  },
  removeColor: {
    summary: 'Makes pixels near a colour transparent, in place — a local background key-out.',
    uses: [
      {
        title: 'Drop a white paper background',
        detail: 'Cheaper and more predictable than an AI background remover for flat scans.',
      },
      {
        title: 'Clean an AI result',
        detail: 'Generators often leave a near-white halo; keying it out tightens the cut-out.',
      },
    ],
    tips: ['Raise tolerance until the background goes, then use Alpha Cleanup to snap the leftovers.'],
  },
  maskCombine: {
    summary: 'Boolean algebra on two masks: AND, OR, subtract, XOR.',
    uses: [
      {
        title: 'Everything except the face',
        detail: 'Subtract a face mask from a subject mask so the varnish skips skin.',
        chain: ['BiRefNet', 'Combine Masks (subtract)', 'Grounded SAM'],
      },
      {
        title: 'Union of hand-drawn selections',
        detail: 'OR an Area Picker mask together with a chroma key.',
      },
    ],
  },
  dilate: {
    summary: 'Grows bright regions by a radius (greyscale dilation).',
    uses: [
      {
        title: 'Spread a varnish mask',
        detail: 'Give the gloss a little overlap so registration error does not show as a white fringe.',
      },
      {
        title: 'Close a gappy edge',
        detail: 'Dilate then erode (or use Open / Close) to bridge broken outlines.',
      },
    ],
  },
  erode: {
    summary: 'Shrinks bright regions by a radius (greyscale erosion).',
    uses: [
      {
        title: 'Choke the gloss',
        detail: 'Pull the varnish in from the artwork edge so it never bleeds past the printed shape.',
        chain: ['Auto Threshold', 'Erode', 'Gloss Preview'],
      },
      {
        title: 'Drop thin noise',
        detail: 'Erode away one-pixel spurs before a despeckle pass.',
      },
    ],
  },
  openClose: {
    summary:
      'Morphological open (erode then dilate — removes bright specks) or close (dilate then erode — fills dark pinholes), in one step.',
    uses: [
      {
        title: 'Seal a gloss shape',
        detail: 'Close fills the pinholes a threshold left inside a solid area, without moving its outline.',
      },
      {
        title: 'Kill sensor noise in a mask',
        detail: 'Open removes isolated white specks that would print as varnish dust.',
      },
    ],
  },
  despeckle: {
    summary:
      'Enforces a minimum feature size: white islands under Min area are dropped and enclosed holes under Min hole area are filled. Outputs a clean black-and-white mask.',
    uses: [
      {
        title: 'Make a mask printable',
        detail:
          'A varnish head cannot resolve a 2-pixel dot. Set Min area to the smallest feature your printer can actually lay down.',
        chain: ['Auto Threshold', 'Despeckle', 'Gloss Preview'],
      },
      {
        title: 'Tidy a segmentation',
        detail: 'AI masks come with stray fragments; this is the cheapest way to remove them.',
      },
    ],
  },
  areaPicker: {
    summary:
      'A hand-drawn mask: magic-wand clicks, rectangles and ellipses, all unioned. Open the editor to draw on the image.',
    uses: [
      {
        title: 'Varnish exactly one object',
        detail: 'When no model segments what you mean, click it yourself.',
        chain: ['Image Input', 'Area Picker', 'Apply Mask'],
      },
      {
        title: 'Protect a region',
        detail: 'Draw the area to keep, then subtract it from a generated mask.',
        chain: ['Area Picker', 'Combine Masks (subtract)'],
      },
    ],
    tips: ['Tolerance controls how far the magic wand floods from each click.'],
  },

  // ---- Adjust ----
  invert: {
    summary: 'Inverts the channels you tick — RGB, or alpha on its own.',
    uses: [
      {
        title: 'Flip a mask',
        detail: 'The fastest way to turn "the subject" into "everything but the subject".',
        chain: ['Chroma Key', 'Invert', 'Apply Mask'],
      },
      {
        title: 'Flip a heightmap',
        detail: 'Heightmaps expect white = tall; invert when your source has it the other way round.',
      },
    ],
    tips: ['Untick alpha unless you actually mean to invert transparency.'],
  },
  grayscale: {
    summary: 'Desaturates to luminance-weighted greyscale.',
    uses: [
      {
        title: 'Get a heightmap out of art',
        detail: 'Most height/gloss chains want a single channel; greyscale is step one.',
        chain: ['Image Input', 'Greyscale', 'Levels', 'Heightmap → STL'],
      },
      {
        title: 'Judge tonal balance',
        detail: 'Colour hides contrast problems — greyscale exposes them.',
      },
    ],
  },
  brightnessContrast: {
    summary: 'Straight brightness and contrast adjustment.',
    uses: [
      {
        title: 'Rescue a flat scan',
        detail: 'Add contrast before thresholding so the mask has something to bite on.',
      },
      {
        title: 'Dial a gloss signal up',
        detail: 'Brighten a weak highlight extraction rather than lowering the threshold.',
      },
    ],
  },
  threshold: {
    summary: 'Binarises by luminance at a level you choose: everything is black or white.',
    uses: [
      {
        title: 'Hard gloss mask',
        detail: 'Varnish is on or off — the mask has to be binary eventually.',
      },
      {
        title: 'Stencil / cut file',
        detail: 'Threshold, despeckle, and you have a shape ready for a cutter.',
      },
    ],
    tips: ['If the right level differs per image, use Auto Threshold instead.'],
  },
  autoThreshold: {
    summary:
      'Picks the binarisation level from the histogram itself — Otsu’s valley, or the brightest N% — so it holds up across dark and pale artwork.',
    uses: [
      {
        title: 'Gloss coverage by percentage',
        detail: 'Brightest-20% gives roughly 20% coverage on any image, which is the printable range.',
        chain: ['Highlight Extract', 'Auto Threshold', 'Despeckle', 'Gloss Preview'],
      },
      {
        title: 'Dark-luxury varnish',
        detail: 'Invert the result to gloss the shadows instead of the highlights.',
      },
    ],
  },
  blur: {
    summary: 'Box blur by pixel radius.',
    uses: [
      {
        title: 'Smooth a heightmap',
        detail: 'Blurring before an STL export removes the stair-stepping that quantised tones cause.',
      },
      {
        title: 'Stabilise a mask',
        detail: 'A small blur before thresholding stops the edge from breaking into speckle.',
      },
    ],
  },
  sharpen: {
    summary: 'Unsharp-mask sharpening.',
    uses: [
      {
        title: 'Recover detail after upscaling',
        detail: 'A light pass restores the bite a resize took out.',
      },
      {
        title: 'Strengthen edges before edge detection',
        detail: 'Sharper input, cleaner Sobel result, better ControlNet guidance.',
      },
    ],
  },
  normalize: {
    summary: 'Stretches each channel to the full 0–255 range (auto contrast).',
    uses: [
      {
        title: 'Use the whole depth range',
        detail: 'A depth map that only spans 60–190 wastes most of the STL height; normalising fixes it.',
        chain: ['Depth Anything v2', 'Auto Contrast', 'Heightmap → STL'],
      },
      {
        title: 'Even out a batch',
        detail: 'Normalise before thresholding so one level works across images.',
      },
    ],
  },
  histogram: {
    summary: 'A scope, not a filter: draws the RGB value distribution so you can see the tonal range.',
    uses: [
      {
        title: 'Choose a threshold level',
        detail: 'Look for the valley between the two humps, then set Threshold there.',
      },
      {
        title: 'Spot clipping',
        detail: 'Spikes at 0 or 255 mean crushed shadows or blown highlights.',
      },
    ],
  },
  curves: {
    summary: 'Tone remapping with a draggable curve, per channel or on RGB together.',
    uses: [
      {
        title: 'Shape a height profile',
        detail: 'An S-curve pushes the relief into the midtones so the print reads better.',
      },
      {
        title: 'Colour grade',
        detail: 'Lift the blue shadows and drop the red highlights for a cool look.',
      },
    ],
    tips: ['Open the editor to drag points; the inline field only picks which channel you are editing.'],
  },
  opacity: {
    summary: 'Scales alpha to fade the whole image.',
    uses: [
      {
        title: 'Blend a layer back',
        detail: 'Fade a stylised version over the original for a partial effect.',
        chain: ['Style Transfer', 'Opacity', 'Combine (over)'],
      },
      {
        title: 'Soften a mask',
        detail: 'Half-strength alpha becomes half-strength varnish in the preview.',
      },
    ],
  },
  tint: {
    summary: 'Multiplies the image by a colour.',
    uses: [
      {
        title: 'Brand a greyscale asset',
        detail: 'Tint a white logo to the house colour without leaving the graph.',
      },
      {
        title: 'Warm a cold render',
        detail: 'A pale amber tint is a one-node grade.',
      },
    ],
  },
  levels: {
    summary: 'Black point, white point and midtone gamma — the precise version of brightness/contrast.',
    uses: [
      {
        title: 'Set the printable range of a heightmap',
        detail: 'Clamp black and white so nothing is below the base or above the varnish stack.',
      },
      {
        title: 'Recover a washed-out photo',
        detail: 'Pull the white point down to where the histogram actually ends.',
      },
    ],
  },
  gradientMap: {
    summary: 'Maps luminance onto a two-colour gradient.',
    uses: [
      {
        title: 'False-colour a depth map',
        detail: 'Near/far read instantly in colour, which greyscale hides.',
      },
      {
        title: 'Duotone artwork',
        detail: 'A classic print look in one node.',
      },
    ],
  },
  hueSaturation: {
    summary: 'Rotates hue and scales saturation.',
    uses: [
      {
        title: 'Recolour a product shot',
        detail: 'Shift hue for a colourway variant without regenerating anything.',
      },
      {
        title: 'Boost before a chroma key',
        detail: 'A more saturated background keys more cleanly.',
      },
    ],
  },
  whiteBalance: {
    summary: 'Shifts colour temperature (warm/cool) and green/magenta tint.',
    uses: [
      {
        title: 'Fix a yellow indoor photo',
        detail: 'Cool it down before anything else in the chain judges colour.',
      },
      {
        title: 'Match two lenticular frames',
        detail: 'Frames that differ in white balance flicker as you tilt; match them first.',
      },
    ],
  },
  edgeDetect: {
    summary: 'Sobel edge detection — white edges on black.',
    uses: [
      {
        title: 'ControlNet input',
        detail: 'Edges are exactly what a structure-guided generator wants.',
        chain: ['Image Input', 'Edge Detect', 'Flux ControlNet (Canny)'],
      },
      {
        title: 'Line-art varnish',
        detail: 'Gloss only the outlines for a subtle, very legible print effect.',
      },
    ],
  },
  pixelate: {
    summary: 'Mosaic/blocky pixelation by block size.',
    uses: [
      {
        title: 'Anonymise a region',
        detail: 'Cut the region out, pixelate it, put it back.',
        chain: ['Split Region', 'Pixelate', 'Place Image'],
      },
      {
        title: 'Deliberately coarse gloss',
        detail: 'Big blocks make a varnish pattern that survives a low-resolution head.',
      },
    ],
  },
  vignette: {
    summary: 'Darkens towards the corners.',
    uses: [
      { title: 'Focus attention', detail: 'The oldest trick for pulling the eye to the centre.' },
      {
        title: 'Fade a gloss mask at the edges',
        detail: 'Vignette the mask, not the art, so varnish thins out at the border.',
      },
    ],
  },
  posterize: {
    summary: 'Reduces each channel to a limited number of levels.',
    uses: [
      {
        title: 'Stepped relief',
        detail: 'Discrete levels become discrete varnish heights — a terraced, deliberate look.',
        chain: ['Greyscale', 'Posterize', 'Heightmap → STL'],
      },
      {
        title: 'Screen-print look',
        detail: 'Few colours, hard boundaries.',
      },
    ],
  },
  outline: {
    summary: 'Draws a coloured outline around non-transparent pixels.',
    uses: [
      {
        title: 'Sticker border',
        detail: 'The white keyline that makes a cut-out read as a sticker.',
        chain: ['BiRefNet', 'Outline', 'Flatten'],
      },
      {
        title: 'Register check',
        detail: 'Outline a cut-out to see exactly where its alpha edge falls.',
      },
    ],
  },
  alphaCleanup: {
    summary: 'Snaps pixels below an alpha threshold to fully transparent, black or white.',
    uses: [
      {
        title: 'Kill halo after background removal',
        detail: 'Removes the 5%-alpha fringe that prints as grey dirt.',
        chain: ['Bria RMBG 2.0', 'Alpha Cleanup'],
      },
      {
        title: 'Force a binary mask',
        detail: 'Guarantees the varnish layer has no partial coverage.',
      },
    ],
  },

  // ---- Transform ----
  crop: {
    summary: 'Crops a rectangle by numbers.',
    uses: [
      { title: 'Trim to the print area', detail: 'Cut the sheet down to what actually goes on press.' },
      { title: 'Remove a watermark strip', detail: 'Crop the bottom band off a generated image.' },
    ],
    tips: ['To pick the rectangle visually — and to put the region back later — use Split Region instead.'],
  },
  splitRegion: {
    summary:
      'Cuts a rectangle out as its own image *and* emits its coordinates, so a processed region can be dropped back exactly where it came from. Open the editor to drag the region on the image.',
    uses: [
      {
        title: 'Fix one face in a group photo',
        detail: 'Cut it out, restore it, place it back — the rest of the image is untouched.',
        chain: ['Split Region', 'CodeFormer face restore', 'Place Image'],
      },
      {
        title: 'Spend AI credits on a crop',
        detail: 'Upscale a 512 px region instead of a 4000 px sheet.',
      },
    ],
    tips: ['Always wire Coords into Place Image — that is what makes the round trip exact.'],
  },
  resize: {
    summary: 'Resize by a scale multiplier or to an exact width/height, with a choice of sampling.',
    uses: [
      {
        title: 'Match lenticular frames',
        detail: 'Frames of different sizes interlace badly; resize them all to one size first.',
      },
      {
        title: 'Keep AI costs down',
        detail: 'Downscale before a manual node, upscale the result afterwards.',
      },
    ],
  },
  rotateAngle: {
    summary: 'Rotates by an arbitrary angle, expanding the canvas and sampling bilinearly.',
    uses: [
      { title: 'Straighten a scan', detail: 'A degree or two of correction before cropping.' },
      {
        title: 'Angle a lens array',
        detail: 'Rotate the artwork instead of the lenticules when a print has to be read on the diagonal.',
      },
    ],
    tips: ['For exact 90° turns and flips use Rotate / Flip — it is lossless.'],
  },
  transform: {
    summary: 'Lossless 90° rotations and flips.',
    uses: [
      { title: 'Portrait to landscape', detail: 'Turn a sheet without resampling a single pixel.' },
      {
        title: 'Mirror a lenticular view',
        detail: 'Flip one frame to make a symmetric flip effect.',
      },
    ],
  },
  pad: {
    summary: 'Extends the canvas with a transparent border.',
    uses: [
      {
        title: 'Room to outpaint',
        detail: 'Give Flux Fill empty space to invent into.',
        chain: ['Pad', 'Flux Fill'],
      },
      { title: 'Bleed for print', detail: 'Add margin so trimming never cuts into the artwork.' },
    ],
  },

  // ---- UV ----
  normalMap: {
    summary: 'Converts a heightmap into a tangent-space normal map (white = high, OpenGL +Y).',
    uses: [
      {
        title: 'Material for a 3D renderer',
        detail: 'Noise → blur → normal map is a complete micro-surface in three nodes.',
        chain: ['Noise', 'Box Blur', 'Normal Map'],
      },
      {
        title: 'Preview relief without printing',
        detail: 'Feed it to a renderer to see how a varnish height will catch light.',
      },
    ],
  },
  glossPreview: {
    summary:
      'Simulates a spot-gloss (varnish) print: shiny where the mask is on, matte elsewhere, with relief if a heightmap is wired. Reports coverage percentage, and opens an interactive 3D view.',
    uses: [
      {
        title: 'Sign off a varnish layer before printing',
        detail: 'The end of the spot-gloss recipe — this is what you show the client.',
        chain: ['Image Input', 'Highlight Extract', 'Auto Threshold', 'Despeckle', 'Gloss Preview'],
      },
      {
        title: 'Tune the light',
        detail:
          'Sweep azimuth and elevation to check the gloss reads from the angle the print will be viewed.',
      },
    ],
    tips: [
      'Coverage of 5–30% is the usual printable range; much more and the varnish stops reading as an accent.',
    ],
  },
  channelPack: {
    summary: 'Packs up to four greyscale inputs into R, G, B and A of one image.',
    uses: [
      {
        title: 'ORM / RMA texture',
        detail: 'Pack occlusion, roughness and metallic into one file for a game engine.',
      },
      {
        title: 'Ship a mask alongside art',
        detail: 'Hide the gloss mask in the alpha channel of the artwork.',
      },
    ],
  },
  seamlessTile: {
    summary: 'Blends the borders so the texture repeats without a visible seam.',
    uses: [
      {
        title: 'Tileable material',
        detail: 'Noise is already repeatable, but photographed textures need this.',
        chain: ['Image Input', 'Seamless Tile', 'Normal Map'],
      },
      {
        title: 'Repeating varnish pattern',
        detail: 'A tiling gloss texture that covers a whole sheet without an obvious join.',
      },
    ],
  },
  lenticular: {
    summary:
      'The full lenticular pipeline in one node: it interlaces your frames into strips and generates the gloss depth map that *is* the lens array focusing on them. Tilt the finished print and the frames swap.',
    uses: [
      {
        title: 'Two-frame flip',
        detail:
          'Wire two images into Frames (in viewing order) and print the interlaced sheet with the depth map as the varnish layer.',
        chain: ['Image A + Image B', 'Lenticular Print'],
      },
      {
        title: 'Print a whole animation',
        detail:
          'One Animation Input carries every frame on a single wire; the animation plays across the viewing angle and repeats as you tilt.',
        chain: ['Animation Input', 'Lenticular Print'],
      },
      {
        title: 'Calibrate a new varnish',
        detail:
          'The editor prints Height, RI and LPI sweep sheets, each with a black/white switch target, so you can measure what your press actually does before committing a real job.',
      },
    ],
    tips: [
      'Frames must fit one lenticule: PPI ÷ LPI ÷ strip samples. At 1440 PPI and 45 LPI that is 32 frames at one sample each.',
      'The depth map is on the PPI raster (it is the lens); the interlaced artwork ships at the smallest raster that keeps the interlace — scale it to the sheet at print time.',
      'Manual node: a 100 mm sheet at 1440 PPI is a ~32 MP render, so it only runs when you press Run ▶.',
    ],
  },
  lensGrid: {
    summary:
      'The 2D sibling of Lenticular Print: rows *and* columns of lenslets, so the image moves left/right and up/down. A grid of N gives N² views, and the input ports appear and disappear with the grid setting.',
    uses: [
      {
        title: 'Look-around portrait',
        detail:
          'Nine views of a face rendered from slightly different angles gives real head-tracking parallax.',
      },
      {
        title: 'Four-state indicator',
        detail: 'A 2×2 grid switches on both axes — a status tile that changes as you move around it.',
      },
    ],
    tips: [
      'Each view resolves to a single pixel per lenslet, so views cost resolution fast — start at grid 2 or 3.',
      'Ports are named for where the view is seen from: Left · Up, Centre (neutral), Right · Down.',
      'Hexagonal packing (the default) offsets every other row and pulls the rows √3/2 as far apart: the densest way to pack equal circles, so ~15% more lenslets fit and only 9% of the sheet is left flat instead of 21%. Switch to Square grid if you are laminating a ready-made square lens array.',
      'Wire Model → Grid Views into the All views input and the whole grid arrives on one edge, in order. A cell port wired individually overrides its view, so you can retouch just one.',
    ],
  },

  radialGrid: {
    summary:
      'Spreads N images around a circle under a lens array. Each one is visible from the bearing it occupies, and head-on they all merge into a single blended image — because every wedge of artwork meets its neighbours at the centre of its lenslet, which is exactly where the eye sits when it is square to the sheet.',
    uses: [
      {
        title: 'Walk-around reveal',
        detail:
          'Six variants of a design around the circle: the print looks like an average of all of them from in front, and resolves into one as you step to the side.',
      },
      {
        title: 'A face that follows the room',
        detail:
          'Different expressions at different bearings gives a portrait that changes depending on where in the room you stand, in both axes rather than only left-right.',
      },
      {
        title: 'Merge as the message',
        detail:
          'The head-on blend is a real image you can design for — overlay N colour separations, or N words that only add up to something legible from straight in front.',
      },
    ],
    tips: [
      'Ports are named for the bearing the view is seen from: 0° · Right, 90° · Up, and so on anticlockwise. Angles that are not one of the eight compass points are quoted in degrees alone.',
      'A view owns a bearing, not a distance: its wedge runs from the lenslet centre to the rim, so it holds from just off head-on all the way to the edge of the lens cone.',
      'Wedges get thinner towards the centre of every lenslet, which is what makes the merge happen — but it also means the print blurs between views near head-on rather than switching cleanly. That is the effect, not a fault.',
      'Info reports how wide a wedge is at the rim of a lenslet. Under about 2 printed pixels and the views bleed into each other everywhere, not just head-on: use fewer views, lower LPI, or raise PPI.',
      'The artwork always ships on the full PPI raster, because a wedge edge is a radial line and no orientation makes those run along the pixels.',
    ],
  },

  modelInput: {
    summary:
      'Uploads a mesh — STL (binary or ASCII) or OBJ — and puts it on a wire. Units, origin and scale are ignored: whatever renders it fits it to the print. Pair it with Model → Grid Views.',
    uses: [
      {
        title: 'A 3D print you can’t print',
        detail:
          'A model too fine or too large to print in resin can be printed as a lens-grid picture of itself, which you look around instead of holding.',
        chain: ['3D Model Input', 'Model → Grid Views', 'Lens Grid Print'],
      },
    ],
    tips: [
      'STL carries no colour at all, so its views come out in one material colour — set that and the light under Advanced in the render node. Export as OBJ instead and the mesh can bring texture coordinates or vertex colours with it.',
      'A textured OBJ needs its image on a wire, not a .mtl file: connect any image node to the render node’s Texture input. Nothing can fetch the sibling files a .mtl names from inside a browser tab.',
      'A dense scan can be millions of triangles; decimate it first. Nothing here needs more detail than the print resolves — about 177×153 per view at 100 mm and 45 LPI.',
    ],
  },

  modelStereo: {
    summary:
      'Renders a mesh standing behind the print and puts the whole run of views on one wire, ready for Lenticular Print’s Frames input. The sheet is a window: the subject sits entirely behind it and recedes into the paper, with the edges of the sheet occluding it as you move.',
    uses: [
      {
        title: 'An object in a box',
        detail:
          'A model, a setback of nothing, and 12 views: the print reads as a window with the object standing just inside it, turning as you walk past.',
        chain: ['3D Model Input', 'Model → Stereo Views', 'Lenticular Print'],
      },
      {
        title: 'Deeper scene, gentler print',
        detail:
          'Depth behind the plane is cheaper than depth in front of it — a point Z back moves by s·Z/(D+Z) rather than s·Z/(D−Z) — so a window carries a bigger subject than a pop-out at the same LPI.',
      },
      {
        title: 'Check the placement before printing',
        detail:
          'The Depth output is the centre view’s depth map, so Gloss Preview or a Normal Map will show the shape the parallax is being spent on.',
        chain: ['Model → Stereo Views', 'Gloss Preview'],
      },
    ],
    tips: [
      'Everything behind the plate is the point. Nothing floats in front of the paper, so nothing can be cut off by the sheet edge while appearing to be nearer than it — the contradiction that makes a stereo print uncomfortable to look at.',
      'Because the subject is behind the window it projects smaller by D/(D+Z), so the node scales the fit up by the reciprocal — measured at the near face, so the subject fills the frame without any of it spilling past the aperture.',
      'Views cost nothing but render time here: a 1D print spends resolution on one axis only, so 12–24 views is normal, and every extra view buys depth by shrinking the step between eyes.',
      'Watch the parallax figure in Info. More than ~1.5 lenticules per step and the far face ghosts instead of gliding; under 0.15 and the print is flat.',
      'The views go out right-eye-first, because a lenticule shows its leftmost strip to an eye on the right and Lenticular Print interlaces in the order frames arrive. Turn off *Order for the lens* under Advanced if you ever need the raw left-to-right run.',
    ],
  },

  modelViews: {
    summary:
      'Renders a mesh from every eye position of a lens grid and puts the whole set on one wire, in the order Lens Grid Print names its cells — connect it to All views. The eye shifts but never rotates, so the sheet plane stays sharp in every view and only depth moves.',
    uses: [
      {
        title: 'Look-around object',
        detail:
          'A 3×3 grid of a solid object gives real head-tracking parallax in both axes, from one file instead of nine renders.',
        chain: ['3D Model Input', 'Model → Grid Views', 'Lens Grid Print'],
      },
      {
        title: 'Relief without the relief',
        detail:
          'Feed the Depth output into Heightmap → STL or the gloss chain to combine the parallax print with a physical relief of the same model.',
        chain: ['3D Model Input', 'Model → Grid Views', 'Heightmap → STL'],
      },
    ],
    tips: [
      'Subject depth is the whole game. Info reports the parallax in lenslets per view step: past ~1.5 the print ghosts instead of reading as depth, under ~0.15 it looks flat. Change depth, not the grid, first.',
      'Leave View cone on “From the lens” so the views span exactly what the lens can show — the same LPI, gloss height and RI you set on the print node.',
      'The sheet plane is where the print is sharp, and the model straddles it. Anything you want pin-sharp should sit at mid-depth.',
      'Rotate to frame the subject; the fit is recomputed from the rotated silhouette, so nothing falls off the sheet.',
      'Colour comes from the Texture input if the mesh has UVs, else the mesh’s own vertex colours, else the flat material colour. A texture replaces that colour rather than tinting it. Info says which one a render actually used.',
    ],
  },

  // ---- Export ----
  heightmapStl: {
    summary:
      'Turns a heightmap into a watertight STL solid (white = tall), with a flat base under it. Runs in a worker so a big map does not freeze the UI.',
    uses: [
      {
        title: '3D-print a relief',
        detail: 'A photo → depth → STL chain gives a printable lithophane-style panel.',
        chain: ['Image Input', 'Depth Anything v2', 'Auto Contrast', 'Heightmap → STL'],
      },
      {
        title: 'Mill a texture plate',
        detail: 'Noise or a logo becomes a physical stamp.',
      },
    ],
    tips: [
      '“Merge flat areas” collapses equal-height regions and can shrink a mesh by an order of magnitude on simple art.',
      'Blur the heightmap first unless you want visible terracing.',
    ],
  },

  // ---- Pipeline ----
  pipeline: {
    summary:
      'A whole sub-graph collapsed into one node. Its Pipeline Input/Output markers become its ports, and it can be saved and reused in other workflows.',
    uses: [
      {
        title: 'Reuse the spot-gloss recipe',
        detail: 'Wrap extract → blur → threshold → despeckle once, then drop it into every job.',
      },
      {
        title: 'Keep a big canvas readable',
        detail: 'Collapse a 12-node branch you have stopped editing.',
      },
    ],
    tips: ['Open pipeline ▸ edits the nodes inside; the ports follow whatever markers you leave in there.'],
  },
  pipelineInput: {
    summary: 'A marker inside a pipeline: it becomes one input port on the pipeline node.',
    uses: [
      {
        title: 'Name what the pipeline takes',
        detail: 'Add one per input and give it a label like "Art" or "Mask".',
      },
      {
        title: 'Test the subgraph in place',
        detail: 'Wire a test value in while editing to see the inner nodes compute.',
      },
    ],
    tips: ['Only meaningful inside a pipeline — on the top-level canvas it does nothing.'],
  },
  pipelineOutput: {
    summary: 'A marker inside a pipeline: it becomes one output port on the pipeline node.',
    uses: [
      {
        title: 'Expose the result',
        detail: 'Wire the last inner node into it; that value is what the pipeline node emits.',
      },
      {
        title: 'Emit more than one thing',
        detail: 'Add a second marker to return, say, both the mask and the preview.',
      },
    ],
  },

  // ---- AI (Replicate): Generate ----
  fluxSchnell: textToImage(
    'The fast one: a few steps, seconds per image, cheap enough to iterate with. Start here when you are exploring.',
  ),
  sdxlLightning: textToImage(
    'Four-step SDXL — near-instant results, good for thumbnails and rough composition tests.',
  ),
  fluxDev: textToImage(
    'The quality tier of the Flux family: slower and pricier than Schnell, noticeably better on detail and prompt adherence.',
  ),
  sdxl: textToImage(
    'Stable Diffusion XL, with a negative prompt input — the most predictable of the open models and the one with the most community knowledge behind it.',
    ['Use the negative prompt for what you do not want ("text, watermark, extra fingers").'],
  ),
  recraftV3: textToImage(
    'Strong on styled and vector-ish output — brand illustration, icons, flat design work.',
  ),
  ideogramV2: textToImage(
    'The one that can actually render legible text inside the image. Use it for posters, packaging and signage.',
  ),
  sd35Large: textToImage(
    'Stable Diffusion 3.5 Large: better prompt following and typography than SDXL, with a negative prompt input.',
  ),

  // ---- AI (Replicate): Edit ----
  instructPix2Pix: imageToImage(
    'Edits an existing image from a plain instruction ("make it winter") rather than a full re-description.',
    [
      {
        title: 'Seasonal / time-of-day variants',
        detail: 'Two edits of one photo make a natural lenticular flip.',
        chain: ['Image Input', 'Instruct Pix2Pix', 'Lenticular Print'],
      },
      { title: 'Quick client alternatives', detail: 'Same composition, different mood, no re-shoot.' },
    ],
  ),
  sdInpaint: imageToImage('Fills a masked region from a prompt, leaving the rest of the image untouched.', [
    {
      title: 'Replace an object',
      detail: 'Mask it with Grounded SAM, describe what should be there instead.',
      chain: ['Grounded SAM', 'SD Inpainting'],
    },
    { title: 'Patch a blemish', detail: 'Mask the flaw and prompt for the surrounding material.' },
  ]),
  fluxFill: imageToImage(
    'Flux-quality inpainting *and* outpainting from image + mask (+ optional prompt) — the strongest fill in the list.',
    [
      {
        title: 'Extend a crop',
        detail: 'Pad the canvas first; the transparent border is what gets invented.',
        chain: ['Pad', 'Flux Fill'],
      },
      { title: 'Remove and rebuild', detail: 'Mask a distraction and let it reconstruct the background.' },
    ],
  ),
  fluxCanny: imageToImage(
    'Structure-guided generation: it keeps the composition of a control image and repaints everything else from the prompt.',
    [
      {
        title: 'Restyle but keep the layout',
        detail: 'Sobel edges as the control image lock the geometry.',
        chain: ['Edge Detect', 'Flux ControlNet (Canny)'],
      },
      {
        title: 'Consistent lenticular frames',
        detail: 'Same edges, different prompts — the frames line up, so the flip does not jump.',
      },
    ],
  ),
  fluxKontext: imageToImage(
    'High-quality instruction editing that holds identity and layout much better than a plain img2img pass.',
    [
      { title: 'Change one thing', detail: '"Make the jacket red" without redrawing the person.' },
      {
        title: 'Product colourways',
        detail: 'One shot, several finishes, all still recognisably the same object.',
      },
    ],
  ),
  icLight: imageToImage('Relights a subject from a text description of the lighting.', [
    {
      title: 'Match a subject to a new background',
      detail: 'Relight the cut-out to the scene before compositing.',
      chain: ['BiRefNet', 'Relight (IC-Light)', 'Combine (over)'],
    },
    {
      title: 'Lighting flip',
      detail: 'Day-lit and night-lit versions of one shot make a striking lenticular.',
    },
  ]),
  lamaRemove: imageToImage('Erases a masked region and reconstructs the background — no prompt needed.', [
    {
      title: 'Delete an object cleanly',
      detail: 'Mask it, erase it; better than inpainting when you want *nothing* there.',
      chain: ['Area Picker', 'Remove Object (LaMa)'],
    },
    { title: 'Strip a watermark', detail: 'Mask the mark and let it fill from the surroundings.' },
  ]),

  // ---- AI (Replicate): Stylize ----
  animeGan: imageToImage('Cartoon/anime stylisation of a photo, in one pass.', [
    {
      title: 'Photo → illustration flip',
      detail: 'The original and its stylised twin are ready-made lenticular frames.',
      chain: ['Image Input', 'AnimeGAN v2', 'Lenticular Print'],
    },
    { title: 'Stylised avatars', detail: 'Consistent look across a batch of portraits.' },
  ]),
  styleTransfer: imageToImage('Restyles an image using a reference style image plus a prompt.', [
    {
      title: 'Apply a house style',
      detail: 'Feed a brand illustration as the style reference to keep a series coherent.',
    },
    { title: 'Match two assets', detail: 'Restyle a stock photo to sit next to commissioned art.' },
  ]),
  faceToSticker: imageToImage('Turns a face photo into a sticker, guided by a prompt.', [
    {
      title: 'Die-cut sticker sheet',
      detail: 'Add a keyline and you have a print-ready sticker.',
      chain: ['Face to Sticker', 'Outline', 'Flatten'],
    },
    { title: 'Event merchandise', detail: 'Portraits turned into giveaways on the spot.' },
  ]),

  // ---- AI (Replicate): Depth ----
  depthAnythingV2: imageToImage(
    'Estimates depth from a single photo, and gives you both a greyscale map (for geometry) and a colour one (for looking at).',
    [
      {
        title: 'Photo → 3D-printable relief',
        detail: 'The greyscale output is a heightmap; normalise it to use the full range.',
        chain: ['Depth Anything v2', 'Auto Contrast', 'Heightmap → STL'],
      },
      {
        title: 'Depth-driven varnish',
        detail: 'Gloss only what is close to the camera for a subtle 3D read.',
      },
    ],
  ),
  marigoldDepth: imageToImage(
    'Diffusion-based depth estimation — slower than Depth Anything, and usually cleaner on fine structure.',
    [
      { title: 'High-fidelity relief', detail: 'Worth the wait when the STL is the deliverable.' },
      { title: 'Compare depth models', detail: 'Run both and A/B Compare before committing to a print.' },
    ],
  ),

  // ---- AI (Replicate): Segment ----
  sam2Image: imageToImage('Segment Anything 2: automatic masks for everything it finds in the image.', [
    {
      title: 'Mask without describing',
      detail: 'When you cannot name the thing, let SAM find the regions and pick from them.',
    },
    {
      title: 'Point/box prompts',
      detail: 'Pass coordinates through Extra inputs (JSON) to target one object.',
    },
  ]),
  sam3Concept: imageToImage('Segment Anything 3: masks everything matching a text concept.', [
    { title: 'Mask a category', detail: '"every window", "all the leaves" — one prompt, many instances.' },
    {
      title: 'Concept-driven gloss',
      detail: 'Varnish a whole class of object across a busy image.',
    },
  ]),
  groundedSam: imageToImage(
    'Text-prompted segmentation (Grounding DINO + SAM): it masks what your prompt describes, and can subtract what a negative prompt describes. Outputs the mask, its inverse and annotated previews.',
    [
      {
        title: 'Varnish exactly one subject',
        detail: '"the perfume bottle" is a faster mask than any hand selection.',
        chain: ['Grounded SAM', 'Despeckle', 'Gloss Preview'],
      },
      {
        title: 'Everything except…',
        detail: 'Use the inverted mask output to treat the background instead.',
      },
    ],
  ),

  // ---- AI (Replicate): Background removal ----
  birefnetV3: imageToImage('High-accuracy background removal — the best default for hair and fine edges.', [
    {
      title: 'Clean cut-out for compositing',
      detail: 'Remove, clean the fringe, drop onto a new background.',
      chain: ['BiRefNet', 'Alpha Cleanup', 'Combine (over)'],
    },
    {
      title: 'Subject-shaped varnish',
      detail: 'The alpha channel is already the mask you want to gloss.',
      chain: ['BiRefNet', 'Extract Channel (alpha)', 'Gloss Preview'],
    },
  ]),
  isnetAnime: imageToImage(
    'rembg / IS-Net background removal — fast and cheap, fine for clean studio shots.',
    [
      {
        title: 'Bulk catalogue cut-outs',
        detail: 'Good enough for hard-edged products, at a fraction of the cost.',
      },
      {
        title: 'Illustration cut-outs',
        detail: 'The anime variant handles flat art well; set model_name in Extra inputs.',
      },
    ],
  ),
  briaRmbg: imageToImage('Commercial-grade background removal, licensed for business use.', [
    { title: 'Client work', detail: 'Reach for this when the licence matters as much as the matte.' },
    { title: 'E-commerce packshots', detail: 'Consistent white-background product images.' },
  ]),

  // ---- AI (Replicate): Restore & upscale ----
  realEsrgan: imageToImage('The workhorse upscaler: more pixels, sharper edges, no invention.', [
    {
      title: 'Print a small original bigger',
      detail: 'Upscale before the print-prep tail so the mask is built at final resolution.',
    },
    { title: 'Rescue a low-res asset', detail: 'A 512 px logo becomes usable on a poster.' },
  ]),
  gfpgan: imageToImage('Restores faces — the standard fix for soft or damaged portraits.', [
    {
      title: 'Repair one face in a crowd',
      detail: 'Cut the face out, restore it, place it back so nothing else changes.',
      chain: ['Split Region', 'GFPGAN face restore', 'Place Image'],
    },
    { title: 'Clean up an AI portrait', detail: 'Generators still fumble eyes and teeth; this fixes them.' },
  ]),
  ddcolor: imageToImage('Colourises black-and-white photographs.', [
    {
      title: 'Then / now lenticular',
      detail: 'The original mono shot and its colourised twin flip beautifully.',
      chain: ['Image Input', 'Colorize (DDColor)', 'Lenticular Print'],
    },
    { title: 'Archive revival', detail: 'Bring a historical image into a modern layout.' },
  ]),
  clarityUpscaler: imageToImage(
    'A creative upscaler: it adds plausible detail rather than just interpolating, optionally steered by a prompt.',
    [
      { title: 'Rescue a very small source', detail: 'When there is genuinely no detail left to recover.' },
      { title: 'Add texture on purpose', detail: 'Prompt for "fine fabric weave" and it will invent one.' },
    ],
  ),
  codeformer: imageToImage('Face restoration with a fidelity dial — trade likeness against cleanliness.', [
    { title: 'Old family photo', detail: 'High fidelity keeps the person recognisable.' },
    { title: 'Stylised portrait', detail: 'Lower fidelity produces a smoother, more idealised face.' },
  ]),
  supir: imageToImage('Heavy-duty photo restoration and upscale, optionally prompt-guided.', [
    {
      title: 'Damaged archival print',
      detail: 'The most capable option here when the source is really rough.',
    },
    { title: 'Hero image for a large format', detail: 'Worth the runtime when the output is a poster.' },
  ]),
  nafnet: imageToImage('Deblurring and denoising restoration.', [
    { title: 'Fix camera shake', detail: 'Recover a slightly-motion-blurred shot.' },
    { title: 'Clean before thresholding', detail: 'Less noise means a far cleaner gloss mask.' },
  ]),

  // ---- AI (Replicate): Describe ----
  blipCaption: vlm(
    'Lightweight captioning and visual Q&A: leave the question empty for a caption, or ask something specific.',
  ),
  moondream: vlm(
    'A small, fast vision-language model — cheap enough to ask questions about every image in a batch.',
  ),
  llava: vlm('A larger vision-language model for detailed reasoning about an image.'),
  clipInterrogator: {
    summary: 'Reverse-engineers a text prompt from an image — what would you have typed to get this?',
    uses: [
      {
        title: 'Match an existing style',
        detail: 'Interrogate a reference, then feed the prompt to a generator to produce more like it.',
        chain: ['Image Input', 'CLIP Interrogator', 'Flux Dev'],
      },
      { title: 'Learn what a model sees', detail: 'A quick way to understand why a prompt is not landing.' },
    ],
    tips: ['Manual node: press Run ▶.'],
  },
  ocr: {
    summary: 'Extracts text from an image.',
    uses: [
      { title: 'Read a label', detail: 'Pull the copy off a packshot without retyping it.' },
      {
        title: 'Rewrite found text',
        detail: 'OCR it, then send it to an LLM node to translate or restyle it.',
        chain: ['OCR (text extract)', 'Claude 3.5 Haiku'],
      },
    ],
    tips: ['Manual node: press Run ▶.'],
  },

  // ---- AI (Replicate): Custom ----
  replicateCustom: {
    summary:
      'The escape hatch: run any model on Replicate. Set the slug, wire up to two images and a prompt, and pass anything else the model wants through Extra inputs (JSON).',
    uses: [
      {
        title: 'A model this app has no node for',
        detail: 'Paste the slug from the Replicate page and wire it in like any other node.',
      },
      {
        title: 'Pin a specific version',
        detail: 'Use owner/model:version when you need reproducible output across a job.',
      },
    ],
    tips: ['Open the settings popup for the model’s input schema hint before guessing at key names.'],
  },

  // ---- AI (OpenRouter) ----
  llmLlama8b: llm('Llama 3.1 8B Instruct — the cheap, fast option for mechanical text work.'),
  llmGeminiFlash: llm('Gemini Flash — fast and inexpensive, good at following formatting instructions.'),
  llmGpt4oMini: llm('GPT-4o mini — a solid general-purpose small model.'),
  llmClaudeHaiku: llm('Claude 3.5 Haiku — strong writing quality at small-model speed.'),
  llmCustom: {
    summary: 'Any model on OpenRouter: set the slug yourself.',
    uses: [
      { title: 'Use a model this app has no node for', detail: 'Paste any OpenRouter slug and go.' },
      { title: 'Compare two models', detail: 'Two custom nodes, one prompt, and read both outputs.' },
    ],
    tips: ['Needs an OpenRouter key (Settings), not the Replicate one.'],
  },
};

/**
 * Help for a node definition. Falls back to a generated entry so an unknown or
 * newly added node still opens something useful rather than an empty window.
 */
export function helpFor(def: NodeDefinition): NodeHelp {
  const entry = NODE_HELP[def.type];
  if (entry) return entry;
  return {
    summary: def.description ?? `A ${def.category} node.`,
    uses: [
      {
        title: `Use it in a ${def.category} chain`,
        detail:
          'This node has no written examples yet. Its inputs and outputs below show what it can be wired to.',
      },
    ],
  };
}
