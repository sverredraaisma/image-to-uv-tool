import '@testing-library/jest-dom/vitest';

// Polyfills that @xyflow/react needs but jsdom lacks.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!('DOMMatrixReadOnly' in globalThis)) {
  globalThis.DOMMatrixReadOnly = class {
    m22 = 1;
    constructor() {}
  } as unknown as typeof DOMMatrixReadOnly;
}
