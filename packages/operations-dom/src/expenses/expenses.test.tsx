import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseCategory, ExpenseClaimDetail } from '../api.js';
import { accessibilityViolations, apiError, fakeApi, renderScreen } from '../testing/render.js';
import { NewExpenseClaimScreen } from './claim-form.js';
import { ExpenseClaimsScreen, MyExpenseClaimsScreen } from './claim-list.js';
import { ExpenseClaimScreen } from './claim-screen.js';
import { ExpenseCategoriesScreen } from './expense-categories.js';

const USER = '00000000-0000-4000-8000-000000000401';
const TENANT = '00000000-0000-4000-8000-000000000301';
const CLAIMANT = '00000000-0000-4000-8000-000000000402';
const CLAIM = '00000000-0000-4000-8000-00000000ec01';
const FUEL = '00000000-0000-4000-8000-00000000ca01';
const MEALS = '00000000-0000-4000-8000-00000000ca02';
const JOB = '00000000-0000-4000-8000-00000000f001';
const MEDIA = '00000000-0000-4000-8000-00000000ed01';
const RECEIPT = '00000000-0000-4000-8000-00000000ee01';
const TRAVEL_ACCOUNT = '00000000-0000-4000-8000-00000000a601';

const ENGINEER = ['expense.submit'];
const APPROVER = ['expense.submit', 'expense.approve', 'ledger.read'];

const me =
  (
    permissions: string[],
    features: Record<string, boolean> = { hr: true, payroll: true, ledger: true },
  ) =>
  () => ({
    body: {
      userId: USER,
      tenantId: TENANT,
      email: 'h@x.example',
      displayName: 'Hala',
      role: 'hr_manager',
      grants: [],
      permissions,
      features,
      company: { name: 'Riverside Services', slug: 'riverside' },
    },
  });

const category = (overrides: Partial<ExpenseCategory> = {}): ExpenseCategory => ({
  id: FUEL,
  name: 'Fuel',
  accountId: null,
  archived: false,
  version: 1,
  ...overrides,
});

const claim = (overrides: Partial<ExpenseClaimDetail> = {}): ExpenseClaimDetail => ({
  id: CLAIM,
  reference: 'EX-000042',
  claimant: { id: CLAIMANT, name: 'Karim Adel' },
  category: { id: FUEL, name: 'Fuel' },
  workOrder: null,
  spentOn: '2026-10-10',
  amount: '350.75',
  currency: 'EGP',
  description: 'Diesel for the van, Cairo to Giza',
  status: 'submitted',
  submittedAt: '2026-10-10T09:00:00.000Z',
  decidedBy: null,
  decidedAt: null,
  rejectReason: null,
  settleVia: null,
  paidVia: null,
  paidBy: null,
  paidAt: null,
  paymentReference: null,
  version: 1,
  receipts: [],
  can: { attach: true, withdraw: false, decide: true, pay: false },
  ...overrides,
});

const page = (items: ExpenseClaimDetail[], waiting: number | null = null) => ({
  body: {
    items: items.map(({ receipts: _receipts, can: _can, ...row }) => row),
    nextCursor: null,
    waiting,
  },
});

