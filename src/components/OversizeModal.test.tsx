import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OversizeModal } from './OversizeModal';
import { useStore, type OversizeRequest } from '../store/store';

const request = (over: Partial<OversizeRequest> = {}): OversizeRequest => ({
  nodeId: 'n1',
  label: 'Lens Grid Print',
  what: 'Interlaced artwork',
  width: 20_000,
  height: 15_000,
  chunks: 75,
  fix: 'Reduce Width (mm), PPI, LPI, the grid or the source size',
  retry: vi.fn(),
  ...over,
});

afterEach(() => useStore.getState().dismissOversize());

describe('OversizeModal', () => {
  it('renders nothing until something asks', () => {
    const { container } = render(<OversizeModal />);
    expect(container).toBeEmptyDOMElement();
  });

  it('says how big, how many chunks, and what to change instead', () => {
    useStore.getState().requestOversize(request({ nodeId: 'size' }));
    const { container } = render(<OversizeModal />);
    expect(screen.getByText(/Lens Grid Print: that is a big render/)).toBeInTheDocument();
    const text = container.textContent ?? '';
    // Grouped for readability, in whatever the runtime's locale groups with.
    expect(text).toMatch(/20[.,]000/);
    expect(text).toMatch(/15[.,]000/);
    expect(text).toMatch(/300 megapixels/);
    expect(text).toMatch(/75 chunks/);
    expect(text).toMatch(/interlaced artwork/);
    expect(text).toMatch(/reduce width \(mm\), ppi, lpi/i);
    expect(screen.getByRole('button', { name: /Render in 75 chunks/ })).toBeInTheDocument();
  });

  it('starts the work again when the user agrees', async () => {
    const retry = vi.fn();
    useStore.getState().requestOversize(request({ nodeId: 'yes', retry }));
    render(<OversizeModal />);
    await userEvent.click(screen.getByRole('button', { name: /Render in 75 chunks/ }));
    expect(retry).toHaveBeenCalledOnce();
    expect(useStore.getState().oversize).toBeNull();
    expect(useStore.getState().oversizeAllowed('yes')).toBe(true);
  });

  it('does nothing at all when the user declines', async () => {
    const retry = vi.fn();
    useStore.getState().requestOversize(request({ nodeId: 'no', retry }));
    render(<OversizeModal />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(retry).not.toHaveBeenCalled();
    expect(useStore.getState().oversize).toBeNull();
    expect(useStore.getState().oversizeAllowed('no')).toBe(false);
  });
});
