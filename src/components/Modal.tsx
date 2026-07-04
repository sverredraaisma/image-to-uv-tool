import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

/** Shared modal shell: backdrop-to-close, click-guarded panel, header with ✕. */
export function Modal({
  title,
  onClose,
  className = '',
  bodyClassName = '',
  wide = false,
  headerActions,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  className?: string;
  bodyClassName?: string;
  wide?: boolean;
  headerActions?: ReactNode;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  // Move focus into the dialog on open and restore it to the trigger on close.
  useEffect(() => {
    restoreFocus.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => restoreFocus.current?.focus?.();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !panelRef.current) return;
    // Trap Tab within the dialog.
    const focusables = panelRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className={`modal ${className} ${wide ? 'modal-wide' : ''}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span>{title}</span>
          <div className="modal-header-actions">
            {headerActions}
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        <div className={`modal-body ${bodyClassName}`.trim()}>{children}</div>
      </div>
    </div>
  );
}
