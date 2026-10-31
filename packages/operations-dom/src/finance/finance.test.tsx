import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type {
  FinanceSettings,
  InvoiceDetail,
  InvoiceRow,
  JobCosts,
  PaymentDetail,
  PaymentRow,
} from '../api.js';
import { accessibilityViolations, apiError, fakeApi, renderScreen } from '../testing/render.js';
import { CustomerAccountSection } from './customer-account.js';
import { FinanceSettingsScreen } from './finance-settings.js';
import { InvoiceListScreen } from './invoice-list.js';
import { InvoiceScreen } from './invoice-screen.js';
import { JobFinancePanel } from './job-finance.js';
import { PaymentListScreen } from './payment-list.js';
import { PaymentScreen } from './payment-screen.js';

const USER = '00000000-0000-4000-8000-000000000401';
const TENANT = '00000000-0000-4000-8000-000000000301';
const CUSTOMER = '00000000-0000-4000-8000-00000000c001';
const INVOICE = '00000000-0000-4000-8000-00000000e001';
const LINE = '00000000-0000-4000-8000-00000000e101';
const RECEIPT = '00000000-0000-4000-8000-00000000e201';
const ALLOCATION = '00000000-0000-4000-8000-00000000e301';
const JOB = '00000000-0000-4000-8000-00000000a001';

const me =
  (permissions: string[], features: Record<string, boolean> = { finance: true }) =>
  () => ({
    body: {
      userId: USER,
      tenantId: TENANT,
      email: 'o@x.example',
      displayName: 'Omar',
      role: 'owner',
      permissions,
      features,
      company: { name: 'Riverside Services', slug: 'riverside' },
    },
  });
const READ = ['finance.read', 'customer.read'];
const MANAGE = [...READ, 'finance.manage'];
const ISSUE = [...MANAGE, 'finance.issue'];

const totals = { gross: '200', discount: '0', net: '200', tax: '28', total: '228' };

const row = (overrides: Partial<InvoiceRow> = {}): InvoiceRow => ({
  id: INVOICE,
  reference: 'INV-000012',
  customer: { id: CUSTOMER, name: 'Riverside Housing' },
  status: 'issued',
  overdue: false,
  currencyCode: 'EGP',
  issueDate: '2026-10-01',
  dueDate: '2026-10-31',
  amounts: { total: '228', allocated: '0', credited: '0', balance: '228' },
  source: null,
  partsNotYetBilled: false,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  ...overrides,
});

const invoice = (overrides: Partial<InvoiceDetail['invoice']> = {}): InvoiceDetail['invoice'] => ({
  ...row({
    reference: null,
    status: 'draft',
    issueDate: null,
    dueDate: null,
  }),
  site: null,
  contact: null,
  notes: 'Thank you for your business.',
  internalNotes: 'Chase after the 15th.',
  billedTo: null,
  issuer: null,
  totals,
  issuedBy: null,
  issuedAt: null,
  voidedBy: null,
  voidedAt: null,
  voidReason: null,
  version: 1,
  createdBy: { id: USER, name: 'Omar' },
  ...overrides,
});

const line = (): InvoiceDetail['lines'][number] => ({
  id: LINE,
  position: 1,
  itemId: null,
  description: 'Boiler service',
  quantity: '2',
  unit: 'each',
  unitPrice: '100',
  discountBp: 0,
  taxRateBp: 1400,
  gross: '200',
  discount: '0',
  net: '200',
  tax: '28',
  total: '228',
  salesOrderLineId: null,
  workOrderMaterialId: null,
});

const NO = {
  edit: false,
  discard: false,
  issue: false,
  void: false,
  credit: false,
  recordPayment: false,
};

const detail = (overrides: Partial<InvoiceDetail> = {}): InvoiceDetail => ({
  invoice: invoice(),
  lines: [line()],
  creditNotes: [],
  payments: [],
  can: { ...NO, edit: true, discard: true, issue: true },
  ...overrides,
});

