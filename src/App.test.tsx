import { describe, it, expect, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { useStore } from './store/store';
import { setPlatform } from './lib/platform';

beforeEach(() => {
  localStorage.clear();
  useStore.getState().reset();
  useStore.setState({ apiKey: '', proxyUrl: '' });
  setPlatform({
    decodeImage: async () => ({ kind: 'image', width: 1, height: 1, data: new Uint8ClampedArray(4) }),
    encodePng: () => 'data:',
    encodePngBlob: async () => new Blob(),
    fetchImage: async () => ({ kind: 'image', width: 1, height: 1, data: new Uint8ClampedArray(4) }),
  });
});

describe('App smoke test', () => {
  it('mounts the whole app (toolbar + React Flow canvas)', () => {
    render(<App />);
    expect(screen.getByText('Node Image Tool')).toBeInTheDocument();
    expect(screen.getByText('+ Add node')).toBeInTheDocument();
  });

  it('renders a node on the canvas after adding one', async () => {
    render(<App />);
    await userEvent.click(screen.getByText('+ Add node'));
    await userEvent.click(screen.getByText('Input')); // drill into the category
    await userEvent.click(screen.getByText('Prompt Input'));
    // node title appears (there may be a menu label too, so scope to the canvas)
    const canvas = document.querySelector('.react-flow') as HTMLElement;
    expect(within(canvas).getByText('Prompt Input')).toBeInTheDocument();
  });

  it('renders an unknown node type as an error node instead of crashing', () => {
    useStore.getState().loadGraph({
      version: 1,
      nodes: [{ id: 'x', type: 'no-such-node', position: { x: 0, y: 0 }, config: {} }],
      edges: [],
    });
    render(<App />);
    expect(screen.getByText('Unknown node')).toBeInTheDocument();
  });

  it('Escape closes the preview modal', () => {
    render(<App />);
    act(() => useStore.getState().openPreview({ kind: 'text', text: 'hi' }, 'Preview'));
    expect(screen.getByText('Download')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('Download')).not.toBeInTheDocument();
  });

  it('shows an empty-state hint until the first node is added', async () => {
    render(<App />);
    expect(screen.getByText('Start building')).toBeInTheDocument();
    await userEvent.click(screen.getByText('+ Add node'));
    await userEvent.click(screen.getByText('Input')); // drill into the category
    await userEvent.click(screen.getByText('Prompt Input'));
    expect(screen.queryByText('Start building')).not.toBeInTheDocument();
  });

  it('every node carries a ? button that opens its help window', () => {
    useStore.getState().loadGraph({
      version: 1,
      nodes: [{ id: 'p', type: 'promptInput', position: { x: 0, y: 0 }, config: {} }],
      edges: [],
    });
    render(<App />);
    // fireEvent, not userEvent: a real mousedown inside the canvas starts React
    // Flow's d3 drag, which has nowhere to go in jsdom.
    fireEvent.click(screen.getByLabelText('What is Prompt Input for?'));
    expect(screen.getByText('Prompt Input · what is this?')).toBeInTheDocument();
    expect(screen.getByText("What it's for")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('Prompt Input · what is this?')).not.toBeInTheDocument();
  });
});
