// Resolve hook: lets `node` import the tool's own TypeScript out of src/.
//
// Node strips types by itself, but it resolves imports the way the web does —
// `./image` is a file called `image`, not `image.ts`. Vite fills that gap for
// the browser build; this fills it for scripts, so a CLI can import the very
// modules the app uses instead of carrying a second copy of the arithmetic.
//
// Nothing is compiled and nothing is written: the hook only appends `.ts` (or
// `/index.ts`) when a relative specifier does not resolve on its own. Loaded by
// ts-node.mjs, which is what the `dolly` script passes to --import.
//
// One rule to keep in mind while editing src/: Node's type stripping is
// *erasure only* — no enums, no namespaces, no constructor parameter
// properties. The repo stays inside that subset.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CANDIDATES = ['.ts', '.tsx', '/index.ts'];

export async function resolve(specifier, context, nextResolve) {
  const relative = specifier.startsWith('.') || specifier.startsWith('/');
  if (relative && !/\.[cm]?[jt]sx?$/i.test(specifier) && context.parentURL) {
    for (const suffix of CANDIDATES) {
      const url = new URL(specifier + suffix, context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
