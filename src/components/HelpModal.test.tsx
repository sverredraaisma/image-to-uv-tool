import { describe, it, expect, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../nodes'; // register built-ins
import { HelpModal } from './HelpModal';
import { NODE_HELP } from './nodeHelp';
import { useStore } from '../store/store';

afterEach(() => useStore.getState().openHelp(null));

describe('HelpModal', () => {
  it('renders nothing until a node type asks for help', () => {
    const { container } = render(<HelpModal />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the summary, the worked examples and their chains', () => {
    useStore.getState().openHelp('lenticular');
    render(<HelpModal />);
    expect(screen.getByText(/Lenticular Print · what is this\?/)).toBeInTheDocument();
    expect(screen.getByText(NODE_HELP.lenticular.summary)).toBeInTheDocument();
    for (const use of NODE_HELP.lenticular.uses) {
      expect(screen.getByText(use.title)).toBeInTheDocument();
    }
    expect(screen.getByText(/Animation Input\s+→\s+Lenticular Print/)).toBeInTheDocument();
  });

  it('reports how the node runs and what its ports are', () => {
    useStore.getState().openHelp('lenticular');
    render(<HelpModal />);
    expect(screen.getByText('Manual — press Run ▶')).toBeInTheDocument();
    expect(screen.getByText('Frames')).toBeInTheDocument();
    expect(screen.getByText('Gloss depth')).toBeInTheDocument();
    expect(screen.getAllByText('required').length).toBeGreaterThan(0);
  });

  it('says so when a node takes no inputs', () => {
    useStore.getState().openHelp('animationInput');
    render(<HelpModal />);
    expect(screen.getByText(/none — this is a source node/)).toBeInTheDocument();
    expect(screen.getByText('Runs automatically')).toBeInTheDocument();
  });

  it('closes from the ✕ button', async () => {
    useStore.getState().openHelp('blur');
    render(<HelpModal />);
    await userEvent.click(screen.getByLabelText('Close'));
    expect(useStore.getState().helpNodeType).toBeNull();
  });

  it('ignores a node type that is not registered, and does not stay half-open', () => {
    useStore.getState().openHelp('nope');
    const { container } = render(<HelpModal />);
    expect(container).toBeEmptyDOMElement();
    // Nothing is on screen, so nothing may think a window is open either —
    // otherwise Escape would be swallowed by an invisible modal.
    expect(useStore.getState().helpNodeType).toBeNull();
  });
});
