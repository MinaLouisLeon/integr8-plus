import type { DemoContext } from '../context.js';
import type { DemoItem } from './inventory.js';

/**
 * E-invoicing with the Egyptian Tax Authority, set up against its pre-production
 * environment with a made-up taxpayer, and two invoices prepared as unsigned
 * documents.
 *
 * Nothing is signed or sent: no credentials are stored, so the documents wait
 * at "ready" exactly as a company's would before its signer plugs in a token.
 *
 * Adds to refs:
 *   etaDocuments  { id, invoiceId, state }[]
 */

const ADDRESS = {
  country: 'EG',
  governate: 'Cairo',
  regionCity: 'Nasr City',
  street: 'Abbas El Akkad',
  buildingNumber: '42',
  postalCode: '11765',
  floor: '3',
  room: null,
  landmark: 'Near City Stars',
  additionalInformation: null,
};

const CITY_GOVERNATE: Record<string, string> = {
  Cairo: 'Cairo',
  Giza: 'Giza',
  Alexandria: 'Alexandria',
  Hurghada: 'Red Sea',
};

/** Integr8 units to ETA unit type codes. */
const UNIT_TYPES: Record<string, string> = {
  each: 'EA',
  pair: 'PR',
  set: 'SET',
  box: 'BOX',
  pack: 'PK',
  roll: 'RO',
  m: 'M',
  l: 'LTR',
  kg: 'KGM',
  hour: 'HUR',
};

export async function seedEInvoicing(ctx: DemoContext): Promise<void> {
  // The module is Integr8's to switch on for a company.
  await ctx.call('staff', 'PUT', '/v1/eta/availability', { enabled: true });

  const current = await ctx.call<{ version: number }>('owner', 'GET', '/v1/eta/settings');
  await ctx.call('owner', 'PUT', '/v1/eta/settings', {
    expectedVersion: current.version,
    enabled: true,
    environment: 'preprod',
    taxpayerId: '100200300',
    issuerName: 'Nile Delta Facilities S.A.E.',
    branchId: '0',
    activityCode: '4329',
    address: ADDRESS,
    intermediaryFor: null,
    documentTypeVersion: '1.0',
    defaultItem: { itemType: 'EGS', itemCode: 'EG-100200300-SERVICE' },
  });

  // Receivers: every business customer, by a made-up tax registration number.
  const customers = ctx.refs.customers as {
    id: string;
    name: string;
    sites: { id: string; name: string }[];
  }[];
  let receivers = 0;
  for (const [index, customer] of customers.entries()) {
    const city =
      ['Cairo', 'Cairo', 'Giza', 'Alexandria', 'Cairo', 'Hurghada', 'Giza', 'Cairo'][index] ??
      'Cairo';
    const saved = await ctx.attempt<unknown>('owner', 'PUT', `/v1/eta/receivers/${customer.id}`, {
      receiverType: 'B',
      receiverId: String(300400500 + index * 1111),
      address: {
        country: 'EG',
        governate: CITY_GOVERNATE[city] ?? 'Cairo',
        regionCity: city,
        street: customer.sites[0]?.name ?? 'Main street',
        buildingNumber: String(10 + index),
        postalCode: null,
        floor: null,
        room: null,
        landmark: null,
        additionalInformation: null,
      },
    });
    if (saved !== undefined) {
      receivers += 1;
    }
  }

  // Item codes: EGS codes for everything in the catalogue.
  const items = (ctx.refs.items as DemoItem[] | undefined) ?? [];
  for (const [index, item] of items.entries()) {
    await ctx.attempt('owner', 'PUT', `/v1/eta/item-codes/${item.id}`, {
      itemType: 'EGS',
      itemCode: `EG-100200300-${String(1001 + index)}`,
    });
  }

  await ctx.call('owner', 'PUT', '/v1/eta/unit-types', { unitTypes: UNIT_TYPES });
  await ctx.call('owner', 'PUT', '/v1/eta/tax-mappings', {
    taxMappings: [
      { taxRateBp: 1400, taxType: 'T1', subType: 'V009' },
      { taxRateBp: 0, taxType: 'T1', subType: 'V003' },
    ],
  });

  // Two issued invoices become documents ready to sign.
  const invoices = (ctx.refs.invoices as { id: string; status: string }[] | undefined) ?? [];
  const issued = invoices.filter((invoice) =>
    ['issued', 'paid', 'partially_paid'].includes(invoice.status),
  );
  const documents: { id: string; invoiceId: string; state: string }[] = [];
  for (const invoice of issued.slice(0, 2)) {
    const document = await ctx.attempt<{ id: string; state: string }>(
      'owner',
      'POST',
      `/v1/eta/invoices/${invoice.id}/prepare`,
      {},
    );
    if (document !== undefined) {
      documents.push({ id: document.id, invoiceId: invoice.id, state: document.state });
    }
  }
  ctx.refs.etaDocuments = documents;

  ctx.log(
    `pre-production settings, ${String(receivers)} receivers, ${String(items.length)} item codes, ${String(documents.length)} documents ready to sign`,
  );
}
