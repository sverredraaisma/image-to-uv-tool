# Roadmap progress

Tracks execution of the plan in `CODEBASE-ANALYSIS.md` §6. Branch: `roadmap-phase0`.

## Done

### Phase 0 — Correctness & cost hotfixes ✅ (all 7)

| #     | Commit summary                                                                                             |
| ----- | ---------------------------------------------------------------------------------------------------------- |
| H2    | STL Y-side walls wound outward (`_flip` implemented); orientation + watertightness tests                   |
| H1    | `abortAllRuns()` + controller-identity guard in `_executeNode`; stale runs can't commit after a graph swap |
| H5    | pure `reconcileRuntime()` keeps unchanged (paid) results across undo/redo                                  |
| H6/P2 | Replicate remote-cancel on abort; poll backoff + 429/5xx tolerance + max-duration                          |
| H7    | AI image auto-downscale (2048px) + 8 MB actionable-error backstop                                          |
| H3    | canvas rfNode identity reuse + constant data; input debounce; batch multi-drag/multi-delete                |
| —     | React error boundary; proxy bound to loopback                                                              |

### Phase 1 — Foundations (partial) ✅ / ⏳

- ✅ **1.4** `sanitizeGraph` enforces the `addConnection` invariants on import (cycles, self-loops, dup ids/edges, port existence, type compat, cardinality) — registry-aware in the store, pure by default.
- ✅ **1.6** premultiplied blur/sharpen (no dark halos); coverage-alpha combine modes.
- ✅ **1.5** ESLint (+react-hooks) + Prettier + GitHub Actions CI (lint/format/typecheck/test/build on Node 20.19 & 22.12) + Prettier baseline. **LICENSE deferred pending owner's choice.**
- ✅ **1.2 (partial)** async object-URL preview encode off the render path.

**Test/type/build status:** 261 tests green, `tsc -b` clean, `vite build` clean, `eslint .` clean, `prettier --check` clean.

### Post-merge continuation (branch `roadmap-rest`, 306 tests green)

- ✅ **Batch A (§2.2/2.3)** — crop negative-origin clip, hexToRgba `#rgba`/invalid,
  normalize excludes transparent, morphology radius cap, registerNode collision
  warn, bounded toasts, exportGraph deep-clone, OpenRouter attribution,
  defaultSleep listener leak, aiFactory cancel-mid-download, `merge` key
  whitelist, safeStorage per-key, stop-on-failed-ancestor.
- ✅ **1.1 IndexedDB blob store (H4)** — content-addressed `lib/blobStore.ts`
  (injectable backend + browser IndexedDB), platform seam `putBlob`/`getBlob`,
  imageInput `srcRef` with legacy back-compat, portable inlined export.
- ✅ **§5.4 UV/texture** — Normal Map, Channel Pack, Noise, bilinear Resize, OBJ export.
- ✅ **§5.3 nodes** — Histogram scope; bilinear resample.
- ✅ **§5.2 editor UX** — Node bypass/mute; multi-selection + group duplicate
  (internal edges, single undo); accessibility pass (dialog focus-trap, live-region toasts).
- ✅ **§5.3 AI** — first-class seed control on generation nodes.

**Phase 2 (editor UX) — added since:** copy/paste, right-click context menu,
drag-drop image import, viewport-aware placement, loadable example templates,
required-port indicators. (Minimap + zoom-to-fit already shipped via React Flow
Controls.)

**Phase 3 (features) — added since:** Rotate (angle), White Balance, A/B Compare,
Histogram nodes; save-format version + migration hook.

**Phase 4 (productization) — added since:** Seamless Tile + OBJ export; shareable
workflow links (`#g=`); PWA (favicon, manifest, offline service worker) + page
metadata; MIT LICENSE.

### Higher-risk features — added since (branch `roadmap-rest`)

- ✅ **1.2 Web Worker pool** — op-name-addressable heavy-op registry
  (`heavyOps.ts`, byte-identical to the former inline ops), `imageOp.worker.ts`
  - `imageWorkerPool.ts` (round-robin, copy-in/transfer-out, sync fallback),
    wired via `platform.runImageOp`. Verified: registry parity + transfer
    round-trip tests, and the real Vite dev server transforms the worker chain.
- ✅ **1.3 parallel independent-branch execution** — the sweep runs each batch of
  independent ready nodes with `Promise.all`.
- ✅ **Phase 3** — AI result caching (deterministic/seeded runs, dedicated
  IndexedDB store); multiple named projects (own IndexedDB store).
- ✅ **Phase 4** — 3MF export (dependency-free STORED-zip writer); GitHub Pages
  static-deploy workflow (+ configurable base, base-aware SW).

