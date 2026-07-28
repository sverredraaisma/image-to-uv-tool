import { registerNode, allNodeDefs } from '../engine/registry';
import { localNodes } from './local';
import { aiNodes } from './ai';
import { llmNodes } from './llm';
import { lenticularNodes } from './lenticular';
import { pipelineNodes } from './pipeline';

let registered = false;

/** Register every built-in node definition (idempotent). */
export function registerBuiltinNodes(): void {
  if (registered) return;
  for (const def of [...localNodes, ...aiNodes, ...llmNodes, ...lenticularNodes, ...pipelineNodes]) {
    registerNode(def);
  }
  registered = true;
}

registerBuiltinNodes();

export { allNodeDefs };
