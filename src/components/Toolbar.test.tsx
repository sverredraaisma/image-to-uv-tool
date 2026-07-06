import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toolbar } from './Toolbar';
import { useStore } from '../store/store';

beforeEach(() => {
  localStorage.clear();
  useStore.getState().reset();
  useStore.setState({ apiKey: '', proxyUrl: '' });
});

describe('Toolbar', () => {
  it('writes the API key into the store', async () => {
    render(<Toolbar />);
    await userEvent.type(screen.getByPlaceholderText('r8_…'), 'r8_secret');
    expect(useStore.getState().apiKey).toBe('r8_secret');
  });

  it('opens the multi-layered add-node menu showing categories, then drills in', async () => {
    render(<Toolbar />);
    await userEvent.click(screen.getByText('+ Add node'));
    // top level shows categories, not individual nodes
    expect(screen.getByText('Input')).toBeInTheDocument();
    expect(screen.getByText('AI (Replicate)')).toBeInTheDocument();
    expect(screen.queryByText('Image Input')).not.toBeInTheDocument();
    // drill into a category to reveal its nodes
    await userEvent.click(screen.getByText('Input'));
    expect(screen.getByText('Image Input')).toBeInTheDocument();
    expect(screen.getByText('‹ All categories')).toBeInTheDocument();
  });

  it('adds a node to the store when picked from a drilled-in category', async () => {
    render(<Toolbar />);
    await userEvent.click(screen.getByText('+ Add node'));
    await userEvent.click(screen.getByText('Input'));
    await userEvent.click(screen.getByText('Prompt Input'));
    expect(useStore.getState().nodes).toHaveLength(1);
    expect(useStore.getState().nodes[0].type).toBe('promptInput');
  });

  it('Enter adds the top search match', async () => {
    render(<Toolbar />);
    await userEvent.click(screen.getByText('+ Add node'));
    await userEvent.type(screen.getByPlaceholderText('Search nodes…'), 'flux{Enter}');
    expect(useStore.getState().nodes).toHaveLength(1);
    expect(useStore.getState().nodes[0].type.toLowerCase()).toContain('flux');
  });

  it('loads an example workflow from the Examples menu (no confirm on an empty canvas)', async () => {
    render(<Toolbar />);
    expect(useStore.getState().nodes).toHaveLength(0);
    await userEvent.click(screen.getByText('Examples ▾'));
    await userEvent.click(screen.getByText('Spot gloss — relief peaks'));
    // The example graph replaced the (empty) workspace with its nodes.
    const types = useStore.getState().nodes.map((n) => n.type);
    expect(types).toContain('glossPreview');
    expect(types).toContain('autoThreshold');
  });

  it('loading a graph with an invalid node reports the dropped count', async () => {
    const { container } = render(<Toolbar />);
    const graph = {
      version: 1,
      nodes: [
        { id: 'a', type: 'promptInput', position: { x: 0, y: 0 }, config: {} },
        { type: 'bad' }, // no id -> dropped by sanitizeGraph
      ],
      edges: [],
    };
    const file = new File([JSON.stringify(graph)], 'g.json', { type: 'application/json' });
    const input = container.querySelector('input[aria-label="Load graph file"]') as HTMLInputElement;
    await userEvent.upload(input, file);
    await waitFor(() => {
      expect(useStore.getState().nodes).toHaveLength(1);
    });
    expect(useStore.getState().toasts.some((t) => /1 invalid dropped/.test(t.message))).toBe(true);
  });
});
