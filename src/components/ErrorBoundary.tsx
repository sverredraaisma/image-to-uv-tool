import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Catches render-time exceptions so a single component throw shows a recovery
 * panel instead of white-screening the whole app. Class component because
 * error boundaries have no hook equivalent.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface it for debugging; a real deployment could forward this on.
    console.error('Unhandled error in UI:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="error-boundary" role="alert">
        <div className="error-boundary-card">
          <h1>Something went wrong</h1>
          <p>The editor hit an unexpected error. Your saved graph is unaffected.</p>
          <pre className="error-boundary-detail">{error.message}</pre>
          <div className="error-boundary-actions">
            <button type="button" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