/** The browser's upload, answered at once: the bytes "arrive" wherever they are sent. */
class InstantUpload {
  static sent: string[] = [];
  upload: { onprogress: unknown } = { onprogress: null };
  status = 200;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  #url = '';
  open(_method: string, url: string) {
    this.#url = url;
  }
  readonly headers: [string, string][] = [];
  setRequestHeader(name: string, value: string) {
    this.headers.push([name, value]);
  }
  abort() {
    this.onload = null;
  }
  send() {
    InstantUpload.sent.push(this.#url);
    setTimeout(() => this.onload?.(), 0);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  InstantUpload.sent = [];
});

describe('my expense claims', { timeout: 20_000 }, () => {
  it('lists one’s own claims with their amounts, and offers to claim another', async () => {
    const { client, calls } = fakeApi({
      'GET /v1/me': me(ENGINEER),
      'GET /v1/expenses': () => page([claim()]),
    });
    const rendered = renderScreen(<MyExpenseClaimsScreen />, client);

    expect(await screen.findByRole('link', { name: 'EX-000042' })).toHaveAttribute(
      'href',
      `/hr/expenses/${CLAIM}`,
    );
    const list = screen.getByRole('list');
    expect(within(list).getByText('Waiting')).toBeInTheDocument();
    expect(within(list).getByText(/350\.75/u)).toBeInTheDocument();
    expect(screen.getByText('Diesel for the van, Cairo to Giza')).toBeInTheDocument();
    // Nobody else's name on one's own list.
    expect(screen.queryByText('Karim Adel')).not.toBeInTheDocument();
    expect(Object.fromEntries(calls.find((call) => call.path === '/v1/expenses')!.query)).toEqual({
      scope: 'mine',
      limit: '50',
    });

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Claim an expense' }));
    expect(rendered.navigate).toHaveBeenCalledWith('/hr/expenses/new');
    expect(await accessibilityViolations(rendered.container)).toEqual([]);
  });

  it('filters by status and claim number', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(ENGINEER),
      'GET /v1/expenses': () => page([]),
    });
    renderScreen(<MyExpenseClaimsScreen />, client);
    expect(await screen.findByText('You have not claimed any expenses yet.')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Status'), 'rejected');
    await user.type(screen.getByLabelText('Claim number'), 'EX-000042');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      const last = calls.filter((call) => call.path === '/v1/expenses').at(-1)!;
      expect(Object.fromEntries(last.query)).toEqual({
        scope: 'mine',
        status: 'rejected',
        q: 'EX-000042',
        limit: '50',
      });
    });
    expect(await screen.findByText('No claims match these filters.')).toBeInTheDocument();
  });

  it('says the module is off rather than failing', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(ENGINEER, { hr: false }),
      'GET /v1/expenses': () => apiError(403, 'feature_disabled', 'Not on'),
    });
    renderScreen(<MyExpenseClaimsScreen />, client);
    expect(await screen.findByRole('alert')).toHaveTextContent(/not switched on/u);
  });
});

describe('everybody’s claims', { timeout: 20_000 }, () => {
  it('opens on those waiting, says how many, and names who claimed', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(APPROVER),
      'GET /v1/expenses': (call) =>
        call.query.get('status') === 'submitted'
          ? page([claim()], 3)
          : page([claim(), claim({ id: RECEIPT, reference: 'EX-000041', status: 'paid' })], 3),
    });
    const { container } = renderScreen(<ExpenseClaimsScreen />, client);

    expect(await screen.findByText('3 claims are waiting for a decision.')).toBeInTheDocument();
    expect(screen.getByText('Karim Adel')).toBeInTheDocument();
    expect(Object.fromEntries(calls.find((call) => call.path === '/v1/expenses')!.query)).toEqual({
      scope: 'all',
      status: 'submitted',
      limit: '50',
    });
    expect(screen.getByRole('button', { name: 'Categories' })).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.selectOptions(screen.getByLabelText('Status'), '');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('link', { name: 'EX-000041' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show them' }));
    await waitFor(() =>
      expect(
        calls
          .filter((call) => call.path === '/v1/expenses')
          .at(-1)!
          .query.get('status'),
      ).toBe('submitted'),
    );
  });

  it('tells somebody who does not approve claims, without asking the server', async () => {
    const { client, calls } = fakeApi({
      'GET /v1/me': me(ENGINEER),
      'GET /v1/expenses': () => page([]),
    });
    renderScreen(<ExpenseClaimsScreen />, client);
    expect(
      await screen.findByText('Only the owner, admins and HR managers see everybody’s claims.'),
    ).toBeInTheDocument();
    expect(calls.some((call) => call.path === '/v1/expenses')).toBe(false);
  });
});

