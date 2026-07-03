import { useEffect } from 'react';
import { useStore } from '../store/store';

function ToastItem({ id, type, message }: { id: string; type: string; message: string }) {
  const dismiss = useStore((s) => s.dismissToast);
  useEffect(() => {
    const timer = setTimeout(() => dismiss(id), 5000);
    return () => clearTimeout(timer);
  }, [id, dismiss]);
  return (
    <div className={`toast toast-${type}`} onClick={() => dismiss(id)}>
      {message}
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <ToastItem key={t.id} id={t.id} type={t.type} message={t.message} />
      ))}
    </div>
  );
}
