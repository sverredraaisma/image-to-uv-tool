import { useState } from 'react';
import { useStore } from '../store/store';
import { fetchModelSchema, type ModelInputField } from '../lib/replicate';

/** For AI nodes: fetch the model's declared inputs (read-only) so the user can
 *  see the real input keys/types instead of guessing them for Extra-inputs. */
export function ModelSchemaHint({ model }: { model: string }) {
  const apiKey = useStore((s) => s.apiKey);
  const proxyUrl = useStore((s) => s.proxyUrl);
  const [fields, setFields] = useState<ModelInputField[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const discover = async () => {
    setLoading(true);
    setError(null);
    try {
      setFields(await fetchModelSchema(model, { apiKey, proxyUrl: proxyUrl || null }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

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
      {fields && fields.length === 0 && <div className="model-schema-note">No input schema found.</div>}
      {fields && fields.length > 0 && (
        <table className="model-schema-table">
          <tbody>
            {fields.map((f) => (
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
    </div>
  );
}
