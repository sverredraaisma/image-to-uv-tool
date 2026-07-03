import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
});
