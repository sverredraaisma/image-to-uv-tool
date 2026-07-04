import { useStore } from '../store/store';
import { getNodeDefSafe } from '../engine/registry';
import { ConfigFields } from './ConfigFields';
import { AreaPickerEditor } from './AreaPickerEditor';
import { Modal } from './Modal';

export function SettingsModal() {
  const editorNodeId = useStore((s) => s.editorNodeId);
  const node = useStore((s) => s.nodes.find((n) => n.id === editorNodeId));
  const close = useStore((s) => s.openEditor);

  if (!editorNodeId || !node) return null;
  const def = getNodeDefSafe(node.type);
  if (!def) return null;

  const isAreaPicker = def.customEditor === 'areaPicker';

  return (
    <Modal
      title={`${def.label} · settings`}
      onClose={() => close(null)}
      className="settings-modal"
      wide={isAreaPicker}
    >
      {isAreaPicker ? (
        <AreaPickerEditor nodeId={editorNodeId} />
      ) : (
        <ConfigFields
          nodeId={editorNodeId}
          fields={def.configFields ?? []}
          config={node.config}
          collapseAdvanced
        />
      )}
    </Modal>
  );
}
