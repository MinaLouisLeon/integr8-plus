import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * What jsdom lacks and the screens touch: `crypto.randomUUID` is present in
 * Node; `<dialog>`'s `showModal` is not, and the dialog component falls back to
 * rendering it open.
 */

afterEach(() => {
  cleanup();
});

// `findBy…` waits one second by default. Role queries over a whole screen are
// slow in jsdom, and with the integration suites or another package's tests
// running beside them a busy machine took longer than that, so tests failed by
// chance (the pay-runs list did, repeatedly). Five seconds still fails quickly
// when something is really missing.
configure({ asyncUtilTimeout: 5000 });
