import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from './ErrorBoundary';

function Boom({ crash }: { crash: boolean }): React.ReactElement {
  if (crash) throw new Error('kaboom in render');
  return <div>all good</div>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React logs caught render errors; keep the test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children normally when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Boom crash={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('all good')).toBeTruthy();
  });

  it('shows a recovery panel (with the message) instead of white-screening', () => {
    render(
      <ErrorBoundary>
        <Boom crash />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(/Something went wrong/)).toBeTruthy();
    expect(screen.getByText(/kaboom in render/)).toBeTruthy();
  });

  it('"Try again" re-renders the children once the cause is fixed', async () => {
    let shouldCrash = true;
    const Wrapper = () => (
      <ErrorBoundary>
        <Boom crash={shouldCrash} />
      </ErrorBoundary>
    );
    const { rerender } = render(<Wrapper />);
    expect(screen.getByRole('alert')).toBeTruthy();

    // Fix the underlying condition and re-render (boundary still shows the
    // fallback because its error state is set), then retry to clear it.
    shouldCrash = false;
    rerender(<Wrapper />);
    await userEvent.click(screen.getByText('Try again'));
    expect(screen.getByText('all good')).toBeTruthy();
  });
});
