import { useEffect, useRef, useState } from 'react';
import type { ConfigField, NodeConfig } from '../types';
import { useStore } from '../store/store';

/** Debounce window (ms) before a typed value is committed to the store. */
const COMMIT_DEBOUNCE_MS = 200;

/**
 * A text/number/textarea control whose keystrokes are held locally and only
 * committed to the store after a short pause. Committing is what triggers the
 * (potentially expensive, full-raster) recompute, so debouncing here stops a
 * held key from re-running downstream image ops on every character (H3).
 */
function DebouncedTextControl({
  kind,
  value,
  placeholder,
  onCommit,
}: {
  kind: 'number' | 'text' | 'textarea';
  value: string;
  placeholder?: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  // Resync when the value changes underneath us (undo/redo/load), but not from
  // our own commit (which already matches the draft).
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setDraft(value);
    }
  }, [value]);

  // Flush a pending edit on unmount so closing a popup mid-type isn't lost.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    },
    [],
  );

  const schedule = (v: string) => {
    setDraft(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      committed.current = v;
      onCommitRef.current(v);
    }, COMMIT_DEBOUNCE_MS);
  };

  const flush = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
      committed.current = draft;
      onCommitRef.current(draft);
    }
  };

  if (kind === 'textarea') {
    return (
      <textarea
        className="nodrag"
        value={draft}
        placeholder={placeholder}
        rows={3}
        onChange={(e) => schedule(e.target.value)}
        onBlur={flush}
      />
    );
  }
  return (
    <input
      type="text"
      inputMode={kind === 'number' ? 'decimal' : undefined}
      className="nodrag"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => schedule(e.target.value)}
      onBlur={flush}
    />
  );
}

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
          <DebouncedTextControl
            kind="number"
            value={value == null ? '' : String(value)}
            placeholder={field.min != null ? String(field.min) : ''}
            onCommit={set}
          />
        )}
        {field.kind === 'text' && !field.multiline && (
          <DebouncedTextControl
            kind="text"
            value={String(value ?? '')}
            placeholder={field.placeholder}
            onCommit={set}
          />
        )}
        {field.kind === 'text' && field.multiline && (
          <DebouncedTextControl
            kind="textarea"
            value={String(value ?? '')}
            placeholder={field.placeholder}
            onCommit={set}
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
