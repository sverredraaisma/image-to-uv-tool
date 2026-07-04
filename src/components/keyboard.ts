// Pure keyboard mapping for editor shortcuts, so it's testable without a DOM.

export interface ShortcutEvent {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  key: string;
  target: { tagName?: string } | null;
}

export interface ShortcutActions {
  undo: () => void;
  redo: () => void;
  duplicateSelected: () => void;
  copy: () => void;
  paste: () => void;
}

/**
 * Ctrl/Cmd + Z = undo, +Shift+Z or +Y = redo, +D = duplicate, +C/+V =
 * copy/paste selected nodes. Ignored while a text field is focused (keeps
 * native shortcuts). Returns true if handled (so the caller can preventDefault).
 */
export function handleShortcut(e: ShortcutEvent, actions: ShortcutActions): boolean {
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
  if (key === 'd') {
    actions.duplicateSelected();
    return true;
  }
  if (key === 'c') {
    actions.copy();
    return true;
  }
  if (key === 'v') {
    actions.paste();
    return true;
  }
  return false;
}

export interface EscapeState {
  hasPreview: boolean;
  hasEditor: boolean;
  hasPending: boolean;
}

/**
 * What a top-level Escape should dismiss, most-modal first: the preview modal,
 * then the settings editor, then an in-progress connection. `null` = nothing.
 */
export function escapeTarget(s: EscapeState): 'preview' | 'editor' | 'pending' | null {
  if (s.hasPreview) return 'preview';
  if (s.hasEditor) return 'editor';
  if (s.hasPending) return 'pending';
  return null;
}
