# Codebase Analysis — Node Image Tool (`image-to-uv-tool`)

**Date:** 2026-07-04
**Scope:** full source review (engine, store, image/STL libraries, AI integration, React UI, build/tooling), 4 parallel subsystem reviews + verification of headline findings.
**State at review:** branch `main`, clean tree, 106 commits (all within 2026-07-03 → 07-04), ~8,000 lines of source, **229/229 tests passing in 24 files, typecheck clean**.

---

## 1. Executive summary

This is an unusually healthy two-day-old codebase: pure, testable core logic (`engine/`, `lib/`), a declarative node-definition system, disciplined commit history, and real test coverage of the scheduler, image math, and AI request mapping. The architecture (RGBA buffers as the interchange format, a platform adapter isolating the DOM, a Zustand store owning the scheduler) is sound and deliberately worker-ready.

The problems cluster in four places:

1. **Concurrency at the store level.** The dirty-propagation scheduler has one real correctness hole (epoch reset on undo/redo/load lets a stale in-flight result commit) and several duplicate-execution/abort-thrash races between its two uncoordinated executors.
2. **Money-losing edges in the AI path.** Cancelling a node never cancels the remote Replicate prediction (it keeps billing); undo discards paid results; a transient 429 during polling fails the whole run.
3. **Scaling walls.** Everything runs synchronously on the main thread; image bytes live as base64 inside the persisted graph, so localStorage's ~5 MB quota caps the app at roughly one medium photo; every keystroke re-stringifies the whole graph and re-renders the whole canvas.
4. **One shipped output bug:** exported STL meshes have ⅓ of their wall triangles wound backwards (verified by cross-product; the `_flip` parameter meant to fix it is dead code).

None of these are hard to fix, and the pure-function architecture makes most fixes local. Section 5 proposes a phased roadmap: fix correctness first, then unblock scale (IndexedDB + workers), then editor UX, then features/productization.

---

## 2. Issues

Severity: 🔴 High (correctness/cost/data-loss) · 🟠 Medium · 🟡 Low. File:line references are to the reviewed revision (`41676f4`).

### 2.1 🔴 High

| #   | Area             | Issue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | Scheduler        | **Epoch guard defeated by epoch reset.** `_executeNode` detects mid-run invalidation via `(epochs[id] ?? 0) !== startEpoch` (`src/store/store.ts:468`), but `undo`/`redo`/`loadGraph` set `epochs: {}` (`store.ts:339-347, 355-363, 611-620`). A node whose epoch was 0 when its run started passes `0 === 0` after an undo, and the in-flight run **commits stale outputs as `upToDate` against the restored graph** (the node-deleted guard passes because the restored graph has the same ids). These paths also never abort `runControllers`, so the stale run always reaches the commit point. Fix: bump epochs instead of resetting, and/or abort all controllers on undo/redo/loadGraph/reset. |
| H2  | STL export       | **North/south wall triangles are wound backwards; `_flip` is dead code.** `wall()` receives `_flip = true` for the two Y-side walls (`src/lib/stl.ts:92,94`) but never uses it (`stl.ts:113`). Verified by cross-product: the y0-side wall's winding yields a −Y normal where outward is +Y (and vice versa for y1). Both `stlToAscii` and `stlToBinary` derive facet normals from winding, so every exported mesh has ~⅓ of wall facets inverted — mesh validators report flipped faces, backface-culled viewers show holes, strict repair/boolean tools choke. No orientation test exists, which is why this ships green.                                                                           |
| H3  | UI perf          | **Every config keystroke re-renders the entire canvas and recomputes downstream.** `updateNodeConfig` replaces the `nodes` array per keystroke (`store.ts:281-289`); the Canvas sync effect then recreates _every_ React Flow node with a fresh `data: {}` (`src/components/Canvas.tsx:36-52`, line 48), defeating React Flow's per-node memoization — all NodeViews re-render per character. The same keystroke also calls `markOutOfDate` + `processAutoRun` with no debounce, so full-raster image ops re-run per character typed. Fix: constant `data` identity + preserve unchanged node objects; debounce config-driven recompute.                                                              |
| H4  | Persistence perf | **Full-graph `JSON.stringify` on every `set()`, including multi-MB base64 images.** zustand persist serializes the partialized state on _every_ state change — toasts, selection, and each `onProgress` tick during AI polls (`store.ts:640-661`). `imageInput` stores base64 data URLs in `config.src` (`src/nodes/local.ts:94-101`), so multi-MB strings are re-stringified on the main thread constantly. The `safeStorage` debounce only defers `localStorage.setItem`, **not the stringify** (`src/store/safeStorage.ts:62-69`).                                                                                                                                                                 |
| H5  | Cost / data loss | **Undo/redo wipes all computed results, including paid AI outputs.** `undo`/`redo` set `runtime: {}` (`store.ts:339-347, 355-363`). Every node drag is a snapshot (`store.ts:272-279`), so undoing a position nudge silently destroys every manual (paid) node result on the canvas — and manual nodes don't auto-regenerate.                                                                                                                                                                                                                                                                                                                                                                         |
| H6  | Cost             | **Cancel orphans the remote Replicate prediction.** `cancelNode` aborts only the local controller (`store.ts:557-559`); nothing ever calls `POST /predictions/{id}/cancel` (no cancel endpoint anywhere in `src/lib/replicate.ts`). The prediction keeps running — and billing — on Replicate. Same on node deletion mid-run. The proxy already allowlists the needed verb (`proxy/replicate-proxy.mjs:21`).                                                                                                                                                                                                                                                                                          |
| H7  | AI reliability   | **No size guard on images sent to Replicate.** Every image port is embedded as a PNG data URI (`src/nodes/aiMapping.ts:59-61`, `src/lib/replicate.ts:152,157`); Replicate's guidance for data-URI inputs is ~256 KB, while the default `imageInput` config sends the original resolution (`local.ts:92-94`). Real photos produce opaque 413/422 errors, plus main-thread jank and memory doubling from stringifying the payload. Needs a preflight size check with an actionable error (or auto-downscale / file-upload fallback).                                                                                                                                                                    |

