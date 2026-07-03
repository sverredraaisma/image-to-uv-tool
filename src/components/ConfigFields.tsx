import type { ConfigField, NodeConfig } from '../types';
import { useStore } from '../store/store';

/** Renders declarative config controls for a node. */
export function ConfigFields({
  nodeId,
  fields,
  config,
}: {
  nodeId: string;
  fields: ConfigField[];
  config: NodeConfig;
}) {
  const updateNodeConfig = useStore((s) => s.updateNodeConfig);
  if (fields.length === 0) return null;

  return (
    <div className="config-fields">
      {fields.map((field) => {
        const value = config[field.key];
        const set = (v: unknown) => updateNodeConfig(nodeId, { [field.key]: v });
        return (
          <label className="config-field" key={field.key}>
            <span className="config-label">{field.label}</span>
            {field.kind === 'number' && (
              <input
                type="number"
                className="nodrag"
                value={value == null ? '' : Number(value)}
                min={field.min}
                max={field.max}
                step={field.step ?? 1}
                onChange={(e) => set(e.target.value === '' ? 0 : Number(e.target.value))}
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
              <select
                className="nodrag"
                value={String(value ?? '')}
                onChange={(e) => set(e.target.value)}
              >
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
      })}
    </div>
  );
}
