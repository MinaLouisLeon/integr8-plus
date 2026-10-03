import { describe, it } from 'vitest';
import { defineMediaSuite } from '../testing/media-suite.js';

/**
 * The same pipeline over Cloudflare R2, when `apps/api/.env` holds an account
 * id and an account-level R2 token. It creates a bucket named
 * `integr8-test-<company id>` and deletes it at the end.
 */
const configured = ['CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].every(
  (name) => (process.env[name] ?? '') !== '',
);

if (configured) {
  defineMediaSuite('r2');
} else {
  describe('media on r2', () => {
    it.skip('needs CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY', () =>
      undefined);
  });
}