### 2.2 🟠 Medium

**Scheduler & store**

- **Superseded run's abort handler clobbers the newer run's status.** Run N+1 aborts run N (`store.ts:432`); run N's catch unconditionally stamps `outOfDate` (`store.ts:489-497`) without checking it's still the current controller, transiently overwriting the new run's `running` status — the auto sweep then schedules a redundant third execution, aborting run N+1. One wasted (possibly paid) duplicate compute per supersession.
- **Two uncoordinated executors.** `runNode`/`bringUpToDate` (`store.ts:540-582`) iterate topo order while the auto sweep (`store.ts:511-538`) may execute the same nodes concurrently; their `!== 'upToDate'` checks include `running`, so they abort-and-restart in-flight work.
- **Execution continues past a failed ancestor.** Neither `runNode` nor `bringUpToDate` stops on `error` (`store.ts:549-553, 577-581`); descendants run with silently-missing inputs (`src/engine/schedule.ts:26-27`), producing toast floods or silently wrong outputs.
- **`cancelNode` on an auto node is futile** — abort resets to `outOfDate` and the sweep instantly re-runs it; there is no paused/disabled state (`store.ts:557-559` + `514-526`).
- **Multi-node drag loses positions.** `onNodeDragStop` persists only the primary dragged node (`Canvas.tsx:106`); other nodes in a dragged multi-selection snap back on the next store sync (and save/export use stale positions). Also, deleting a multi-selection produces one snapshot per node — one Delete press needs N undos (`Canvas.tsx:78` → `store.ts:249`).

**Persistence & validation**

