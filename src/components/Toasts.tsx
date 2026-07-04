import { useEffect } from 'react';
import { useStore } from '../store/store';

function ToastItem({ id, type, message }: { id: string; type: string; message: string }) {
  const dismiss = useStore((s) => s.dismissToast);
  useEffect(() => {
    const timer = setTimeout(() => dismiss(id), 5000);
    return () => clearTimeout(timer);
  }, [id, dismiss]);
  return (
    <div
      className={`toast toast-${type}`}
      role={type === 'error' ? 'alert' : 'status'}
      onClick={() => dismiss(id)}
    >
      {message}
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    // A polite live region so screen readers announce new toasts as they appear.
    <div className="toast-stack" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} id={t.id} type={t.type} message={t.message} />
      ))}
    </div>
  );
}
