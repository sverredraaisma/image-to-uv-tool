import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../nodes'; // register built-ins
import { Gloss3DEditor } from './Gloss3DEditor';
import { useStore } from '../store/store';

beforeEach(() => {
  localStorage.clear();
  useStore.getState().reset();
});

describe('Gloss3DEditor', () => {
  it('renders the drag-mode toggle and falls back gracefully without WebGL', () => {
    const id = useStore.getState().addNode('glossPreview');
    render(<Gloss3DEditor nodeId={id} />);
    // The controls render regardless of WebGL support…
    expect(screen.getByRole('button', { name: 'Rotate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move light' })).toBeInTheDocument();
    // …and jsdom has no WebGL, so the fallback note appears instead of a crash.
    expect(screen.getByText(/3D preview couldn’t start/i)).toBeInTheDocument();
  });

  it('renders nothing for an unknown node id', () => {
    const { container } = render(<Gloss3DEditor nodeId="nope" />);
    expect(container.firstChild).toBeNull();
  });
});
