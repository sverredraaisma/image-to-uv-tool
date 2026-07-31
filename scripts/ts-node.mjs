// Registers the resolve hook, so `node --import ./scripts/ts-node.mjs x.ts`
// can run a script that imports the app's TypeScript directly. Kept separate
// from the hook itself because `register()` loads hooks in their own thread.
import { register } from 'node:module';

register('./ts-resolve.mjs', import.meta.url);
