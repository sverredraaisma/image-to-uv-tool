import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from './Modal';

describe('Modal accessibility', () => {
  it('exposes dialog semantics and a label from a string title', () => {
    render(
      <Modal title="Settings" onClose={() => {}}>
        <button>Inside</button>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'Settings');
  });

  it('moves focus into the dialog on open', () => {
    render(
      <Modal title="X" onClose={() => {}}>
        <button>Inside</button>
      </Modal>,
    );
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    render(
      <Modal title="X" onClose={onClose}>
        <button>Inside</button>
      </Modal>,
    );
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
