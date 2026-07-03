import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigFields } from './ConfigFields';
import { useStore } from '../store/store';
import { getNodeDefSafe } from '../engine/registry';
import { num } from '../nodes/helpers';

// Config comes from the store so the controlled inputs reflect edits.
function Harness({ id }: { id: string }) {
  const node = useStore((s) => s.nodes.find((n) => n.id === id))!;
  const def = getNodeDefSafe(node.type)!;
  return <ConfigFields nodeId={id} fields={def.configFields ?? []} config={node.config} />;
}

beforeEach(() => {
  localStorage.clear();
  useStore.getState().reset();
});

describe('ConfigFields number input', () => {
  it('accepts negative and decimal values (regression: "-" no longer becomes 0)', async () => {
    const id = useStore.getState().addNode('brightnessContrast');
    render(<Harness id={id} />);

    const input = screen.getByLabelText('Brightness');
    await userEvent.clear(input);
    await userEvent.type(input, '-42');
    expect(useStore.getState().nodes[0].config.brightness).toBe('-42');
    expect(num(useStore.getState().nodes[0].config.brightness, 0)).toBe(-42);
  });

  it('allows clearing a number field (coerces to the default at compute)', async () => {
    const id = useStore.getState().addNode('brightnessContrast');
    render(<Harness id={id} />);
    const input = screen.getByLabelText('Contrast');
    await userEvent.clear(input);
    expect(useStore.getState().nodes[0].config.contrast).toBe('');
    expect(num(useStore.getState().nodes[0].config.contrast, 7)).toBe(7); // falls back to default
  });
});