### Still remaining (genuinely out of scope for this environment)

- **1.2 lossless premultiply boundary** — a 2D canvas re-premultiplies on
  readback; true losslessness needs a WebGL `readPixels` path (browser-only).
- **1.3 full executor unification** — collapsing status/epoch/controller into one
  queue is a pure refactor with high regression risk; bugs are already fixed.
- **Cost tracking** — honest version needs Replicate's per-prediction `metrics`
  plumbed through (can't validate without a live key).
- **Model schema discovery** — needs the proxy to fetch a model's OpenAPI schema
  (live API).
- **Batch/parameter-sweeps**, **curves/LUT/text-overlay/warp custom editors**,
  and a **plugin-loading API** (security surface) — larger UI/product work.

## Deferred — large infra (need dedicated effort; not safe to rush)

These are the analysis's own "1–2 week" items. Concrete plans below so they can be picked up directly.

### 1.1 — IndexedDB content-addressed blob store (biggest scalability unlock)

**Goal:** move image bytes out of the persisted graph so localStorage isn't the ~5 MB ceiling and every `set()` doesn't re-stringify multi-MB base64 (H4).

**Plan**

1. `src/lib/blobStore.ts` — `putBlob(bytes|dataUrl): Promise<hash>` (content hash, e.g. SHA-256 via `crypto.subtle`), `getBlob(hash)`, `refCount`/GC. IndexedDB object store `blobs` keyed by hash. Pure hashing split out for unit tests.
2. Extend the `Platform` seam with `putBlob`/`getBlob` so `lib/canvas.ts` provides the browser impl and tests inject a fake.
3. `imageInput` node: on upload, `putBlob` the data URL and store only `config.srcRef = hash` (keep reading legacy `config.src` data URLs for back-compat). `compute` resolves `srcRef → getBlob → decodeImage`.
4. Persistence: graph now holds refs (small). Add a `version` bump + migration (see 3.4).
5. **Export portability (the catch):** `exportGraph` must become async and inline referenced blobs back into the file (or offer "export with/without assets"); `loadGraph` re-`putBlob`s inlined data. This cascades to the Toolbar export handler.
6. Tests: add `fake-indexeddb` dev-dep; cover put/get/dedupe/GC and the imageInput back-compat path.

**Risk:** touches persistence, export/import, undo. Do behind the back-compat shim and land export changes in the same PR to avoid a portability regression.

### 1.2 — Web Worker pool for image ops (remainder)

**Plan**

1. `src/lib/imageWorker.ts` + a worker entry that owns a registry of the pure `lib/image.ts` ops keyed by name; transfer RGBA `ArrayBuffer`s (zero-copy) in and out.
2. A small pool (`navigator.hardwareConcurrency`) with a job queue; `platform.runOp(name, img, config)` returns a Promise.
3. Route auto-run image nodes' `compute` through the pool when a worker platform is installed; keep the sync path for Node/tests.
4. Vite worker import (`new Worker(new URL(...), { type: 'module' })`). jsdom can't run workers, so keep ops unit-tested directly and add a thin integration smoke via Playwright (see 1.5-e2e).

**Risk:** bundler/env-specific; not unit-testable in jsdom. Medium.

### 1.3 — Unify the executors

Phase 0 already closed the concrete concurrency bugs (H1 + supersede-clobber) via the controller-identity guard, so this is now a **maintainability refactor, not a bug fix**. Replace the status/epoch/controller triple-bookkeeping + two executors (`processAutoRun` sweep vs `runNode`/`bringUpToDate`) with a single work queue keyed by a per-node generation token; add stop-on-failed-ancestor policy and optional parallel execution of independent branches. Must keep all 30+ scheduler/store tests green — do it test-first.

## Not started — Phases 2–4

Editor UX (multi-select copy/paste, context menu, node bypass, minimap, a11y pass, AI progress), feature growth (result caching + gallery, batch/seed, new nodes, projects/migrations), and the "UV" texture pipeline / productization. These depend on product direction (esp. Phase 4) and are multi-week.

## Smaller follow-ups worth batching (from analysis §2.2–2.3)

- Stop-on-failed-ancestor in `runNode`/`bringUpToDate` (part of 1.3).
- `safeStorage` per-key pending slot; quota `notified` latch reset.
- `merge` should validate/whitelist persisted keys (not spread junk).
- Morphology radius cap; `crop` negative-origin clip; `hexToRgba` `#rgba`.
- OpenRouter attribution headers point at an unrelated repo.
- Persist `version`/`migrate`; bounded toasts; `registerNode` collision guard.
