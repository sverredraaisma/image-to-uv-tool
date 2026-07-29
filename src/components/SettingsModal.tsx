import { useStore } from '../store/store';
import { getNodeDefSafe } from '../engine/registry';
import { ConfigFields } from './ConfigFields';
import { AreaPickerEditor } from './AreaPickerEditor';
import { SplitRegionEditor } from './SplitRegionEditor';
import { CurvesEditor } from './CurvesEditor';
import { Gloss3DEditor } from './Gloss3DEditor';
import { LenticularEditor, LensGridEditor } from './LenticularEditor';
import { ModelSchemaHint } from './ModelSchemaHint';
import { Modal } from './Modal';

export function SettingsModal() {
  const editorNodeId = useStore((s) => s.editorNodeId);
  const node = useStore((s) => s.nodes.find((n) => n.id === editorNodeId));
  const close = useStore((s) => s.openEditor);

  if (!editorNodeId || !node) return null;
  const def = getNodeDefSafe(node.type);
  if (!def) return null;

  const isAreaPicker = def.customEditor === 'areaPicker';
  const isSplitRegion = def.customEditor === 'splitRegion';
  const isGloss3d = def.customEditor === 'gloss3d';
  const isAi = def.category === 'AI (Replicate)';

  return (
    <Modal
      title={`${def.label} · settings`}
      onClose={() => close(null)}
      className="settings-modal"
      wide={isAreaPicker || isSplitRegion || isGloss3d}
    >
      {isAreaPicker ? (
        <AreaPickerEditor nodeId={editorNodeId} />
      ) : (
        <>
          <ConfigFields
            nodeId={editorNodeId}
            fields={def.configFields ?? []}
            config={node.config}
            collapseAdvanced
          />
          {def.customEditor === 'curves' && <CurvesEditor nodeId={editorNodeId} />}
          {isSplitRegion && <SplitRegionEditor nodeId={editorNodeId} />}
          {isGloss3d && <Gloss3DEditor nodeId={editorNodeId} />}
          {def.customEditor === 'lenticular' && <LenticularEditor nodeId={editorNodeId} />}
          {def.customEditor === 'lensGrid' && <LensGridEditor nodeId={editorNodeId} />}
          {isAi && <ModelSchemaHint nodeId={editorNodeId} model={String(node.config.model ?? '')} />}
        </>
      )}
    </Modal>
  );
}
