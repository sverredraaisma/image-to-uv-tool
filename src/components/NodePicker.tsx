import { useMemo, useState } from 'react';
import { allNodeDefs } from '../engine/registry';
import { buildNodeMenu } from './nodeMenu';

/** Searchable node list shared by the toolbar "Add node" menu and the canvas
 *  right-click context menu. Calls `onPick` with the chosen node type. */
export function NodePicker({ onPick, onClose }: { onPick: (type: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const nodes = useMemo(() => allNodeDefs(), []);
  const menu = buildNodeMenu(nodes, query);

  return (
    <div className="add-node-menu" onClick={(e) => e.stopPropagation()}>
      <input
        className="menu-search nodrag"
        autoFocus
        placeholder="Search nodes…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          else if (e.key === 'Enter' && query.trim()) {
            const first = menu[0]?.groups[0]?.items[0];
            if (first) onPick(first.type);
          }
        }}
      />
      {menu.length === 0 && <div className="menu-empty">No matching nodes</div>}
      {menu.map((cat) => (
        <div className="menu-group" key={cat.category}>
          <div className="menu-group-title">{cat.category}</div>
          {cat.groups.map((g) => (
            <div key={g.group || '_'}>
              {g.group && <div className="menu-subgroup-title">{g.group}</div>}
              {g.items.map((item) => (
                <button
                  key={item.type}
                  type="button"
                  className="menu-item"
                  title={item.description}
                  onClick={() => onPick(item.type)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
