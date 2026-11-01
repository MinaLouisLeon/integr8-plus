import { afterEach, describe, expect, it } from 'vitest';
import {
  currentUpdateNotice,
  reportClientTooOld,
  resetUpdateNotice,
  subscribeToUpdateNotice,
  updateLinkFor,
} from './client-update';

const PAGE = 'https://app.integr8-media.com/download';

describe('the Update button on a phone too old to be served', () => {
  afterEach(() => {
    resetUpdateNotice();
  });

  it("opens the company's page in a company's own app, and the plain page in the generic one", () => {
    expect(updateLinkFor(PAGE, 'acme')).toBe(`${PAGE}?company=acme`);
    expect(updateLinkFor(PAGE, undefined)).toBe(PAGE);
    // A server from before 1.2.4 sends no address: no button, only the sentence.
    expect(updateLinkFor(undefined, 'acme')).toBeUndefined();
  });

  it('is shown once the server refuses this build, and tells whoever is listening', () => {
    let told = 0;
    const stop = subscribeToUpdateNotice(() => {
      told += 1;
    });

    expect(currentUpdateNotice()).toBeUndefined();
    reportClientTooOld({ minimum: '2.0.0', message: 'Update', updateUrl: PAGE }, 'acme');
    expect(currentUpdateNotice()).toEqual({ link: `${PAGE}?company=acme` });
    expect(told).toBe(1);

    // Every later refusal says the same thing: nothing to re-render.
    reportClientTooOld({ minimum: '2.0.0', message: 'Update', updateUrl: PAGE }, 'acme');
    reportClientTooOld({ minimum: '2.0.0', message: 'Update' }, 'acme');
    expect(told).toBe(1);
    expect(currentUpdateNotice()).toEqual({ link: `${PAGE}?company=acme` });
    stop();
  });

  it('is shown without a button when the server gives no address', () => {
    reportClientTooOld({ minimum: '2.0.0', message: 'Update' }, undefined);
    expect(currentUpdateNotice()).toEqual({ link: undefined });
  });
});