describe('claiming an expense', { timeout: 30_000 }, () => {
  const routes = (extra: Parameters<typeof fakeApi>[0] = {}) => ({
    'GET /v1/me': me(ENGINEER),
    'GET /v1/settings': () => ({ body: { currency: 'EGP' } }),
    'GET /v1/expenses/categories': () => ({
      body: { items: [category(), category({ id: MEALS, name: 'Meals' })] },
    }),
    'GET /v1/work-orders': () => ({
      body: {
        items: [{ id: JOB, referenceLabel: 'WO-000017', title: 'Boiler service' }],
        nextCursor: null,
      },
    }),
    ...extra,
  });

  it('says what is missing before sending anything, and refuses a date ahead', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi(routes());
    const { container } = renderScreen(<NewExpenseClaimScreen />, client);

    await user.click(await screen.findByRole('button', { name: 'Submit claim' }));
    expect(screen.getByText('Choose what the expense was for.')).toBeInTheDocument();
    expect(screen.getByText('Enter an amount above zero, such as 250.50.')).toBeInTheDocument();
    expect(screen.getByText('Say what the expense was for.')).toBeInTheDocument();

    const date = screen.getByLabelText('Date spent');
    await user.clear(date);
    await user.type(date, '2999-01-01');
    await user.type(screen.getByLabelText('Amount (EGP)'), '0');
    expect(
      screen.getByText('An expense is claimed once it is spent: choose today or an earlier date.'),
    ).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('submits the claim once, then sends each receipt to it and opens it', async () => {
    vi.stubGlobal('XMLHttpRequest', InstantUpload);
    const user = userEvent.setup();
    let media = 0;
    const { client, calls } = fakeApi(
      routes({
        'POST /v1/expenses': () => ({ status: 201, body: claim({ status: 'submitted' }) }),
        'POST /v1/media': () => {
          media += 1;
          return {
            status: 201,
            body: {
              media: {
                id: `${MEDIA.slice(0, -1)}${String(media)}`,
                contentType: 'image/jpeg',
                byteSize: 4,
                status: 'pending',
                createdAt: '2026-10-12T00:00:00.000Z',
              },
              upload: {
                url: `https://uploads.test/${String(media)}`,
                method: 'PUT',
                headers: {},
                expiresAt: '2026-10-12T01:00:00.000Z',
              },
            },
          };
        },
        'POST /v1/media/:id/complete': (_call, params) => ({
          body: {
            id: params.id,
            contentType: 'image/jpeg',
            byteSize: 4,
            status: 'stored',
            thumbnail: 'none',
            createdAt: '2026-10-12T00:00:00.000Z',
            deletedAt: null,
            purgeAfter: null,
          },
        }),
        'POST /v1/attachments': () => ({ status: 201, body: {} }),
      }),
    );
    const { navigate } = renderScreen(<NewExpenseClaimScreen />, client);

    await user.selectOptions(await screen.findByLabelText('Category'), 'Meals');
    const date = screen.getByLabelText('Date spent');
    await user.clear(date);
    await user.type(date, '2026-10-01');
    await user.type(screen.getByLabelText('Amount (EGP)'), '120.5');
    await user.selectOptions(screen.getByLabelText('Job'), JOB);
    await user.type(screen.getByLabelText('What it was for'), 'Lunch for the crew');
    await user.upload(screen.getByLabelText('Receipt files'), [
      new File(['jpeg'], 'lunch.jpg', { type: 'image/jpeg' }),
      new File(['%PDF'], 'invoice.pdf', { type: 'application/pdf' }),
    ]);
    expect(screen.getByText('lunch.jpg')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Submit claim' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/hr/expenses/${CLAIM}`));
    const submitted = calls.filter(
      (call) => call.method === 'POST' && call.path === '/v1/expenses',
    );
    expect(submitted.map((call) => call.body)).toEqual([
      {
        categoryId: MEALS,
        spentOn: '2026-10-01',
        amount: '120.5',
        description: 'Lunch for the crew',
        workOrderId: JOB,
      },
    ]);
    expect(InstantUpload.sent).toEqual(['https://uploads.test/1', 'https://uploads.test/2']);
    expect(
      calls.filter((call) => call.path === '/v1/attachments').map((call) => call.body),
    ).toEqual([
      {
        owner: { expenseClaimId: CLAIM },
        fileId: `${MEDIA.slice(0, -1)}1`,
        title: 'lunch.jpg',
        kind: 'photo',
      },
      {
        owner: { expenseClaimId: CLAIM },
        fileId: `${MEDIA.slice(0, -1)}2`,
        title: 'invoice.pdf',
        kind: 'other',
      },
    ]);
  });

  it('keeps the claim when a receipt does not arrive, and offers to send it again', async () => {
    vi.stubGlobal('XMLHttpRequest', InstantUpload);
    const user = userEvent.setup();
    const { client, calls } = fakeApi(
      routes({
        'POST /v1/expenses': () => ({ status: 201, body: claim() }),
        'POST /v1/media': () => apiError(409, 'storage_quota_exceeded', 'Full'),
      }),
    );
    renderScreen(<NewExpenseClaimScreen />, client);
    await user.selectOptions(await screen.findByLabelText('Category'), 'Fuel');
    await user.type(screen.getByLabelText('Amount (EGP)'), '350.75');
    await user.type(screen.getByLabelText('What it was for'), 'Diesel');
    await user.upload(
      screen.getByLabelText('Receipt files'),
      new File(['jpeg'], 'pump.jpg', { type: 'image/jpeg' }),
    );
    await user.click(screen.getByRole('button', { name: 'Submit claim' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'EX-000042 is submitted, but 1 receipt did not arrive.',
    );
    expect(screen.getByRole('button', { name: 'Open EX-000042' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send them again' }));
    await waitFor(() => expect(calls.filter((call) => call.path === '/v1/media')).toHaveLength(2));
    // The claim itself went once.
    expect(
      calls.filter((call) => call.method === 'POST' && call.path === '/v1/expenses'),
    ).toHaveLength(1);
  });

  it('says why the server refused the date', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi(
      routes({
        'POST /v1/expenses': () =>
          apiError(422, 'spent_in_future', 'An expense is claimed once it is spent.', [
            { field: 'body.spentOn', code: 'spent_in_future', message: 'Today or earlier.' },
          ]),
      }),
    );
    renderScreen(<NewExpenseClaimScreen />, client);
    await user.selectOptions(await screen.findByLabelText('Category'), 'Fuel');
    await user.type(screen.getByLabelText('Amount (EGP)'), '10');
    await user.type(screen.getByLabelText('What it was for'), 'Parking');
    await user.click(screen.getByRole('button', { name: 'Submit claim' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An expense is claimed once it is spent: choose today or an earlier date.',
    );
  });

  it('says there is nothing to claim for when no categories are set up', async () => {
    const { client } = fakeApi(
      routes({ 'GET /v1/expenses/categories': () => ({ body: { items: [] } }) }),
    );
    renderScreen(<NewExpenseClaimScreen />, client);
    expect(
      await screen.findByText(
        'There is nothing to claim for yet: no expense categories are set up.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit claim' })).not.toBeInTheDocument();
  });
});

describe('one claim', { timeout: 30_000 }, () => {
  it('approves to be paid through payroll when payroll is on', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(APPROVER),
      'GET /v1/expenses/:id': () => ({ body: claim() }),
      'POST /v1/expenses/:id/approve': () => ({
        body: claim({
          status: 'approved',
          settleVia: 'payroll',
          decidedBy: { id: USER, name: 'Hala' },
          decidedAt: '2026-10-11T10:00:00.000Z',
          version: 2,
          can: { attach: true, withdraw: false, decide: false, pay: false },
        }),
      }),
    });
    const { container } = renderScreen(<ExpenseClaimScreen claimId={CLAIM} />, client);

    expect(await screen.findByRole('heading', { name: /EX-000042/u })).toBeInTheDocument();
    expect(screen.getByText('Waiting for a decision')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve EX-000042' });
    await user.click(within(dialog).getByLabelText(/Paid back with the next pay run/u));
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(calls.find((call) => call.path.endsWith('/approve'))?.body).toEqual({
        expectedVersion: 1,
        settleVia: 'payroll',
      }),
    );
    expect(await screen.findByText('Approved by Hala')).toBeInTheDocument();
    expect(screen.getByText('Waiting for the next pay run')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record paying back' })).not.toBeInTheDocument();
  });

  it('offers only paying back directly when payroll is off', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(APPROVER, { hr: true }),
      'GET /v1/expenses/:id': () => ({ body: claim() }),
      'POST /v1/expenses/:id/approve': () => ({ body: claim({ status: 'approved', version: 2 }) }),
    });
    renderScreen(<ExpenseClaimScreen claimId={CLAIM} />, client);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve EX-000042' });
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    expect(
      within(dialog).getByText('It will be paid back directly, and recorded here when it is.'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(calls.find((call) => call.path.endsWith('/approve'))?.body).toEqual({
        expectedVersion: 1,
        settleVia: 'direct',
      }),
    );
  });

  it('rejects only with a reason, which the claimant then sees', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(APPROVER),
      'GET /v1/expenses/:id': () => ({ body: claim() }),
      'POST /v1/expenses/:id/reject': () => ({
        body: claim({
          status: 'rejected',
          rejectReason: 'No receipt',
          decidedBy: { id: USER, name: 'Hala' },
          decidedAt: '2026-10-11T10:00:00.000Z',
          version: 2,
          can: { attach: true, withdraw: false, decide: false, pay: false },
        }),
      }),
    });
    renderScreen(<ExpenseClaimScreen claimId={CLAIM} />, client);
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog', { name: 'Reject EX-000042' });
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    expect(within(dialog).getByText('Say why the claim is rejected.')).toBeInTheDocument();
    expect(calls.some((call) => call.path.endsWith('/reject'))).toBe(false);

    await user.type(within(dialog).getByLabelText('Reason'), 'No receipt');
    await user.click(within(dialog).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(calls.find((call) => call.path.endsWith('/reject'))?.body).toEqual({
        expectedVersion: 1,
        reason: 'No receipt',
      }),
    );
    expect(await screen.findByText('Rejected by Hala')).toBeInTheDocument();
    expect(screen.getByText('Reason: No receipt')).toBeInTheDocument();
  });

  it('records paying back by cash with a reference', async () => {
    const user = userEvent.setup();
    const approved = claim({
      status: 'approved',
      settleVia: 'direct',
      decidedBy: { id: USER, name: 'Hala' },
      decidedAt: '2026-10-11T10:00:00.000Z',
      version: 2,
      can: { attach: true, withdraw: false, decide: false, pay: true },
    });
    const { client, calls } = fakeApi({
      'GET /v1/me': me(APPROVER),
      'GET /v1/expenses/:id': () => ({ body: approved }),
      'POST /v1/expenses/:id/pay': () => ({
        body: {
          ...approved,
          status: 'paid',
          paidVia: 'cash',
          paidBy: { id: USER, name: 'Hala' },
          paidAt: '2026-10-12T10:00:00.000Z',
          paymentReference: 'Petty cash 17',
          version: 3,
          can: { attach: true, withdraw: false, decide: false, pay: false },
        },
      }),
    });
    renderScreen(<ExpenseClaimScreen claimId={CLAIM} />, client);
    expect(await screen.findByText('Waiting to be paid back')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Record paying back' }));
    const dialog = screen.getByRole('dialog', { name: 'Pay back EX-000042' });
    await user.click(within(dialog).getByLabelText('cash'));
    await user.type(within(dialog).getByLabelText('Reference'), 'Petty cash 17');
    await user.click(within(dialog).getByRole('button', { name: 'Record payment' }));
    await waitFor(() =>
      expect(calls.find((call) => call.path.endsWith('/pay'))?.body).toEqual({
        expectedVersion: 2,
        via: 'cash',
        reference: 'Petty cash 17',
      }),
    );
    expect(await screen.findByText('Paid back by Hala, by cash')).toBeInTheDocument();
    expect(screen.getByText('Reference: Petty cash 17')).toBeInTheDocument();
  });

  it('lets the claimant withdraw their own, and says so when somebody decided first', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(ENGINEER),
      'GET /v1/expenses/:id': () => ({
        body: claim({
          claimant: { id: USER, name: 'Hala' },
          can: { attach: true, withdraw: true, decide: false, pay: false },
        }),
      }),
      'POST /v1/expenses/:id/withdraw': () =>
        apiError(409, 'not_waiting', 'This claim has already been decided or withdrawn.'),
    });
    renderScreen(<ExpenseClaimScreen claimId={CLAIM} />, client);
    expect(
      await screen.findByText('Waiting for the owner, an admin or an HR manager to decide.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Withdraw' }));
    const dialog = screen.getByRole('dialog', { name: 'Withdraw EX-000042' });
    await user.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This claim has already been decided or withdrawn. Reload it to see where it is.',
    );
    expect(calls.find((call) => call.path.endsWith('/withdraw'))?.body).toEqual({
      expectedVersion: 1,
    });
    expect(within(dialog).getByRole('button', { name: 'Reload the claim' })).toBeInTheDocument();
  });

  it('says plainly why one’s own claim is not one to decide', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/me': me(APPROVER),
      'GET /v1/expenses/:id': () => ({ body: claim() }),
      'POST /v1/expenses/:id/approve': () =>
        apiError(409, 'self_approval', 'Somebody other than the claimant decides a claim.'),
    });
    renderScreen(<ExpenseClaimScreen claimId={CLAIM} />, client);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve EX-000042' });
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Somebody other than the person who claimed decides a claim.',
    );
  });

  it('shows the receipts, and adds and removes them while that is allowed', async () => {
    vi.stubGlobal('XMLHttpRequest', InstantUpload);
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(APPROVER),
      'GET /v1/expenses/:id': () => ({
        body: claim({
          receipts: [
            {
              id: RECEIPT,
              fileId: MEDIA,
              title: 'pump.jpg',
              kind: 'photo',
              stage: null,
              contentType: 'image/jpeg',
              byteSize: 4,
              addedBy: { id: CLAIMANT, name: 'Karim Adel' },
              createdAt: '2026-10-10T09:01:00.000Z',
            },
          ],
        }),
      }),
      'DELETE /v1/attachments/:id': () => ({ status: 204 }),
      'POST /v1/media': () => ({
        status: 201,
        body: {
          media: {
            id: MEDIA,
            contentType: 'image/png',
            byteSize: 3,
            status: 'pending',
            createdAt: '2026-10-12T00:00:00.000Z',
          },
          upload: {
            url: 'https://uploads.test/x',
            method: 'PUT',
            headers: {},
            expiresAt: '2026-10-12T01:00:00.000Z',
          },
        },
      }),
      'POST /v1/media/:id/complete': (_call, params) => ({
        body: {
          id: params.id,
          contentType: 'image/png',
          byteSize: 3,
          status: 'stored',
          thumbnail: 'none',
          createdAt: '2026-10-12T00:00:00.000Z',
          deletedAt: null,
          purgeAfter: null,
        },
      }),
      'POST /v1/attachments': () => ({ status: 201, body: {} }),
    });
    renderScreen(<ExpenseClaimScreen claimId={CLAIM} />, client);
    expect(await screen.findByRole('button', { name: 'pump.jpg' })).toBeInTheDocument();
    expect(screen.getByText('added by Karim Adel')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove the receipt pump.jpg' }));
    await waitFor(() =>
      expect(calls.some((call) => call.method === 'DELETE' && call.path.endsWith(RECEIPT))).toBe(
        true,
      ),
    );

    await user.upload(
      screen.getByLabelText('Receipt files'),
      new File(['png'], 'toll.png', { type: 'image/png' }),
    );
    await user.click(screen.getByRole('button', { name: 'Add receipts' }));
    await waitFor(() =>
      expect(calls.find((call) => call.path === '/v1/attachments')?.body).toEqual({
        owner: { expenseClaimId: CLAIM },
        fileId: MEDIA,
        title: 'toll.png',
        kind: 'photo',
      }),
    );
  });
});