- **Quota failure is permanent and mostly silent.** One ~3.7 MB image exceeds the ~5 MB quota after base64 (+33%); every subsequent persist fails so the stored snapshot goes permanently stale, and the `notified` latch never resets so only the first failure ever toasts (`store.ts:643-651`, `safeStorage.ts:28,42-47`).
- **`safeStorage`'s single pending slot ignores the key** — a second key's write inside the debounce window silently drops the first; `removeItem('b')` cancels a pending write to `'a'` (`safeStorage.ts:29-30, 62-75`). Latent (persist uses one key) but contract-breaking.
- **`merge` spreads unvalidated persisted keys** — only nodes/edges are sanitized; junk/legacy keys (`runtime`, `toasts`, non-string `apiKey`) land directly in state (`store.ts:664-668`).
- **`sanitizeGraph` doesn't enforce graph invariants** that `addConnection` does: it accepts cycles/self-loops (a self-looped auto node is permanently unschedulable; `src/engine/sanitize.ts:29-48`, and `sanitize.test.ts:8` _asserts_ a self-loop is valid), duplicate node ids, multiple edges into non-`multiple` inputs, nonexistent port handles, and type-incompatible edges — all reachable via file import.
- **Memory: every node's full-res RGBA output is retained forever** in `runtime` (a 4096² image is 64 MB) with no eviction (`store.ts:92`); an open preview also pins a removed node's buffer (`store.ts:247-267` clears selection/editor but not `preview`).

**Image / canvas correctness**

- **Blur & sharpen operate on straight (unpremultiplied) alpha** — hidden RGB of transparent pixels bleeds in, producing dark halos at sprite edges (`src/lib/image.ts:516-541`; `sharpen` inherits via `boxBlur`).
- **`combine` arithmetic modes apply the op to alpha** — `subtract`/`difference` of two opaque images yields alpha 0, i.e. an invisible result (`image.ts:175-179`; codified by test, but a UX trap — standard semantics blend RGB and composite alpha separately).
- **Canvas decode/encode round-trip is lossy for semi-transparent pixels** — the 2D canvas premultiplies, so low-alpha RGB is quantised at both pipeline boundaries (`src/lib/canvas.ts:13-14, 47-54`); several ops' alpha-ignoring luminance math _accidentally depends_ on this loss zeroing transparent RGB. `createImageBitmap(blob, {premultiplyAlpha: 'none'})` is the lossless route.
- **`morphology` is O(w·h·r) with uncapped radius** — a large user radius on a large image hard-locks the main thread (`image.ts:551, 569-574`).
- **STL: zero-height columns emit coincident top/bottom faces** → non-manifold zero-thickness sheets (`stl.ts:72-83`, with `minWhite: -1`, `baseThickness: 0`).

**AI integration & proxy**

- **No poll backoff or 429/5xx tolerance** — fixed 1500 ms interval; a single transient poll failure throws and (per H6) orphans the still-running prediction (`src/lib/replicate.ts:161-165, 92`). No overall timeout either — a prediction stuck in `starting` polls forever.
- **Proxy binds all interfaces with `Access-Control-Allow-Origin: *`** — anyone on the LAN can relay traffic to Replicate through your machine (`proxy/replicate-proxy.mjs:54`, `:20`). Should bind `127.0.0.1`. Also: no stream error handling or socket timeouts (an upstream reset mid-response can crash the process, `:40-43,51`), and hop-by-hop headers are forwarded verbatim (`:34-36`).
- **API keys persisted as plaintext in localStorage** (`store.ts:655-661`) with no session-only option; any XSS on the origin or shared-machine access reads both keys. (Verified: keys do **not** leak into exported workflow JSON — `exportGraph` exports only nodes/edges. But exports _do_ embed full-resolution image data and prompts, worth a docs note.)

**UI & tooling**

- **No React error boundary** — any render-time throw white-screens the app (`src/main.tsx:16-20`).
- **Modals have no dialog semantics, focus trap, or focus restore** (`src/components/Modal.tsx:21-39`); port connection and area-picking are mouse-only (`NodeView.tsx:81-100`, `AreaPickerEditor.tsx:74`); toasts aren't announced (`Toasts.tsx:11-13`); the add-node menu has no menu semantics/arrow keys (`Toolbar.tsx:31-72`).
- **Synchronous full-res PNG encode on the render path** — `PreviewModal`/`AreaPickerEditor` call `canvas.toDataURL` in `useMemo`, blocking the frame and holding ~1.33× the bytes as a string (`PreviewModal.tsx:13-22`, `canvas.ts:18-20`); `encodePngBlob` already exists and is async.
- **No ESLint/Prettier, no CI.** `test:run`/`typecheck`/`build` scripts exist but nothing runs them on push; `eslint-plugin-react-hooks` would mechanically catch dep-array mistakes. No coverage configuration despite `coverage/` being gitignored.

