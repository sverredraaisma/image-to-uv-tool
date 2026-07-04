import type { ReactNode } from 'react';

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
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal ${className} ${wide ? 'modal-wide' : ''}`.trim()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span>{title}</span>
          <div className="modal-header-actions">
            {headerActions}
            <button type="button" className="icon-btn" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        <div className={`modal-body ${bodyClassName}`.trim()}>{children}</div>
      </div>
    </div>
  );
}
