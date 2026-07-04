import { useState } from 'react';
import { useStore } from '../store/store';
import { fetchModelSchema, type ModelSchema } from '../lib/replicate';

/** For AI nodes: fetch the model's latest version + declared inputs (read-only)
 *  so the user can see the real input keys and pin the floating "latest". */
export function ModelSchemaHint({ nodeId, model }: { nodeId: string; model: string }) {
  const apiKey = useStore((s) => s.apiKey);
  const proxyUrl = useStore((s) => s.proxyUrl);
  const updateNodeConfig = useStore((s) => s.updateNodeConfig);
  const [schema, setSchema] = useState<ModelSchema | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const discover = async () => {
    setLoading(true);
    setError(null);
    try {
      setSchema(await fetchModelSchema(model, { apiKey, proxyUrl: proxyUrl || null }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const slug = model.split(':')[0];
  const isPinned = model.includes(':');

  return (
    <div className="model-schema">
      <button
        type="button"
        className="btn nodrag"
        onClick={() => void discover()}
        disabled={loading || !apiKey}
      >
        {loading ? 'Fetching…' : 'Discover model inputs'}
      </button>
      {!apiKey && <span className="model-schema-note">Set your Replicate key first.</span>}
      {error && <div className="node-error-msg">{error}</div>}
      {schema && (
        <>
          {schema.latestVersion && (
            <div className="model-schema-version">
              {isPinned ? (
                <span className="model-schema-note">Pinned to a specific version.</span>
              ) : (
                <>
                  <span className="model-schema-note">
                    Floats to latest ({schema.latestVersion.slice(0, 12)}…).
                  </span>
                  <button
                    type="button"
                    className="btn nodrag"
                    onClick={() => updateNodeConfig(nodeId, { model: `${slug}:${schema.latestVersion}` })}
                  >
                    Pin this version
                  </button>
                </>
              )}
            </div>
          )}
          {schema.fields.length === 0 && <div className="model-schema-note">No input schema found.</div>}
          {schema.fields.length > 0 && (
            <table className="model-schema-table">
              <tbody>
                {schema.fields.map((f) => (
                  <tr key={f.name}>
                    <td className="model-schema-key">
                      {f.name}
                      {f.required && <span className="port-required"> *</span>}
                    </td>
                    <td className="model-schema-type">
                      {f.enumValues ? f.enumValues.join(' | ') : f.type}
                      {f.default !== undefined ? ` = ${JSON.stringify(f.default)}` : ''}
                    </td>
                    <td className="model-schema-desc" title={f.description ?? ''}>
                      {f.description ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}