### 2.3 🟡 Low (notable)

- Abort-listener leak in `defaultSleep` — one leaked listener per 1.5 s poll tick per run (`replicate.ts:47-60`).
- Cancel during output download can mark a node `upToDate` with partial outputs — a cancel that looks like success (`src/nodes/aiFactory.ts:127-141`).
- `extraInputs` accepts arrays/non-plain JSON and silently overrides port keys (`aiMapping.ts:85`); NaN scalars serialize as `null` (`aiMapping.ts:36-40`); model slug is unescaped in the URL path and `split(':')` mishandles multi-colon slugs (`replicate.ts:113,137`).
- Non-JSON 200 responses throw raw `SyntaxError` at the user; raw HTML error bodies flood toasts (`replicate.ts:92-94`, `openrouter.ts:66-69`).
- `crop` shifts instead of clipping negative origins (`image.ts:370-373`); `hexToRgba` mishandles `#rgba`/invalid hex (`image.ts:305-322`); `normalize` includes transparent pixels in min/max (`image.ts:487-494`); `outline` fringes on anti-aliased edges (`image.ts:252-272`); magic wand ignores alpha entirely (`src/lib/magicWand.ts:12-18`).
- ASCII STL truncation marker (`# … N more facets`) is invalid STL (`stl.ts:150`); mesh built as ~1M small JS arrays before copying to `Float32Array` (`stl.ts:45-53, 202-203`).
- `getContext('2d')` without `willReadFrequently` (`canvas.ts:11,32,50`); no guard for browser canvas dimension limits; `URL.revokeObjectURL` immediately after `click()` can race the download in Firefox/Safari (`download.ts:9`).
- Undo semantics inconsistent: config edits aren't snapshotted, but undoing an earlier structural change silently reverts them (`store.ts:281-289`); `addNode` snapshots before a potentially-throwing `getNodeDef` (phantom history entry, `store.ts:213-215`); `markOutOfDate` resurrects runtime entries for removed ids (`store.ts:412-419`).
- `sanitizeGraph` accepts NaN/Infinity positions (`sanitize.ts:22`); no persist `version`/`migrate` despite `SavedGraph.version` existing; toasts are unbounded; `exportGraph` returns live references; `registerNode` silently overwrites existing types.
- FileReader paths have no `onerror` (silent upload/load failures — `NodeView.tsx:160-164`, `Toolbar.tsx:102-121`); new nodes are placed in fixed canvas coordinates regardless of viewport (`Toolbar.tsx:22`); native `confirm()` for Clear; shortcut guard misses `<select>`/contentEditable (`keyboard.ts:24-25`); flush-on-`beforeunload` only (unreliable on mobile Safari; `safeStorage.ts:50-52`).
- `index.html` has no favicon/description/theme-color; `index.css` names the Inter font but never loads it; test globals (`vitest/globals`) leak into app compilation via `tsconfig.app.json:21`.
- Hard-coded OpenRouter attribution headers point at an unrelated GitHub repo (`openrouter.ts:43-44`).
- Naming drift: the package is `image-to-uv-tool`, the README calls it "Node Image Tool", and there is no UV-specific functionality — pick a name (and see roadmap §5.4 for making the "UV" part true).

---

## 3. Architecture & design observations

**What's good (keep it):**

- **Pure core, impure edges.** `engine/` and `lib/` are dependency-free, deterministic, and unit-tested; the DOM appears only behind `platform.ts`. This is the single best property of the codebase — it makes worker offload, Node-side testing, and future porting cheap.
- **Declarative node definitions** (`NodeDefinition` + `ConfigField` unions) keep `NodeView`/`ConfigFields` fully generic; the `aiFactory` pattern stamps out Replicate nodes from data.
- **Store-first UI** with narrow selectors almost everywhere; props carry identity only.
- **Right-sized modal/toast composition**, pure helper modules (`nodeLayout`, `nodeMenu`, `keyboard`) with tests.

**Structural concerns:**

