import { useMemo, useState } from 'react';
import { allNodeDefs } from '../engine/registry';
import { buildNodeMenu, type MenuCategory } from './nodeMenu';

/** Searchable, multi-layered node menu shared by the toolbar "Add node" button
 *  and the canvas right-click menu. Browsing drills category → nodes; typing a
 *  query flattens to matching results across all categories. */
export function NodePicker({ onPick, onClose }: { onPick: (type: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const nodes = useMemo(() => allNodeDefs(), []);
  const menu = buildNodeMenu(nodes, query);
  const searching = query.trim().length > 0;

  const countItems = (cat: MenuCategory) => cat.groups.reduce((n, g) => n + g.items.length, 0);

  const renderCategoryBody = (cat: MenuCategory) => (
    <div className="menu-group" key={cat.category}>
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
  );

  const drilled = !searching && activeCategory ? menu.find((c) => c.category === activeCategory) : null;

  return (
    <div className="add-node-menu">
      <input
        className="menu-search nodrag"
        autoFocus
        placeholder="Search nodes…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            if (activeCategory && !searching) setActiveCategory(null);
            else onClose();
          } else if (e.key === 'Enter' && searching) {
            const first = menu[0]?.groups[0]?.items[0];
            if (first) onPick(first.type);
          }
        }}
      />

      {menu.length === 0 && <div className="menu-empty">No matching nodes</div>}

      {/* Searching → flat results across every category. */}
      {searching &&
        menu.map((cat) => (
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

      {/* Browsing, drilled into a category → its nodes + a back button. */}
      {drilled && (
        <>
          <button type="button" className="menu-back" onClick={() => setActiveCategory(null)}>
            ‹ All categories
          </button>
          <div className="menu-group-title">{drilled.category}</div>
          {renderCategoryBody(drilled)}
        </>
      )}

      {/* Browsing, top level → category list. */}
      {!searching &&
        !activeCategory &&
        menu.map((cat) => (
          <button
            key={cat.category}
            type="button"
            className="menu-category"
            onClick={() => setActiveCategory(cat.category)}
          >
            <span>{cat.category}</span>
            <span className="menu-category-meta">
              {countItems(cat)} <span className="menu-chevron">›</span>
            </span>
          </button>
        ))}
    </div>
  );
}
