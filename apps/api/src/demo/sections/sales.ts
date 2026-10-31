import { at, day, type DemoContext } from '../context.js';
import { itemBySku } from './inventory.js';

/**
 * Sales: quotes in every state, orders made from the accepted ones and from
 * scratch, stock reserved and delivered, and a job raised from an order.
 *
 * Adds to refs:
 *   quotes       { id, reference, status, customerId }[]
 *   salesOrders  { id, status, customerId }[]   (status after seeding: draft, confirmed,
 *                                                partially_fulfilled, fulfilled, cancelled…)
 */

interface DemoCustomer {
  id: string;
  name: string;
  contacts: string[];
  sites: { id: string; name: string }[];
}
interface QuoteDetail {
  quote: { id: string; reference: string; status: string; version: number };
}
interface OrderDetail {
  order: { id: string; reference: string; status: string; version: number };
  lines: { id: string; itemId: string | null; quantity: string }[];
}

/** 14% VAT, the standard Egyptian rate. */
const VAT = 1400;

type LineSeed = [sku: string, quantity: string, discountBp?: number];

export async function seedSales(ctx: DemoContext): Promise<void> {
  const customers = (ctx.refs.customers as DemoCustomer[]).filter(
    (_, index) => index !== ctx.refs.onHoldCustomerIndex,
  );
  const opportunities = (ctx.refs.opportunities ?? []) as {
    id: string;
    customerId: string | null;
    status: string;
  }[];
  const warehouse = (ctx.refs.locations as Record<string, string>).warehouse;

  const lines = (seeds: LineSeed[]) =>
    seeds.map(([sku, quantity, discountBp]) => {
      const item = itemBySku(ctx, sku);
      return {
        itemId: item.id,
        description: item.name,
        quantity,
        unitPrice: item.price,
        taxRateBp: VAT,
        ...(discountBp === undefined ? {} : { discountBp }),
      };
    });

  const customer = (index: number) => customers[index % customers.length]!;
  const openOpportunity = (customerId: string) =>
    opportunities.find(
      (candidate) => candidate.customerId === customerId && candidate.status === 'open',
    );

  const draftQuote = async (index: number, title: string, seeds: LineSeed[], validDays: number) => {
    const who = customer(index);
    const opportunity = openOpportunity(who.id);
    return ctx.call<QuoteDetail>('admin', 'POST', '/v1/sales/quotes', {
      customerId: who.id,
      siteId: who.sites[0]?.id,
      ...(who.contacts[0] === undefined ? {} : { contactId: who.contacts[0] }),
      ...(opportunity === undefined ? {} : { opportunityId: opportunity.id }),
      title,
      validUntil: day(validDays),
      currencyCode: 'EGP',
      introduction: `Thank you for the opportunity to quote for ${title.toLowerCase()}.`,
      terms:
        '50% on order, balance on completion. Prices include supply and installation unless stated.',
      lines: lines(seeds),
    });
  };
  const step = async (detail: QuoteDetail, action: string, body: Record<string, unknown> = {}) =>
    ctx.call<QuoteDetail>('admin', 'POST', `/v1/sales/quotes/${detail.quote.id}/${action}`, {
      expectedVersion: detail.quote.version,
      ...body,
    });

  const quotes: { id: string; reference: string; status: string; customerId: string }[] = [];
  const keep = (detail: QuoteDetail, customerId: string) => {
    quotes.push({
      id: detail.quote.id,
      reference: detail.quote.reference,
      status: detail.quote.status,
      customerId,
    });
  };

  // 1. Draft, not sent yet.
  keep(
    await draftQuote(
      0,
      'Tower B corridor lighting',
      [
        ['EL-LED-040', '24'],
        ['SV-LAB-HR', '16'],
      ],
      30,
    ),
    customer(0).id,
  );

  // 2. Issued, waiting for an answer.
  const issued = await step(
    await draftQuote(
      1,
      'Outpatients split units',
      [
        ['EQ-SPL-240', '3'],
        ['EQ-BRK-KIT', '3'],
        ['SV-LAB-HR', '12'],
      ],
      21,
    ),
    'issue',
  );
  keep(issued, customer(1).id);

  // 3 and 4. Accepted, then converted to orders below.
  const accepted: { detail: QuoteDetail; customerId: string }[] = [];
  for (const [index, title, seeds] of [
    [
      2,
      'Bakehouse extraction fan replacement',
      [
        ['HV-FAN-250', '2'],
        ['HV-CAP-035', '2'],
        ['SV-LAB-HR', '6'],
      ],
    ],
    [
      3,
      'Cold store filter and refrigerant service',
      [
        ['HV-FLT-001', '20'],
        ['HV-GAS-410', '1'],
        ['SV-PPM-VISIT', '2'],
      ],
    ],
  ] as [number, string, LineSeed[]][]) {
    const sent = await step(await draftQuote(index, title, seeds, 30), 'issue');
    const answered = await step(sent, 'answer', {
      status: 'accepted',
      name: 'Customer by email',
    });
    accepted.push({ detail: answered, customerId: customer(index).id });
  }

  // 5. Declined.
  const declinedSent = await step(
    await draftQuote(
      4,
      'Classroom AC replacement',
      [
        ['EQ-SPL-120', '8'],
        ['SV-LAB-HR', '24'],
      ],
      30,
    ),
    'issue',
  );
  keep(
    await step(declinedSent, 'answer', {
      status: 'rejected',
      name: 'Ms. Heba Aziz',
      reason: 'Over budget this term.',
    }),
    customer(4).id,
  );

  // 6. Revised: R1 superseded by an R2 with a discount, issued.
  const firstRevision = await step(
    await draftQuote(
      5,
      'Resort water heaters',
      [
        ['EQ-WHT-080', '10'],
        ['SV-LAB-HR', '20'],
      ],
      30,
    ),
    'issue',
  );
  const revised = await ctx.attempt<QuoteDetail>(
    'admin',
    'POST',
    `/v1/sales/quotes/${firstRevision.quote.id}/revise`,
    {
      expectedVersion: firstRevision.quote.version,
    },
  );
  if (revised === undefined) {
    keep(firstRevision, customer(5).id);
  } else {
    const changed = await ctx.call<QuoteDetail>(
      'admin',
      'PATCH',
      `/v1/sales/quotes/${revised.quote.id}`,
      {
        expectedVersion: revised.quote.version,
        lines: lines([
          ['EQ-WHT-080', '10', 750],
          ['SV-LAB-HR', '18'],
        ]),
        internalNotes: 'R2: 7.5% off the heaters to match a competitor.',
      },
    );
    keep(await step(changed, 'issue'), customer(5).id);
  }

  // 7. Cancelled.
  keep(
    await step(
      await draftQuote(6, 'Server room cooling (withdrawn)', [['EQ-SPL-240', '2']], 30),
      'cancel',
      {
        reason: 'Customer moved the server room; to re-quote later.',
      },
    ),
    customer(6).id,
  );

  // 8. Issued and now past its validity date.
  keep(
    await step(
      await draftQuote(
        0,
        'Tower A RCD upgrade',
        [
          ['EL-RCD-040', '12'],
          ['SV-LAB-HR', '8'],
        ],
        -10,
      ),
      'issue',
    ),
    customer(0).id,
  );

  // Orders. The two accepted quotes become orders; then a few from scratch.
  const orders: { id: string; status: string; customerId: string }[] = [];
  const keepOrder = (detail: OrderDetail, customerId: string) => {
    orders.push({ id: detail.order.id, status: detail.order.status, customerId });
  };
  const confirm = (detail: OrderDetail) =>
    ctx.call<OrderDetail>('admin', 'POST', `/v1/sales/orders/${detail.order.id}/confirm`, {
      expectedVersion: detail.order.version,
      reserveLocationId: warehouse,
    });
  const deliver = async (detail: OrderDetail, fraction: 'all' | 'part', notes: string) => {
    const stocked = detail.lines.filter(
      (line) => line.itemId !== null && isStock(ctx, line.itemId),
    );
    const chosen = fraction === 'all' ? stocked : stocked.slice(0, 1);
    if (chosen.length === 0) {
      return detail;
    }
    const result = await ctx.attempt<{ order: OrderDetail }>(
      'admin',
      'POST',
      `/v1/sales/orders/${detail.order.id}/deliveries`,
      {
        expectedVersion: detail.order.version,
        locationId: warehouse,
        notes,
        lines: chosen.map((line) => ({
          orderLineId: line.id,
          quantity:
            fraction === 'all'
              ? line.quantity
              : String(Math.max(1, Math.floor(Number(line.quantity) / 2))),
        })),
      },
    );
    return result?.order ?? detail;
  };

  for (const [index, { detail, customerId }] of accepted.entries()) {
    const converted = await ctx.call<OrderDetail>(
      'admin',
      'POST',
      `/v1/sales/quotes/${detail.quote.id}/convert`,
      {
        expectedVersion: detail.quote.version,
      },
    );
    keep({ quote: { ...detail.quote, status: 'converted' } }, customerId);
    let order = await confirm(converted);
    // The first is delivered in full; the second goes out in part.
    order = await deliver(
      order,
      index === 0 ? 'all' : 'part',
      index === 0 ? 'Delivered to site, signed by Sherif.' : 'First drop: filters only.',
    );
    keepOrder(order, customerId);
  }

  const newOrder = (index: number, title: string, seeds: LineSeed[]) => {
    const who = customer(index);
    return ctx.call<OrderDetail>('admin', 'POST', '/v1/sales/orders', {
      customerId: who.id,
      siteId: who.sites[0]?.id,
      ...(who.contacts[0] === undefined ? {} : { contactId: who.contacts[0] }),
      title,
      currencyCode: 'EGP',
      notes: 'Ordered by phone.',
      lines: lines(seeds),
    });
  };

  // Draft.
  keepOrder(
    await newOrder(1, 'Spare filters for the clinic', [
      ['HV-FLT-001', '30'],
      ['CN-CLN-005', '10'],
    ]),
    customer(1).id,
  );

  // Confirmed, stock reserved, not delivered yet; with a job to install it.
  const install = await confirm(
    await newOrder(6, 'B12 meeting room AC install', [
      ['EQ-SPL-120', '2'],
      ['EQ-BRK-KIT', '2'],
      ['SV-LAB-HR', '8'],
    ]),
  );
  const jobTypes = ctx.refs.jobTypes as Record<string, string> | undefined;
  let linked = install;
  if (jobTypes?.INSTALL !== undefined) {
    const withJob = await ctx.attempt<OrderDetail>(
      'admin',
      'POST',
      `/v1/sales/orders/${install.order.id}/work-orders`,
      {
        create: {
          jobTypeId: jobTypes.INSTALL,
          title: 'Install two split units, meeting rooms 2 and 3',
          priority: 'normal',
          dueFrom: at(4, 9),
          dueBy: at(4, 17),
          crew: [{ userId: ctx.people.engineer1.userId, lead: true }],
        },
      },
    );
    linked = withJob ?? install;
  }
  keepOrder(linked, customer(6).id);

  // Confirmed with more than the warehouse holds: reserved in part, a shortfall.
  keepOrder(
    await confirm(
      await newOrder(3, 'Thermostats for the warehouse offices', [
        ['HV-THM-200', '6'],
        ['SV-LAB-HR', '4'],
      ]),
    ),
    customer(3).id,
  );

  // Delivered in full.
  const delivered = await deliver(
    await confirm(
      await newOrder(0, 'Electrical spares for Tower A', [
        ['EL-MCB-032', '10'],
        ['EL-CBL-025', '100'],
        ['CN-TAP-019', '20'],
      ]),
    ),
    'all',
    'Collected by the building manager.',
  );
  keepOrder(delivered, customer(0).id);

  // Cancelled after confirming, which releases its reservation.
  const cancelling = await confirm(
    await newOrder(5, 'Pool pump replacement', [
      ['PL-PMP-001', '1'],
      ['SV-LAB-HR', '4'],
    ]),
  );
  const cancelled = await ctx.attempt<OrderDetail>(
    'admin',
    'POST',
    `/v1/sales/orders/${cancelling.order.id}/cancel`,
    {
      expectedVersion: cancelling.order.version,
      reason: 'Resort repaired the old pump in-house.',
    },
  );
  keepOrder(cancelled ?? cancelling, customer(5).id);

  ctx.refs.quotes = quotes;
  ctx.refs.salesOrders = orders;
  const states = (list: { status: string }[]) =>
    Object.entries(
      list.reduce<Record<string, number>>(
        (acc, entry) => ({ ...acc, [entry.status]: (acc[entry.status] ?? 0) + 1 }),
        {},
      ),
    )
      .map(([status, count]) => `${String(count)} ${status}`)
      .join(', ');
  ctx.log(`${String(quotes.length)} quotes (${states(quotes)})`);
  ctx.log(`${String(orders.length)} sales orders (${states(orders)})`);
}

function isStock(ctx: DemoContext, itemId: string): boolean {
  const items = ctx.refs.items as { id: string; kind: string }[];
  return items.find((item) => item.id === itemId)?.kind === 'stock_item';
}