1. **`store.ts` is a god-module** (~670 lines): graph mutation, two executors, connection UX, toasts, preview, history, persistence in one file, with `_snapshot`/`_executeNode`/`processAutoRun` leaking into the public interface. The concurrency bugs (H1, supersede clobber, duplicate execution) all stem from _three parallel invalidation mechanisms_ (status, epochs, controllers) plus _two uncoordinated executors_ that must be kept consistent by hand. A single work-queue abstraction owning "which node runs next, with which generation token" would eliminate this bug class.
2. **Image payloads are coupled to graph topology.** Base64 image bytes live inside `config.src`, so the graph document, undo history, persistence, exports, and every stringify carry pixel data. Separating content-addressed blob storage (IndexedDB) from graph structure is the single biggest scalability unlock — it fixes H4, the 5 MB ceiling, undo cost, and export size in one move.
3. **Everything is synchronous on the main thread.** All pixel loops, PNG encodes, and STL meshing block the UI. The platform-adapter architecture is already worker-ready; it just isn't exploited.
4. **All pixel math is gamma-encoded sRGB** — blurs/resizes/blends produce the classic dark-edge artifacts; luminance uses Rec. 601 on gamma values (fine as a convention, but undocumented, and heightmap Z inherits it).
5. **Serial scheduler, O(N·E) per pick** (`schedule.ts:37-50`): one node at a time, independent branches never parallelize, quadratic-plus behavior at hundreds of nodes. An adjacency index and a ready-queue fix both.
6. **Invariants enforced only at one door.** Type compatibility, cardinality, and acyclicity are checked in `addConnection` but not in `sanitizeGraph`, so file import bypasses them all (see §2.2).
7. **Stringly-typed config namespace.** Port ids double as config keys with reserved names (`model`, `extraInputs`, `outputKey`) and nothing prevents collisions; `required` on AI ports is dropped before reaching the UI (`aiFactory.ts:42`).
8. **Duplication in `nodes/ai.ts`**: the aspect-ratio block ×3, mask port ×3, negative-prompt ×2; model slugs repeated in prose descriptions that will drift; unversioned community slugs float to `latest_version` at runtime, so node behavior can change under users silently.

---

## 4. Test coverage gaps

Coverage of pure logic is genuinely good. The gaps are concentrated exactly where the bugs are:

