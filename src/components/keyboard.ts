// Pure keyboard mapping for undo/redo, so it's testable without a real DOM.

export interface UndoRedoKeyEvent {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  key: string;
  target: { tagName?: string } | null;
}

/**
 * Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y = redo. Ignored while a
 * text field is focused so it keeps native text undo. Returns true if handled.
 */
export function handleUndoRedoKey(
  e: UndoRedoKeyEvent,
  actions: { undo: () => void; redo: () => void },
): boolean {
  if (!(e.ctrlKey || e.metaKey)) return false;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return false;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) {
    actions.undo();
    return true;
  }
  if ((key === 'z' && e.shiftKey) || key === 'y') {
    actions.redo();
    return true;
  }
  return false;
}
