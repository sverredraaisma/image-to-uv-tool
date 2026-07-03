import { registerNode, allNodeDefs } from '../engine/registry';
import { localNodes } from './local';
import { aiNodes } from './ai';
import { llmNodes } from './llm';

let registered = false;

/** Register every built-in node definition (idempotent). */
export function registerBuiltinNodes(): void {
  if (registered) return;
  for (const def of [...localNodes, ...aiNodes, ...llmNodes]) registerNode(def);
  registered = true;
}

registerBuiltinNodes();

export { allNodeDefs };
