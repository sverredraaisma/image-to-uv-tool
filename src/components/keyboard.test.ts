import { describe, it, expect, vi } from 'vitest';
import { handleUndoRedoKey, type UndoRedoKeyEvent } from './keyboard';

const ev = (over: Partial<UndoRedoKeyEvent>): UndoRedoKeyEvent => ({
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  key: 'z',
  target: null,
  ...over,
});

describe('handleUndoRedoKey', () => {
  it('Ctrl+Z undoes; Cmd+Z too', () => {
    const undo = vi.fn();
    const redo = vi.fn();
    expect(handleUndoRedoKey(ev({ ctrlKey: true }), { undo, redo })).toBe(true);
    handleUndoRedoKey(ev({ metaKey: true }), { undo, redo });
    expect(undo).toHaveBeenCalledTimes(2);
    expect(redo).not.toHaveBeenCalled();
  });

  it('Ctrl+Shift+Z and Ctrl+Y redo', () => {
    const undo = vi.fn();
    const redo = vi.fn();
    handleUndoRedoKey(ev({ ctrlKey: true, shiftKey: true, key: 'Z' }), { undo, redo });
    handleUndoRedoKey(ev({ ctrlKey: true, key: 'y' }), { undo, redo });
    expect(redo).toHaveBeenCalledTimes(2);
    expect(undo).not.toHaveBeenCalled();
  });

  it('ignores plain keys and text fields', () => {
    const undo = vi.fn();
    const redo = vi.fn();
    expect(handleUndoRedoKey(ev({ ctrlKey: false }), { undo, redo })).toBe(false);
    expect(handleUndoRedoKey(ev({ ctrlKey: true, target: { tagName: 'INPUT' } }), { undo, redo })).toBe(false);
    expect(handleUndoRedoKey(ev({ ctrlKey: true, target: { tagName: 'TEXTAREA' } }), { undo, redo })).toBe(false);
    expect(undo).not.toHaveBeenCalled();
  });
});