const issued = (): InvoiceDetail =>
  detail({
    invoice: invoice({
      reference: 'INV-000012',
      status: 'issued',
      issueDate: '2026-10-05',
      dueDate: '2026-11-04',
      issuedBy: { id: USER, name: 'Omar' },
      issuedAt: '2026-10-05T09:00:00.000Z',
      billedTo: {
        customerName: 'Riverside Housing',
        customerAddress: {
          line1: '1 Nile Street',
          line2: null,
          city: 'Cairo',
          region: null,
          postcode: null,
          countryCode: 'EG',
        },
        contactName: null,
        contactEmail: null,
      },
      issuer: {
        name: 'Riverside Services LLC',
        address: '9 Tahrir Square, Cairo',
        taxReference: 'TX-445',
        paymentInstructions: 'Bank transfer to account 1234',
        footer: null,
      },
      version: 2,
    }),
    can: { ...NO, void: true, credit: true, recordPayment: true },
  });

const payment = (overrides: Partial<PaymentRow> = {}): PaymentRow => ({
  id: RECEIPT,
  reference: 'RC-000003',
  customer: { id: CUSTOMER, name: 'Riverside Housing' },
  receivedOn: '2026-10-06',
  amount: '300',
  currencyCode: 'EGP',
  method: 'bank_transfer',
  paymentReference: 'TRF-88',
  allocated: '0',
  unallocated: '300',
  recordedAt: '2026-10-06T10:00:00.000Z',
  ...overrides,
});

describe('invoices', { timeout: 20_000 }, () => {
  it('lists invoices with what they owe and flags those overdue', async () => {
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/finance/invoices': () => ({
        body: {
          items: [
            row({
              overdue: true,
              source: { kind: 'sales_order', id: JOB, reference: 'SO-000004' },
            }),
          ],
          nextCursor: null,
        },
      }),
    });
    const { container } = renderScreen(<InvoiceListScreen />, client);

    expect(await screen.findByRole('link', { name: 'INV-000012' })).toHaveAttribute(
      'href',
      `/finance/invoices/${INVOICE}`,
    );
    const item = screen.getByRole('listitem');
    expect(within(item).getByText('Issued')).toBeInTheDocument();
    expect(within(item).getByText('Overdue')).toBeInTheDocument();
    expect(within(item).getByText('EGP 228.00')).toBeInTheDocument();
    expect(within(item).getByText('EGP 228.00 owed')).toBeInTheDocument();
    expect(within(item).getByText(/SO-000004/u)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'New invoice' })).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Overdue only'));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(calls.some((call) => call.query.get('overdue') === 'true')).toBe(true),
    );
  });

  it('hides drafting from a seat that only reads', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(READ),
      'GET /v1/finance/invoices': () => ({ body: { items: [], nextCursor: null } }),
    });
    renderScreen(<InvoiceListScreen />, client);
    expect(await screen.findByText(/No invoices yet/u)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New invoice' })).not.toBeInTheDocument();
  });

  it('issues a draft, then records a payment against it', async () => {
    const user = userEvent.setup();
    let current = detail();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(ISSUE),
      'GET /v1/finance/invoices/:id': () => ({ body: current }),
      'POST /v1/finance/invoices/:id/issue': () => {
        current = issued();
        return { body: current };
      },
      'POST /v1/finance/payments': () => ({
        status: 201,
        body: {
          receipt: { ...payment(), notes: null, recordedBy: { id: USER, name: 'Omar' } },
          allocations: [],
          openInvoices: [],
          can: { allocate: false, removeAllocation: true },
        } satisfies PaymentDetail,
      }),
    });
    const { container, navigate } = renderScreen(<InvoiceScreen invoiceId={INVOICE} />, client);

    expect(await screen.findByRole('heading', { name: /Draft invoice/u })).toBeInTheDocument();
    expect(screen.getByText(/gets its number when it is issued/u)).toBeInTheDocument();
    expect(screen.getAllByText('Boiler service').length).toBeGreaterThan(0);
    expect(screen.getByText('Chase after the 15th.')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Issue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Issue this invoice' });
    await user.click(within(dialog).getByRole('button', { name: 'Issue' }));
    expect(await screen.findByRole('heading', { name: /INV-000012/u })).toBeInTheDocument();
    expect(calls.find((call) => call.path.endsWith('/issue'))!.body).toEqual({
      expectedVersion: 1,
    });
    expect(screen.queryByRole('button', { name: 'Edit lines' })).not.toBeInTheDocument();
    // The printable copy carries the issuer the company typed.
    expect(screen.getAllByText('Riverside Services LLC').length).toBeGreaterThan(0);
    expect(screen.getAllByText('TX-445').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Record payment' }));
    const pay = await screen.findByRole('dialog', { name: 'Record payment' });
    const amount = within(pay).getByLabelText('Amount');
    expect(amount).toHaveValue('228');
    await user.clear(amount);
    await user.type(amount, '300');
    expect(within(pay).getByText(/EGP 228.00 will be put against INV-000012/u)).toBeInTheDocument();
    await user.click(within(pay).getByRole('button', { name: 'Record' }));
    // From an invoice, the payment is recorded and the invoice refreshed in place.
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Record payment' })).not.toBeInTheDocument(),
    );
    expect(navigate).not.toHaveBeenCalled();
    const post = calls.find(
      (call) => call.method === 'POST' && call.path === '/v1/finance/payments',
    )!;
    expect(post.body).toMatchObject({
      customerId: CUSTOMER,
      amount: '300',
      currencyCode: 'EGP',
      method: 'bank_transfer',
      allocations: [{ invoiceId: INVOICE, amount: '228' }],
    });
  });

  it('drafts a credit note for everything still owed', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(ISSUE),
      'GET /v1/finance/invoices/:id': () => ({ body: issued() }),
      'POST /v1/finance/invoices/:id/credit-notes': () => ({ status: 201, body: {} }),
    });
    renderScreen(<InvoiceScreen invoiceId={INVOICE} />, client);
    await user.click(await screen.findByRole('button', { name: 'Credit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Credit' });
    await user.type(within(dialog).getByLabelText('Reason'), 'Service not completed');
    await user.click(within(dialog).getByLabelText('Credit everything still owed'));
    await user.click(within(dialog).getByRole('button', { name: 'Create draft' }));
    await waitFor(() =>
      expect(calls.find((call) => call.path.endsWith('/credit-notes'))?.body).toEqual({
        reason: 'Service not completed',
        whole: true,
      }),
    );
  });

  it('says why a void was refused', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/me': me(ISSUE),
      'GET /v1/finance/invoices/:id': () => ({ body: issued() }),
      'POST /v1/finance/invoices/:id/void': () =>
        apiError(409, 'invoice_settled', 'Something was paid or credited against this invoice.'),
    });
    renderScreen(<InvoiceScreen invoiceId={INVOICE} />, client);
    await user.click(await screen.findByRole('button', { name: 'Void' }));
    const dialog = await screen.findByRole('dialog', { name: 'Void this invoice' });
    await user.type(within(dialog).getByLabelText('Why it is voided'), 'Raised in error');
    await user.click(within(dialog).getByRole('button', { name: 'Void' }));
    expect(
      await within(dialog).findByText(
        'A payment or a credit note is against this invoice. Credit it instead.',
      ),
    ).toBeInTheDocument();
  });
});

