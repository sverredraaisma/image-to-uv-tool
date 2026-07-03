import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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
    await userEvent.click(screen.getByText('Prompt Input'));
    // node title appears (there may be a menu label too, so scope to the canvas)
    const canvas = document.querySelector('.react-flow') as HTMLElement;
    expect(within(canvas).getByText('Prompt Input')).toBeInTheDocument();
  });
});
