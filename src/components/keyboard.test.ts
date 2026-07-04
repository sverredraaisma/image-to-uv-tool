import { describe, it, expect, vi } from 'vitest';
import { escapeTarget, handleShortcut, type ShortcutEvent } from './keyboard';

const ev = (over: Partial<ShortcutEvent>): ShortcutEvent => ({
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  key: 'z',
  target: null,
  ...over,
});
const actions = () => ({ undo: vi.fn(), redo: vi.fn(), duplicateSelected: vi.fn() });

describe('handleShortcut', () => {
  it('Ctrl+Z undoes; Cmd+Z too', () => {
    const a = actions();
    expect(handleShortcut(ev({ ctrlKey: true }), a)).toBe(true);
    handleShortcut(ev({ metaKey: true }), a);
    expect(a.undo).toHaveBeenCalledTimes(2);
    expect(a.redo).not.toHaveBeenCalled();
  });

  it('Ctrl+Shift+Z and Ctrl+Y redo', () => {
    const a = actions();
    handleShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'Z' }), a);
    handleShortcut(ev({ ctrlKey: true, key: 'y' }), a);
    expect(a.redo).toHaveBeenCalledTimes(2);
    expect(a.undo).not.toHaveBeenCalled();
  });

  it('Ctrl+D duplicates the selection', () => {
    const a = actions();
    expect(handleShortcut(ev({ ctrlKey: true, key: 'd' }), a)).toBe(true);
    expect(a.duplicateSelected).toHaveBeenCalledTimes(1);
  });

  it('ignores plain keys and text fields', () => {
    const a = actions();
    expect(handleShortcut(ev({ ctrlKey: false }), a)).toBe(false);
    expect(handleShortcut(ev({ ctrlKey: true, target: { tagName: 'INPUT' } }), a)).toBe(false);
    expect(handleShortcut(ev({ ctrlKey: true, target: { tagName: 'TEXTAREA' } }), a)).toBe(false);
    expect(a.undo).not.toHaveBeenCalled();
    expect(a.duplicateSelected).not.toHaveBeenCalled();
  });
});

describe('escapeTarget', () => {
  it('prioritises preview > editor > pending, else null', () => {
    expect(escapeTarget({ hasPreview: true, hasEditor: true, hasPending: true })).toBe('preview');
    expect(escapeTarget({ hasPreview: false, hasEditor: true, hasPending: true })).toBe('editor');
    expect(escapeTarget({ hasPreview: false, hasEditor: false, hasPending: true })).toBe('pending');
    expect(escapeTarget({ hasPreview: false, hasEditor: false, hasPending: false })).toBe(null);
  });
});