describe('expense categories', { timeout: 20_000 }, () => {
  const ledgerAccounts = () => ({
    body: {
      items: [
        {
          id: TRAVEL_ACCOUNT,
          code: '6200',
          name: 'Travel',
          type: 'expense',
          archived: false,
          role: null,
          version: 1,
        },
        {
          id: '00000000-0000-4000-8000-00000000a101',
          code: '1100',
          name: 'Cash on hand',
          type: 'asset',
          archived: false,
          role: 'cash',
          version: 1,
        },
      ],
    },
  });

  it('adds a category pointed at an expense account, and archives one', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(APPROVER),
      'GET /v1/expenses/categories': () => ({
        body: { items: [category(), category({ id: MEALS, name: 'Meals', archived: true })] },
      }),
      'GET /v1/ledger/accounts': ledgerAccounts,
      'POST /v1/expenses/categories': () => ({
        status: 201,
        body: category({ id: MEALS, name: 'Travel' }),
      }),
      'PATCH /v1/expenses/categories/:id': () => ({ body: category({ archived: true }) }),
    });
    const { container } = renderScreen(<ExpenseCategoriesScreen />, client);

    expect(await screen.findByText('Fuel')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Archived' })).toBeInTheDocument();
    expect(await screen.findAllByText('Posts to Staff expenses account')).toHaveLength(2);
    // Only expense accounts are offered.
    const account = screen.getByLabelText('Ledger account');
    expect(within(account).queryByText(/Cash on hand/u)).not.toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.type(screen.getByLabelText('Name'), 'Travel');
    await user.selectOptions(account, TRAVEL_ACCOUNT);
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
        name: 'Travel',
        accountId: TRAVEL_ACCOUNT,
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Archive Fuel' }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
        expectedVersion: 1,
        archived: true,
      }),
    );
  });

  it('says when the name is taken, and leaves the ledger out when it is off', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(['expense.submit', 'expense.approve'], { hr: true }),
      'GET /v1/expenses/categories': () => ({ body: { items: [category()] } }),
      'POST /v1/expenses/categories': () =>
        apiError(409, 'name_taken', 'Another category has this name.'),
    });
    renderScreen(<ExpenseCategoriesScreen />, client);
    expect(await screen.findByText('Fuel')).toBeInTheDocument();
    expect(screen.queryByLabelText('Ledger account')).not.toBeInTheDocument();
    expect(screen.queryByText(/Posts to/u)).not.toBeInTheDocument();
    expect(calls.some((call) => call.path === '/v1/ledger/accounts')).toBe(false);

    await user.type(screen.getByLabelText('Name'), 'Fuel');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Another category already has this name.',
    );
  });

  it('renames a category and points it back at the default account', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(APPROVER),
      'GET /v1/expenses/categories': () => ({
        body: { items: [category({ accountId: TRAVEL_ACCOUNT, version: 4 })] },
      }),
      'GET /v1/ledger/accounts': ledgerAccounts,
      'PATCH /v1/expenses/categories/:id': () => ({ body: category({ name: 'Fuel and tolls' }) }),
    });
    renderScreen(<ExpenseCategoriesScreen />, client);
    expect(await screen.findByText('Posts to 6200 · Travel')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit Fuel' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit Fuel' });
    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Fuel and tolls');
    await user.selectOptions(within(dialog).getByLabelText('Ledger account'), '');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
        expectedVersion: 4,
        name: 'Fuel and tolls',
        accountId: null,
      }),
    );
  });

  it('is not offered to somebody who does not approve claims', async () => {
    const { client } = fakeApi({ 'GET /v1/me': me(ENGINEER) });
    renderScreen(<ExpenseCategoriesScreen />, client);
    expect(
      await screen.findByText(
        'Only the owner, admins and HR managers keep the expense categories.',
      ),
    ).toBeInTheDocument();
  });
});
