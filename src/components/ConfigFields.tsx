import type { ConfigField, NodeConfig } from '../types';
import { useStore } from '../store/store';

/** Renders declarative config controls for a node. */
export function ConfigFields({
  nodeId,
  fields,
  config,
  collapseAdvanced = false,
}: {
  nodeId: string;
  fields: ConfigField[];
  config: NodeConfig;
  /** Tuck fields marked `advanced` behind a collapsible "Advanced" section. */
  collapseAdvanced?: boolean;
}) {
  const updateNodeConfig = useStore((s) => s.updateNodeConfig);
  if (fields.length === 0) return null;

  const renderField = (field: ConfigField) => {
    const value = config[field.key];
    const set = (v: unknown) => updateNodeConfig(nodeId, { [field.key]: v });
    return (
      <label className="config-field" key={field.key}>
        <span className="config-label">{field.label}</span>
        {field.kind === 'number' && (
          <input
            type="text"
            inputMode="decimal"
            className="nodrag"
            value={value == null ? '' : String(value)}
            placeholder={field.min != null ? String(field.min) : ''}
            onChange={(e) => set(e.target.value)}
          />
        )}
        {field.kind === 'text' && !field.multiline && (
          <input
            type="text"
            className="nodrag"
            value={String(value ?? '')}
            placeholder={field.placeholder}
            onChange={(e) => set(e.target.value)}
          />
        )}
        {field.kind === 'text' && field.multiline && (
          <textarea
            className="nodrag"
            value={String(value ?? '')}
            placeholder={field.placeholder}
            rows={3}
            onChange={(e) => set(e.target.value)}
          />
        )}
        {field.kind === 'select' && (
          <select className="nodrag" value={String(value ?? '')} onChange={(e) => set(e.target.value)}>
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        {field.kind === 'boolean' && (
          <input
            type="checkbox"
            className="nodrag"
            checked={Boolean(value)}
            onChange={(e) => set(e.target.checked)}
          />
        )}
        {field.kind === 'color' && (
          <input
            type="color"
            className="nodrag"
            value={String(value ?? '#000000')}
            onChange={(e) => set(e.target.value)}
          />
        )}
      </label>
    );
  };

  if (!collapseAdvanced) {
    return <div className="config-fields">{fields.map(renderField)}</div>;
  }

  const main = fields.filter((f) => !f.advanced);
  const advanced = fields.filter((f) => f.advanced);
  return (
    <div className="config-fields">
      {main.map(renderField)}
      {advanced.length > 0 && (
        <details className="config-advanced">
          <summary>Advanced</summary>
          {advanced.map(renderField)}
        </details>
      )}
    </div>
  );
}
