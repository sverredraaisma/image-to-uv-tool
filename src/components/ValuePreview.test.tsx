import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ValuePreview } from './ValuePreview';
import type { StlValue, TextValue } from '../types';

describe('ValuePreview', () => {
  it('shows a placeholder and is disabled with no value', () => {
    render(<ValuePreview value={undefined} />);
    expect(screen.getByText('–')).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('truncates long text to 24 chars', () => {
    const value: TextValue = { kind: 'text', text: 'x'.repeat(40) };
    render(<ValuePreview value={value} />);
    expect(screen.getByText('x'.repeat(24))).toBeInTheDocument();
  });

  it('labels an STL by triangle count', () => {
    const value: StlValue = { kind: 'stl', triangleCount: 12, triangles: new Float32Array(0) };
    render(<ValuePreview value={value} />);
    expect(screen.getByText('STL · 12△')).toBeInTheDocument();
  });

  it('fires onClick when it has a value', async () => {
    const onClick = vi.fn();
    render(<ValuePreview value={{ kind: 'text', text: 'hi' }} onClick={onClick} />);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
