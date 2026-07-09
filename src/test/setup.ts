// Vitest global setup (renderer tests). Registers the `@testing-library/jest-dom`
// custom matchers (`toBeInTheDocument`, `toHaveAttribute`, …) on Vitest's `expect`,
// and cleans up the DOM after each test so components don't leak between cases.
//
// This runs for EVERY test file (referenced via `setupFiles` in vitest.config.ts).
// It is a no-op for node-environment DB/settings tests — the jsdom-only bits are
// guarded by presence of `document`, and importing the matchers is harmless there.

import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';

const installCanvasStub = () => {
  if (
    typeof HTMLCanvasElement === 'undefined' ||
    HTMLCanvasElement.prototype.getContext.name === 'getContextStub'
  ) {
    return;
  }

  const makeContext = (canvas: HTMLCanvasElement) => ({
    canvas,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    font: '10px sans-serif',
    clearRect: () => {},
    drawImage: () => {},
    fillRect: () => {},
    getImageData: () => ({
      data: new Uint8ClampedArray([0, 0, 0, 255]),
      width: 1,
      height: 1,
      colorSpace: 'srgb',
    }),
    measureText: () => ({ width: 0 }),
    putImageData: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
  });

  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: function getContextStub(this: HTMLCanvasElement) {
      return makeContext(this);
    },
  });
};

installCanvasStub();

afterEach(() => {
  // Only meaningful under jsdom; guarded so node-env tests don't touch a DOM.
  if (typeof document !== 'undefined') {
    cleanup();
  }
});
