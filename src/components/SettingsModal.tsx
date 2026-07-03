import { useStore } from '../store/store';
import { getNodeDefSafe } from '../engine/registry';
import { ConfigFields } from './ConfigFields';
import { AreaPickerEditor } from './AreaPickerEditor';

export function SettingsModal() {
  const editorNodeId = useStore((s) => s.editorNodeId);
  const node = useStore((s) => s.nodes.find((n) => n.id === editorNodeId));
  const close = useStore((s) => s.openEditor);

  if (!editorNodeId || !node) return null;
  const def = getNodeDefSafe(node.type);
  if (!def) return null;

  const isAreaPicker = def.customEditor === 'areaPicker';

  return (
    <div className="modal-backdrop" onClick={() => close(null)}>
      <div
        className={`modal settings-modal ${isAreaPicker ? 'modal-wide' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span>{def.label} · settings</span>
          <button type="button" className="icon-btn" onClick={() => close(null)}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {isAreaPicker ? (
            <AreaPickerEditor nodeId={editorNodeId} />
          ) : (
            <ConfigFields nodeId={editorNodeId} fields={def.configFields ?? []} config={node.config} />
          )}
        </div>
      </div>
    </div>
  );
}
