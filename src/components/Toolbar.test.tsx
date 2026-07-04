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

  it('opens the add-node menu with node categories', async () => {
    render(<Toolbar />);
    await userEvent.click(screen.getByText('+ Add node'));
    expect(screen.getByText('Input')).toBeInTheDocument();
    expect(screen.getByText('Image Input')).toBeInTheDocument();
    expect(screen.getByText('AI (Replicate)')).toBeInTheDocument();
  });

  it('adds a node to the store when picked from the menu', async () => {
    render(<Toolbar />);
    await userEvent.click(screen.getByText('+ Add node'));
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
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, file);
    await waitFor(() => {
      expect(useStore.getState().nodes).toHaveLength(1);
    });
    expect(useStore.getState().toasts.some((t) => /1 invalid dropped/.test(t.message))).toBe(true);
  });
});
