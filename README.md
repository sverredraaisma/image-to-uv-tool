# Node Image Tool

A node-based tool for generating files — images first, but not limited to them.
You build a graph of nodes, wire outputs to inputs, and the graph computes results.
Everything runs **entirely in the browser**; there is no backend. AI nodes call
[replicate.com](https://replicate.com) directly with your own API key.

## Quick start

```bash
npm install
npm run dev        # start the dev server (Vite)
npm run build      # type-check + production build into dist/
npm run test       # watch-mode test runner (Vitest)
npm run test:run   # run the test suite once
npm run typecheck  # type-check only
```

Then open the dev server URL. Paste your Replicate API key in the top-left field
(only needed for AI nodes) and start adding nodes with **+ Add node** (top-right).

## Concepts

### The graph

* **Add nodes** from the top-right menu, grouped by category.
* **Connect** an output to an input either by **dragging** between the round
  handles, or by **clicking** one port and then the other (click-to-connect).
  Connections are checked for **type compatibility** and rejected if they would
  create a **cycle** (which would loop forever) — you'll get a toast either way.
* **Move** nodes freely; **delete** a selected node/edge with `Delete`/`Backspace`
  or the ✕ button on a node.
* Every input and output shows a **small preview**. Click it to open a large view
  with a **Download** button (PNG for images, `.stl` for meshes, `.txt` for text).

### Up-to-date vs. out-of-date

Nodes don't recompute constantly — that would waste time, power and money. Each
node tracks whether it is up to date:

* **Out of date** — an input changed; the node must run again. Marked with a ⚠
  warning icon in its header.
* **Changed** — the node just ran; its *direct* dependents become out of date.

A node can only run once all of its inputs are up to date; if an upstream node is
still out of date it runs first.

* **Auto-run** nodes (image ops, inputs, compose, cleanup…) recompute
  automatically as soon as their inputs are ready. They are cheap.
* **Manual** nodes (the AI/Replicate nodes) never run on their own — press
  **Run ▶** on the node so you don't spend tokens by accident. While running you
  can **Cancel ✕** it (aborts the request).
* **Bring up to date** (the ⟳ button on a node) forces the node *and everything
  downstream of it* to recompute, forcing manual nodes to run as it cascades.

Internally this is a small dirty-propagation scheduler (`src/store/store.ts`)
with an epoch guard so a node invalidated mid-run is safely re-run rather than
settling with a stale result.

### Persistence & files

* The current graph (nodes, positions, connections, per-node settings, uploaded
  image sources, API key) is continuously saved to **local storage**, so closing
  the tab doesn't lose your work. Generated node outputs are **not** stored —
  they are recomputed (auto nodes) or re-run (manual nodes).
* **Save** exports the whole workflow to a `.json` file; **Load** restores it.

> Local storage is ~5 MB. Very large uploaded images may exceed the quota; the
> app keeps working in-memory but may not persist that graph.

## Node catalog

| Node | Category | Runs | Description |
| --- | --- | --- | --- |
| Image Input | Input | auto | Upload an image; it becomes an output. |
| Prompt Input | Input | auto | A text prompt as an output. |
| Solid Colour | Input | auto | Generate a solid colour image of a given size. |
| Combine | Compose | auto | Blend a base image **A** with a secondary image **B** (A over B, B over A, max, multiply, subtract, screen…). |
| Apply Mask | Mask | auto | Use a mask's luminance as the image's alpha. |
| Invert | Adjust | auto | Invert selected R/G/B/A channels. |
| Greyscale | Adjust | auto | Desaturate to luminance. |
| Brightness / Contrast | Adjust | auto | Adjust brightness and contrast. |
| Threshold | Adjust | auto | Binarise by luminance to black/white. |
| Box Blur | Adjust | auto | Blur by an adjustable pixel radius. |
| Levels | Adjust | auto | Remap tones with black/white points and midtone gamma. |
| Gradient Map | Adjust | auto | Map luminance to a two-colour gradient. |
| Hue / Saturation | Adjust | auto | Shift hue and scale saturation. |
| Posterize | Adjust | auto | Reduce each colour channel to a limited number of levels. |
| Outline | Adjust | auto | Coloured outline of an adjustable thickness around non-transparent pixels. |
| Alpha Cleanup | Adjust | auto | Snap pixels below an alpha threshold to transparent / black / white. |
| Crop | Transform | auto | Crop a rectangle from the image. |
| Resize | Transform | auto | Resize to a target width/height (nearest-neighbour). |
| Rotate / Flip | Transform | auto | Rotate by 90° steps or flip. |
| Extract Channel | Mask | auto | Pull one channel (or luminance) out as a greyscale image. |
| Dilate / Erode | Mask | auto | Grow / shrink bright (white) mask regions by a radius — pairs with the segmentation masks. |
| Combine Masks | Mask | auto | Boolean-combine two masks (AND / OR / A−B / XOR). |
| Chroma Key | Mask | auto | Mask pixels near a target colour (within tolerance). |
| Area Picker | Mask | auto | Click points on the image (large editor); a magic-wand flood-fill from those points (adjustable tolerance) produces a white mask. Points are saved. |
| Heightmap → STL | Export | auto | Turn a heightmap into a solid STL (white = tall) with min-white cutoff, base thickness, depth range and physical width. |
| **Generate** (text→image) | AI (Replicate) | manual | Flux Schnell, Flux Dev, SDXL, SD 3.5, Recraft v3, Ideogram v2. |
| **Edit** (image + prompt/mask) | AI (Replicate) | manual | Instruct Pix2Pix, Flux Kontext, Relight (IC-Light), SD Inpainting, Remove Object (LaMa, image + mask), Flux ControlNet (Canny). |
| **Stylize** | AI (Replicate) | manual | AnimeGAN v2, Style Transfer (reference image + prompt), Face to Sticker. |
| **Depth** | AI (Replicate) | manual | Depth Anything v2 (grey + colour outputs), Marigold. |
| **Segment** | AI (Replicate) | manual | SAM 2, SAM 3 (concept), Grounded SAM (mask / inverted / annotated / neg-annotated outputs). |
| **Background removal** | AI (Replicate) | manual | BiRefNet, rembg / IS-Net, Bria RMBG 2.0. |
| **Restore & upscale** | AI (Replicate) | manual | Real-ESRGAN, GFPGAN, CodeFormer, SUPIR, Colorize (DDColor), Clarity Upscaler. |
| **Describe** (image→text) | AI (Replicate) | manual | Image Caption (BLIP), Moondream (VLM), LLaVA (VLM), CLIP Interrogator, OCR (text extract). |
| **Custom** | AI (Replicate) | manual | Replicate (custom) — any model: set the slug, wire images/prompt, add anything else via JSON. |
| **LLMs** | AI (OpenRouter) | manual | Llama 3.1 8B, Gemini Flash, GPT-4o mini, custom — a prompt plus optional wired text input → text. |

AI models are grouped by capability in the **+ Add node** menu, which is
sorted and has a live search filter.

Image data flows between nodes as raw RGBA buffers (`RasterImage`), so every
image operation is a pure, testable function. `mask` and `image` ports are
interchangeable.

### AI nodes have multiple, configurable inputs and outputs

Every AI node can take several inputs. Each declares typed input ports
(image / mask / text); a text port can also be typed inline instead of wired.
Each port maps to a **Replicate input key** that is editable in the node's
advanced settings (⚙), and every node has an **"Extra inputs (JSON)"** field —
so you can supply *any* input a model accepts (points, boxes, thresholds,
guidance…), even ones not exposed as a port. The model slug is editable too, and
accepts `owner/name` or `owner/name:version`.

Nodes also have **multiple outputs** where the model returns several things —
mapped by array index or object key. **Depth Anything** exposes *Grey depth* and
*Colour depth*; **Grounded SAM** exposes *Mask*, *Inverted mask*, *Annotated* and
*Neg. annotated* — each on its own port with its own preview, wireable
independently. All image outputs are downloaded in parallel.

> Because Replicate model schemas change over time and can't be reliably
> auto-discovered from the browser, the built-in slugs are best-known defaults
> and everything is editable. If a call fails with a 404, fix the slug; if it
> fails with a 422/"unknown input", adjust the input keys or the Extra-inputs
> JSON to match the model's current schema on its Replicate page.

## Replicate & CORS

AI nodes POST to `https://api.replicate.com/v1/models/<owner>/<name>/predictions`
with your key, sending the input image as a data-URI, then poll until the
prediction settles and download the result.

**Important:** `api.replicate.com` does not send permissive CORS headers, so a
direct browser call is usually blocked. A tiny zero-dependency Node.js proxy is
included that does exactly one thing — forward requests to `api.replicate.com`
and add CORS headers (the upstream host is hard-coded, so it is not an open
proxy):

```bash
npm run proxy      # listens on http://localhost:8787
```

Then set the app's **Proxy URL** field (top-left) to `http://localhost:8787/v1`.
Left empty, calls go straight to Replicate. See `proxy/replicate-proxy.mjs`.

Each AI node's **model slug** and **image input key** are editable in its
settings (⚙) because Replicate model names change over time — update them there
if a default is out of date.

Depth-style models that return an object of URLs (e.g. `{grey_depth, color_depth}`)
are handled by the **Output field key** setting on the node.

## OpenRouter (LLMs)

The LLM nodes call [OpenRouter](https://openrouter.ai) directly (its API allows
browser CORS, so no proxy is needed). Paste your key in the **OpenRouter API
key** field (top-left). Each LLM node takes a **prompt** typed on the node plus
an optional **wired text input** (e.g. from a Prompt Input or an image-caption
node); the wired text is appended to the prompt. System prompt, temperature and
max-tokens are in the advanced settings. Model slug is editable — any OpenRouter
model works.

## Architecture

```
src/
  types.ts                 core data model (RasterImage, DataValue, NodeDefinition…)
  engine/
    graph.ts               pure graph algorithms (descendants, cycle detection, topo-sort)
    compatibility.ts       port type compatibility
    registry.ts            node-definition registry
  lib/
    image.ts               pure RGBA ops (combine, invert, outline, blur, crop, transform…)
    magicWand.ts           flood-fill selection
    stl.ts                 heightmap → watertight STL mesh
    replicate.ts           bring-your-own-key Replicate client
    openrouter.ts          bring-your-own-key OpenRouter chat client
    platform.ts / canvas.ts  DOM/canvas adapter (decode/encode/fetch images)
    download.ts            file downloads
  nodes/                   node definitions (local.ts, ai.ts, llm.ts) + registration
    aiMapping.ts           pure port/config ↔ Replicate request/response mapping (unit-tested)
  store/store.ts           Zustand store: graph state, persistence, scheduler
  components/              React Flow canvas, node view, toolbar, modals, toasts
```

**Tech stack:** TypeScript · React · Vite · [@xyflow/react](https://reactflow.dev)
(React Flow) · Zustand · Vitest. No backend, bring your own key.

## Tests

```bash
npm run test:run
```

Covers the graph algorithms, image/STL/magic-wand math, the Replicate client
(with an injected fetch), the scheduler (auto-run cascade, manual gating,
bring-up-to-date, cycle/compatibility rejection, persistence), an end-to-end node
pipeline, and component/smoke tests for the UI.