describe('payments', { timeout: 20_000 }, () => {
  const paymentDetail = (overrides: Partial<PaymentDetail> = {}): PaymentDetail => ({
    receipt: { ...payment(), notes: null, recordedBy: { id: USER, name: 'Omar' } },
    allocations: [],
    openInvoices: [row()],
    can: { allocate: true, removeAllocation: true },
    ...overrides,
  });

  it('lists payments with what is left on account', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(ISSUE),
      'GET /v1/finance/payments': () => ({ body: { items: [payment()], nextCursor: null } }),
    });
    const { container } = renderScreen(<PaymentListScreen />, client);
    expect(await screen.findByRole('link', { name: 'RC-000003' })).toHaveAttribute(
      'href',
      `/finance/payments/${RECEIPT}`,
    );
    expect(screen.getByText('EGP 300.00 on account')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Record payment' })).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('puts a payment against an invoice, up to what either has, and takes it back', async () => {
    const user = userEvent.setup();
    let current = paymentDetail();
    const allocation: PaymentDetail['allocations'][number] = {
      id: ALLOCATION,
      invoice: { id: INVOICE, reference: 'INV-000012' },
      receipt: {
        id: RECEIPT,
        reference: 'RC-000003',
        receivedOn: '2026-10-06',
        method: 'bank_transfer',
      },
      amount: '228',
      allocatedBy: { id: USER, name: 'Omar' },
      allocatedAt: '2026-10-06T11:00:00.000Z',
      removedBy: null,
      removedAt: null,
    };
    const { client, calls } = fakeApi({
      'GET /v1/me': me(ISSUE),
      'GET /v1/finance/payments/:id': () => ({ body: current }),
      'POST /v1/finance/payments/:id/allocations': () => {
        current = paymentDetail({
          receipt: {
            ...paymentDetail().receipt,
            allocated: '228',
            unallocated: '72',
          },
          allocations: [allocation],
          openInvoices: [],
        });
        return { body: current };
      },
      'POST /v1/finance/payments/:id/allocations/:allocationId/remove': () => {
        current = paymentDetail({
          allocations: [
            {
              ...allocation,
              removedBy: { id: USER, name: 'Omar' },
              removedAt: '2026-10-07T09:00:00.000Z',
            },
          ],
        });
        return { body: current };
      },
    });
    const { container } = renderScreen(<PaymentScreen paymentId={RECEIPT} />, client);

    expect(await screen.findByRole('heading', { name: 'RC-000003' })).toBeInTheDocument();
    expect(screen.getByText('Not yet put against any invoice.')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.selectOptions(screen.getByLabelText('Invoice'), INVOICE);
    expect(screen.getByLabelText('Amount')).toHaveValue('228');
    await user.click(screen.getByRole('button', { name: 'Put against invoice' }));
    expect(await screen.findByRole('link', { name: 'INV-000012' })).toBeInTheDocument();
    expect(calls.find((call) => call.path.endsWith('/allocations'))!.body).toEqual({
      invoiceId: INVOICE,
      amount: '228',
    });

    window.confirm = () => true;
    await user.click(screen.getByRole('button', { name: 'Take back' }));
    expect(await screen.findByText(/Taken back by Omar/u)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take back' })).not.toBeInTheDocument();
  });

  it('shows over-allocation refused by the server', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/me': me(ISSUE),
      'GET /v1/finance/payments/:id': () => ({ body: paymentDetail() }),
      'POST /v1/finance/payments/:id/allocations': () =>
        apiError(422, 'over_invoice', 'More than the invoice owes.'),
    });
    renderScreen(<PaymentScreen paymentId={RECEIPT} />, client);
    await user.selectOptions(await screen.findByLabelText('Invoice'), INVOICE);
    await user.clear(screen.getByLabelText('Amount'));
    await user.type(screen.getByLabelText('Amount'), '250');
    await user.click(screen.getByRole('button', { name: 'Put against invoice' }));
    expect(
      await screen.findByText('That is more than the invoice still owes.'),
    ).toBeInTheDocument();
  });
});

