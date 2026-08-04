import { registerNode, allNodeDefs } from '../engine/registry';
import { localNodes } from './local';
import { animationNodes } from './animation';
import { aiNodes } from './ai';
import { llmNodes } from './llm';
import { lenticularNodes } from './lenticular';
import { lensGridNodes } from './lensGrid';
import { radialGridNodes } from './radialGrid';
import { model3dNodes } from './model3d';
import { modelStereoNodes } from './modelStereo';
import { depthStereoNodes } from './depthStereo';
import { splatNodes } from './splat';
import { pipelineNodes } from './pipeline';

let registered = false;

/** Register every built-in node definition (idempotent). */
export function registerBuiltinNodes(): void {
  if (registered) return;
  const all = [
    ...localNodes,
    ...animationNodes,
    ...aiNodes,
    ...llmNodes,
    ...lenticularNodes,
    ...lensGridNodes,
    ...radialGridNodes,
    ...model3dNodes,
    ...modelStereoNodes,
    ...depthStereoNodes,
    ...splatNodes,
    ...pipelineNodes,
  ];
  for (const def of all) {
    registerNode(def);
  }
  registered = true;
}

registerBuiltinNodes();

export { allNodeDefs };
