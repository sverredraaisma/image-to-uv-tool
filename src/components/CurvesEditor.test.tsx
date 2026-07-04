import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CurvesEditor } from './CurvesEditor';
import { useStore } from '../store/store';
import type { CurvePoint } from '../lib/image';

beforeEach(() => {
  localStorage.clear();
  useStore.getState().reset();
});

describe('CurvesEditor', () => {
  it('renders the default identity endpoints as draggable points', () => {
    const id = useStore.getState().addNode('curves');
    render(<CurvesEditor nodeId={id} />);
    expect(screen.getByText('Reset')).toBeInTheDocument();
    expect(document.querySelectorAll('.curves-point').length).toBe(2);
  });

  it('reflects added points and Reset restores the two endpoints', async () => {
    const id = useStore.getState().addNode('curves');
    useStore.getState().updateNodeConfig(id, {
      points: [
        { x: 0, y: 0 },
        { x: 128, y: 200 },
        { x: 255, y: 255 },
      ],
    });
    render(<CurvesEditor nodeId={id} />);
    expect(document.querySelectorAll('.curves-point').length).toBe(3);

    await userEvent.click(screen.getByText('Reset'));
    const points = useStore.getState().nodes.find((n) => n.id === id)!.config.points as CurvePoint[];
    expect(points).toHaveLength(2);
    expect(points).toEqual([
      { x: 0, y: 0 },
      { x: 255, y: 255 },
    ]);
  });
});