describe('finance settings, the customer account and the job', { timeout: 20_000 }, () => {
  const settings = (overrides: Partial<FinanceSettings> = {}): FinanceSettings => ({
    legalName: null,
    address: null,
    taxReference: null,
    paymentInstructions: null,
    footer: null,
    defaultDueDays: 30,
    labourHourlyCost: null,
    labourHourlyRate: null,
    version: 0,
    companyName: 'Riverside Services',
    can: { edit: true },
    ...overrides,
  });

  it('saves what the company prints, and says it is not a certified tax document', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(ISSUE),
      'GET /v1/finance/settings': () => ({ body: settings() }),
      'PUT /v1/finance/settings': () => ({
        body: settings({ legalName: 'Riverside Services LLC', defaultDueDays: 14, version: 1 }),
      }),
    });
    const { container } = renderScreen(<FinanceSettingsScreen />, client);
    expect(
      await screen.findByText(/not certified tax or e-invoicing documents/u),
    ).toBeInTheDocument();
    expect(screen.getByText('Leave empty to print “Riverside Services”.')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.type(screen.getByLabelText('Legal name'), 'Riverside Services LLC');
    await user.clear(screen.getByLabelText('Days to pay'));
    await user.type(screen.getByLabelText('Days to pay'), '14');
    await user.type(screen.getByLabelText('Labour rate per hour'), '150');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({
      expectedVersion: 0,
      legalName: 'Riverside Services LLC',
      address: null,
      taxReference: null,
      paymentInstructions: null,
      footer: null,
      defaultDueDays: 14,
      labourHourlyCost: null,
      labourHourlyRate: '150',
    });
  });

  it('shows the settings read-only to a seat that may not change them', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/finance/settings': () => ({ body: settings({ can: { edit: false } }) }),
    });
    renderScreen(<FinanceSettingsScreen />, client);
    expect(await screen.findByText('Only owners and admins change these.')).toBeInTheDocument();
    expect(screen.getByLabelText('Legal name')).toBeDisabled();
    expect(screen.queryByLabelText('Labour cost per hour')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('shows what a customer owes and has on account', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(ISSUE),
      'GET /v1/finance/customers/:id/account': () => ({
        body: {
          accounts: [{ currencyCode: 'EGP', owed: '228', unallocated: '300', net: '-72' }],
          openInvoices: [row()],
          unallocatedPayments: [payment()],
        },
      }),
    });
    const { container } = renderScreen(
      <CustomerAccountSection customerId={CUSTOMER} customerName="Riverside Housing" />,
      client,
    );
    expect(await screen.findByText('Owes EGP 228.00')).toBeInTheDocument();
    expect(screen.getByText('In credit EGP 72.00')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'INV-000012' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'RC-000003' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Record payment' })).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('leaves the customer screen as it was without the finance module', async () => {
    const { client, calls } = fakeApi({ 'GET /v1/me': me(ISSUE, { finance: false }) });
    const { container } = renderScreen(
      <CustomerAccountSection customerId={CUSTOMER} customerName="Riverside Housing" />,
      client,
    );
    await waitFor(() => expect(calls.some((call) => call.path === '/v1/me')).toBe(true));
    expect(container).toBeEmptyDOMElement();
    expect(calls.some((call) => call.path.startsWith('/v1/finance'))).toBe(false);
  });

  it('invoices a completed job and shows what it cost against what it earned', async () => {
    const user = userEvent.setup();
    const costs: JobCosts = {
      workOrder: { id: JOB, reference: 'WO-000021' },
      currencyCode: 'EGP',
      seesCosts: true,
      parts: { cost: '40' },
      labour: { hours: '1.5', hourlyCost: '60', cost: '90', costed: true },
      cost: '130',
      invoiced: { net: '0', invoices: 0 },
      profit: '-130',
    };
    const { client, calls } = fakeApi({
      'GET /v1/me': me(ISSUE),
      'GET /v1/finance/work-orders/:id/costs': () => ({ body: costs }),
      'GET /v1/finance/invoices': () => ({ body: { items: [], nextCursor: null } }),
      'POST /v1/finance/invoices/from-job': () => ({
        status: 201,
        body: detail({
          invoice: invoice({ source: { kind: 'work_order', id: JOB, reference: 'WO-000021' } }),
        }),
      }),
    });
    const { navigate, container } = renderScreen(
      <JobFinancePanel workOrderId={JOB} state="complete" />,
      client,
    );
    expect(await screen.findByText('EGP 130.00')).toBeInTheDocument();
    expect(screen.getByText('EGP 90.00')).toBeInTheDocument();
    expect(screen.getByText('-EGP 130.00')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);
    expect(
      calls.find((call) => call.path === '/v1/finance/invoices')!.query.get('workOrderId'),
    ).toBe(JOB);

    await user.click(screen.getByRole('button', { name: 'Invoice this job' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/finance/invoices/${INVOICE}`));
    expect(calls.find((call) => call.path.endsWith('/from-job'))!.body).toEqual({
      workOrderId: JOB,
    });
  });

  it('hides costs from a seat that may not see them and waits for the job to finish', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/finance/work-orders/:id/costs': () => ({
        body: {
          workOrder: { id: JOB, reference: 'WO-000021' },
          currencyCode: 'EGP',
          seesCosts: false,
          parts: { cost: null },
          labour: { hours: '1.5', hourlyCost: null, cost: null, costed: false },
          cost: null,
          invoiced: { net: '0', invoices: 0 },
          profit: null,
        } satisfies JobCosts,
      }),
      'GET /v1/finance/invoices': () => ({ body: { items: [], nextCursor: null } }),
    });
    renderScreen(<JobFinancePanel workOrderId={JOB} state="in_progress" />, client);
    expect(
      await screen.findByText('The job can be invoiced once it is complete.'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Hours on site')).toBeInTheDocument();
    expect(screen.queryByText('Profit')).not.toBeInTheDocument();
    expect(screen.queryByText('Parts')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invoice this job' })).not.toBeInTheDocument();
  });
});
