import { ApiRequestError } from '@integr8/api-client';
import { ar, en } from '@integr8/i18n';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CustomerScreen } from './screens/customer-screen.js';
import { apiError, fakeApi, renderScreen } from './testing/render.js';
import { Failure } from './ui.js';

/**
 * Refusals in the reader's language (ADR-0012): every screen's failure says
 * the catalogue's words for the code, in the screen's language, and never the
 * server's English.
 */

const ENGLISH_FROM_THE_SERVER = 'Written for a log, never shown';
const CUSTOMER = '00000000-0000-4000-8000-000000000301';

function refusal(
  status: number,
  code: string,
  details: { field: string; code: string; message: string }[] = [],
) {
  return new ApiRequestError(status, code, ENGLISH_FROM_THE_SERVER, 'req-42', details);
}

describe('a failure', () => {
  it('says a known code in Arabic on an Arabic screen', () => {
    const { client } = fakeApi({});
    renderScreen(<Failure error={refusal(409, 'version_conflict')} />, client, { locale: 'ar' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(ar.apiErrors.version_conflict);
    expect(alert).not.toHaveTextContent(ENGLISH_FROM_THE_SERVER);
  });

  it('says the details it knows under the message, in the screen’s language', () => {
    const { client } = fakeApi({});
    renderScreen(
      <Failure
        error={refusal(409, 'completion_blocked', [
          { field: 'signoff', code: 'signoff_missing', message: ENGLISH_FROM_THE_SERVER },
          { field: 'x', code: 'something_new', message: ENGLISH_FROM_THE_SERVER },
        ])}
      />,
      client,
      { locale: 'ar' },
    );
    expect(screen.getByRole('alert')).toHaveTextContent(ar.apiErrors.completion_blocked);
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      ar.apiErrors.signoff_missing,
    ]);
    expect(screen.getByRole('alert')).not.toHaveTextContent(ENGLISH_FROM_THE_SERVER);
  });

  it('gives a code this build does not know the words for its status, with the reference', () => {
    const { client } = fakeApi({});
    renderScreen(<Failure error={refusal(409, 'brand_new_refusal')} />, client);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('req-42');
    expect(alert).not.toHaveTextContent(ENGLISH_FROM_THE_SERVER);
  });

  it('keeps a screen’s own message for a code', () => {
    const { client } = fakeApi({});
    renderScreen(
      <Failure error={refusal(422, 'self_approval')} overrides={{ self_approval: 'Ours' }} />,
      client,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Ours');
  });

  it('reaches a real screen: a customer that is not there, in Arabic', async () => {
    const { client } = fakeApi({
      'GET /v1/customers/:id': () => apiError(404, 'not_found', ENGLISH_FROM_THE_SERVER),
    });
    renderScreen(<CustomerScreen customerId={CUSTOMER} />, client, { locale: 'ar' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ar.errors.notFound);
    expect(alert).not.toHaveTextContent(en.errors.notFound);
  });
});
