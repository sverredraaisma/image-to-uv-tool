import { useStore } from '../store/store';
import { getNodeDefSafe } from '../engine/registry';
import { helpFor } from './nodeHelp';
import { Modal } from './Modal';

/**
 * The window behind every node's ? button: what the node is, what people build
 * with it, and its ports and settings at a glance.
 *
 * Keyed by node *type*, not by node id — help describes the definition, so it
 * survives deleting the node you opened it from.
 */
export function HelpModal() {
  const type = useStore((s) => s.helpNodeType);
  const openHelp = useStore((s) => s.openHelp);

  if (!type) return null;
  const def = getNodeDefSafe(type);
  if (!def) return null;
  const help = helpFor(def);
  const fields = def.configFields ?? [];

  return (
    <Modal
      title={`${def.label} · what is this?`}
      onClose={() => openHelp(null)}
      className="help-modal"
      bodyClassName="help-body"
      wide
    >
      <div className="help-badges">
        <span className="help-badge">{def.category}</span>
        {def.group && <span className="help-badge">{def.group}</span>}
        <span className="help-badge">{def.autoRun ? 'Runs automatically' : 'Manual — press Run ▶'}</span>
        {def.genAI && <span className="help-badge help-badge-ai">Gen AI</span>}
        {def.customEditor && <span className="help-badge">Has an editor</span>}
      </div>

      <p className="help-summary">{help.summary}</p>

      <h4 className="help-heading">What it&apos;s for</h4>
      <ul className="help-uses">
        {help.uses.map((use) => (
          <li key={use.title}>
            <strong>{use.title}</strong> — {use.detail}
            {use.chain && <div className="help-chain">{use.chain.join('  →  ')}</div>}
          </li>
        ))}
      </ul>

      {help.tips && help.tips.length > 0 && (
        <>
          <h4 className="help-heading">Worth knowing</h4>
          <ul className="help-tips">
            {help.tips.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        </>
      )}

      <h4 className="help-heading">Ports</h4>
      <div className="help-ports">
        <div>
          <span className="help-ports-label">Inputs</span>
          {def.inputs.length === 0 ? (
            <div className="help-port help-port-none">none — this is a source node</div>
          ) : (
            def.inputs.map((p) => (
              <div className="help-port" key={p.id}>
                {p.label} <span className="help-port-type">{p.type}</span>
                {p.required && <span className="help-port-flag">required</span>}
                {p.multiple && <span className="help-port-flag">many</span>}
              </div>
            ))
          )}
        </div>
        <div>
          <span className="help-ports-label">Outputs</span>
          {def.outputs.length === 0 ? (
            <div className="help-port help-port-none">none</div>
          ) : (
            def.outputs.map((p) => (
              <div className="help-port" key={p.id}>
                {p.label} <span className="help-port-type">{p.type}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {fields.length > 0 && (
        <>
          <h4 className="help-heading">Settings</h4>
          <p className="help-settings">
            {fields.map((f) => f.label + (f.advanced ? ' (advanced)' : '')).join(' · ')}
          </p>
        </>
      )}

      {def.description && <p className="help-description">{def.description}</p>}
    </Modal>
  );
}
