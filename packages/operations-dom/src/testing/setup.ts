import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * What jsdom lacks and the screens touch: `crypto.randomUUID` is present in
 * Node; `<dialog>`'s `showModal` is not, and the dialog component falls back to
 * rendering it open.
 */

afterEach(() => {
  cleanup();
});