| Area                      | Missing tests                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scheduler concurrency** | Epoch guard under `updateNodeConfig` mid-run; undo/redo/loadGraph during an in-flight run (would have caught **H1**); run supersession/abort-clobber; concurrent `runNode` + auto sweep; the re-sweep (`autoRunPending`) loop; `cancelNode` on auto nodes; stop-on-failed-ancestor behavior; `onProgress` set/clear; `HISTORY_LIMIT`; "undo wipes runtime" is unpinned. |
| **STL**                   | No orientation/winding assertions (would have caught **H2**); no watertightness (each directed edge should have an opposite twin); the step-wall branch (`zLow = neighbourHeight`) is never exercised; no zero-height column case; binary payload values unchecked.                                                                                                     |
| **Image math**            | `boxBlur` never tested on non-uniform input (a wrong kernel would pass); `sharpen` never shown to sharpen; contrast path, `levels` gamma, fractional-alpha `combine`, negative-origin `crop` all untested.                                                                                                                                                              |
| **AI clients**            | Real `defaultSleep` abort path; poll-failure (429/5xx) and `canceled` status; request-shape assertions (headers, proxy base); `extraInputs` precedence/NaN/array cases; all-downloads-fail path; cancel-mid-download partial success.                                                                                                                                   |
| **Proxy**                 | Zero tests (preflight, header stripping, error CORS, 502).                                                                                                                                                                                                                                                                                                              |
| **UI**                    | `Canvas.tsx` — zero direct tests and it's the buggiest file (drag write-back, selection sync, edge removal); `NodeView` has no dedicated tests (Run↔Cancel swap, upload flow, status icons); Modal/SettingsModal/PreviewModal/AreaPicker/Toasts untested; ConfigFields covers only 2 of 5 field kinds.                                                                  |
| **Sanitizer/storage**     | Duplicate ids, cycles (a self-loop is currently _asserted valid_), NaN positions, multi-edge-to-single-input; safeStorage interleaved keys, removeItem-cancels-pending, flush-on-unload.                                                                                                                                                                                |
| **Infra**                 | No coverage reporting, no e2e/browser tests (jsdom can't exercise canvas, React Flow interactions, or real drag/drop).                                                                                                                                                                                                                                                  |

---

## 5. Missing features

Grouped by theme; roughly ordered by value within each group.

### 5.1 Persistence & projects

- **IndexedDB blob store** for source images and (optionally) computed/AI outputs — removes the 5 MB wall, makes AI results survive reload instead of demanding a paid re-run.
- **Multiple named graphs/projects** with a picker (currently exactly one implicit workspace).
- **AI result caching** keyed by a hash of (model, inputs, config) so re-running an unchanged manual node is free.
- **Autosaved output snapshots / gallery** — a history of generated results per node, since generations are nondeterministic and users will want to go back.
- **Graph versioning/migration** on the save format (the `version: 1` field exists but nothing reads it).

### 5.2 Editor UX

- **Multi-select that fully works** (drag persist, single-snapshot group delete), plus copy/paste (including cross-tab via clipboard), context menu (right-click → add node at cursor), and viewport-aware node placement.
- **Node disable/bypass (mute)** — pass through or skip a node without unwiring it.
- **Groups/frames/comments and subgraphs** — reusable, collapsible node groups; the standard node-editor growth path.
- **Minimap + zoom-to-fit + auto-layout** for large graphs.
- **Drag-and-drop an image file onto the canvas** → creates an Image Input node.
- **Undo that preserves computed results** (H5) and covers config edits consistently.
- **Inline port value editing hints** — mark required AI inputs (the data exists but is dropped, `aiFactory.ts:42`).
- **Progress with percentages/logs for AI nodes** (Replicate exposes logs and progress in the prediction object; only a text message is shown today).
- **Light theme, onboarding tour, example/template workflows** loadable from the empty state.

### 5.3 Nodes & processing

- **Curves / white balance / color LUT**, noise & procedural texture generators (Perlin/simplex), text overlay, perspective/affine warp, high-quality resampling (bilinear/Lanczos — resize is nearest-neighbour only).
- **Histogram / channel-scope view** node for inspecting values.
- **Batch processing**: run the graph over N input images (folder drop), parameter sweeps, and seed control on generation nodes (most Replicate models accept `seed`; it's currently only reachable via the Extra-inputs JSON).
- **A/B compare node/view** (wipe slider between two images).
- **Web Worker execution for image ops** — not a feature per se, but it unlocks big-image workflows that are currently unusable.

### 5.4 The "UV" in the name (texture/3D pipeline)

The repo is called `image-to-uv-tool` but nothing UV-specific exists. If that's still the goal, the natural node set is:

- **Normal map from heightmap** (Sobel-based; the Sobel kernel already exists).
- **Seamless-tile maker + tiling preview** (offset-and-blend, or an AI tiling model).
- **Channel packing** (roughness/metallic/AO into RGB) — `extractChannel`/`combine` are 80% of this already.
- **PBR export presets** (albedo/normal/roughness bundles, named per convention).
- **3MF/OBJ export** alongside STL; STL is already there for heightmaps.

### 5.5 AI integration

- **Remote prediction cancel** (H6) and **retry with backoff** (P2) — cost/reliability, listed here because they double as features.
- **Cost/usage tracking**: per-run cost estimate and a session spend counter (Replicate returns metrics; even a static per-model estimate beats nothing).
- **Model schema discovery via the proxy** — the proxy could fetch a model's OpenAPI schema so input keys stop being guesswork and stale slugs are detected early.
- **Version pinning UI** — surface "slug floats to latest" vs. pinned `owner/name:version` as an explicit choice.
- **More providers behind the same node shape** (fal.ai, Together, local ComfyUI/A1111 endpoints) — the BYOK + mapping architecture generalizes cleanly.

### 5.6 Platform & delivery

- **CI** (typecheck + tests + build on push), **ESLint + Prettier**, coverage reporting, Playwright smoke e2e.
- **Static deploy** (GitHub Pages/Netlify — it's a pure SPA) and **PWA/offline** support.
- **Error boundary + optional error reporting.**
- **LICENSE file** (none exists) and a `CONTRIBUTING`/architecture doc if it goes public.

---

## 6. Proposed roadmap

### Phase 0 — Correctness & cost hotfixes (days)

Small, local, high-payoff fixes; do these before any feature work:

1. Fix STL wall winding (implement `_flip`) and add orientation + watertightness tests (**H2**).
2. Fix the epoch-reset hole: bump epochs / abort controllers on undo/redo/loadGraph/reset (**H1**); make the superseded-run catch check controller identity.
3. Call Replicate's cancel endpoint from `cancelNode`/`removeNode` (**H6**); add poll backoff with 429/5xx tolerance and a max-duration guard.
4. Preflight image-size guard for AI inputs with an actionable error + auto-downscale option (**H7**).
5. Stop wiping `runtime` on undo/redo — reconcile by node id and mark structurally-affected nodes out of date instead (**H5**); stop snapshotting zero-effect drags into paid-result loss.
6. Canvas: constant `data` identity + node-object reuse; debounce config→recompute (**H3**). Fix multi-drag position persistence.
7. Add an error boundary; bind the proxy to `127.0.0.1`.

### Phase 1 — Foundations for scale (1–2 weeks)

1. **IndexedDB blob store** for image sources (content-addressed; graph stores references). Kills the 5 MB cap, the stringify tax (**H4**), and bloated exports. Keep localStorage for graph topology + settings.
2. **Web Worker pool for image ops** (the `platform` seam makes this mostly mechanical); move PNG encode to `encodePngBlob`/object URLs.
3. **Unify the executors**: one work queue with generation tokens replacing status/epoch/controller triple-bookkeeping; stop-on-failed-ancestor policy; optional parallel execution of independent branches.
4. **Harden `sanitizeGraph`** to enforce the same invariants as `addConnection` (cycles, duplicate ids, cardinality, port existence, type compat).
5. **Tooling**: ESLint (+react-hooks) + Prettier + CI running typecheck/tests/build + coverage; LICENSE.
6. Fix premultiplication at the canvas boundary (`createImageBitmap` with `premultiplyAlpha: 'none'`); premultiplied blur/sharpen; alpha-correct combine modes.

### Phase 2 — Editor UX (2–3 weeks)

1. Multi-select done right, copy/paste, context menu, drag-drop image import, viewport-aware placement.
2. Node disable/bypass; config-edit undo; single-snapshot group operations.
3. Minimap, zoom-to-fit, empty-state templates, onboarding examples.
4. Accessibility pass: dialog semantics + focus trap, keyboard connection flow, live-region toasts, ARIA on menus.
5. AI progress upgrade (percent/logs), required-port indicators, per-node cost hints.

### Phase 3 — Feature growth (ongoing)

1. AI result caching + output history/gallery per node; session cost tracking.
2. Batch processing + seed control + parameter sweeps; A/B compare view.
3. New local nodes: curves, LUT, noise/procedural, text overlay, warp, quality resampling, histogram.
4. Multiple projects + save-format migrations.
5. Model schema discovery via proxy; version pinning UI; additional providers.

### Phase 4 — Productization (when direction is decided)

Decide what this app _is_, then:

- **If "image-to-UV" is the mission:** the §5.4 texture pipeline (normal maps, seamless tiling, channel packing, PBR presets, 3MF/OBJ) becomes Phase 3-equal priority, and the name finally fits.
- **If it's a general node-based image tool:** PWA/offline, static hosting, shareable workflow links (graph in URL or gist), community template library, and a small plugin API for third-party nodes (`registerNode` is 90% of the way there — it just needs collision guards and a manifest).

---

## 7. Verification notes

- Test suite (229 tests / 24 files) and `tsc -b --noEmit` were run during this review: both clean.
- H1 (epoch reset) confirmed by direct reading of `store.ts` (`undo` sets `epochs: {}` and never aborts controllers; the guard compares `?? 0` against a `?? 0` start value).
- H2 (STL winding) confirmed by cross-product computation on the `wall()` vertex order for all four wall directions: X-side walls correct, both Y-side walls inverted; `_flip` is accepted and never read.
- Key-leak check: exported workflow JSON contains only `{version, nodes, edges}` — API keys are **not** included (they are, however, persisted in plaintext localStorage).
- Everything else is cited to file:line against commit `41676f4`; line numbers will drift as the code changes.
