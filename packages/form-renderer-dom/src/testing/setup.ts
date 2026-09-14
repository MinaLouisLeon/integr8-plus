import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * What jsdom lacks and the widgets touch.
 *
 * A canvas that draws nothing but produces a PNG, `scrollIntoView`, and a
 * geolocation a test can script. Each is the smallest stand-in that lets the
 * widget's own code run; none of them decides an outcome under test.
 */

afterEach(() => {
  cleanup();
});

const context = new Proxy(
  {},
  {
    get: (_target, property) =>
      property === 'measureText'
        ? () => ({ width: 10 })
        : typeof property === 'string'
          ? vi.fn()
          : undefined,
    set: () => true,
  },
);

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => context,
});

Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
  configurable: true,
  value(callback: (blob: Blob | null) => void, type = 'image/png') {
    callback(new Blob(['png-bytes'], { type }));
  },
});

Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
  configurable: true,
  value: () => undefined,
});

Object.defineProperty(Element.prototype, 'setPointerCapture', {
  configurable: true,
  value: () => undefined,
});
