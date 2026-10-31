import { at, day, type DemoContext } from '../context.js';

/**
 * CRM: pipelines, leads (some converted), opportunities through their stages,
 * and calls, meetings and tasks around them.
 *
 * Adds to refs:
 *   pipelines      { main, maintenance } → pipeline id
 *   opportunities  { id, title, customerId, status }[]
 *   leads          { id, displayName, status }[]
 */

interface Stage {
  id: string;
  key: string;
  label: string;
  position: number;
  outcome: 'open' | 'won' | 'lost';
}
interface Pipeline {
  id: string;
  name: string;
  isDefault: boolean;
  stages: Stage[];
}
interface Opportunity {
  id: string;
  version: number;
  status: string;
  customer: { id: string } | null;
}
interface DemoCustomer {
  id: string;
  name: string;
  contacts: string[];
}

const LEADS = [
  {
    displayName: 'Khaled Mahmoud',
    companyName: 'Mahmoud Textiles',
    source: 'web',
    status: 'new',
    value: '85000.00',
    notes: 'Asked about chiller maintenance for two factories.',
  },
  {
    displayName: 'Inas Fouad',
    companyName: 'Fouad Dental Clinics',
    source: 'referral',
    status: 'new',
    value: '42000.00',
  },
  {
    displayName: 'George Hanna',
    companyName: 'New Cairo Mall',
    source: 'manual',
    status: 'contacted',
    value: '320000.00',
    notes: 'Wants a full FM tender for the food court.',
  },
  {
    displayName: 'Amira Salah',
    companyName: 'Salah Hotels',
    source: 'web',
    status: 'contacted',
    value: '150000.00',
  },
  {
    displayName: 'Hesham Ragab',
    companyName: 'Ragab Cold Chain',
    source: 'referral',
    status: 'qualified',
    value: '210000.00',
  },
  {
    displayName: 'Noha Sherif',
    companyName: 'Sherif Architects',
    source: 'other',
    status: 'qualified',
    value: '60000.00',
  },
  {
    displayName: 'Bassem Youssef',
    companyName: 'Youssef Car Wash',
    source: 'web',
    status: 'unqualified',
    value: '8000.00',
    unqualifiedReason: 'Too small: one split unit, outside our area.',
  },
  {
    displayName: 'Rana Adly',
    companyName: 'Adly Gyms',
    source: 'import',
    status: 'unqualified',
    value: '25000.00',
    unqualifiedReason: 'Already signed with a competitor for three years.',
  },
  {
    displayName: 'Mahmoud Fekry',
    companyName: 'October Data Centre',
    source: 'referral',
    status: 'qualified',
    value: '480000.00',
    notes: 'Precision cooling, 24/7 SLA.',
  },
  {
    displayName: 'Yasmin Gamal',
    companyName: 'Gamal Supermarkets',
    source: 'web',
    status: 'contacted',
    value: '130000.00',
  },
  // These three are converted below.
  {
    displayName: 'Sameh Labib',
    companyName: 'Labib Pharma Labs',
    source: 'referral',
    status: 'qualified',
    value: '275000.00',
    convert: true,
  },
  {
    displayName: 'Ola Ezz',
    companyName: 'Ezz Residential Compound',
    source: 'web',
    status: 'qualified',
    value: '190000.00',
    convert: true,
  },
  {
    displayName: 'Fady Naguib',
    companyName: 'Naguib Logistics',
    source: 'manual',
    status: 'qualified',
    value: '95000.00',
    convert: true,
  },
] as const;

export async function seedCrm(ctx: DemoContext): Promise<void> {
  const customers = ctx.refs.customers as DemoCustomer[];
  const owner = ctx.people.owner.userId;
  const admin = ctx.people.admin.userId;

  // Pipelines: the default, and one for contract renewals with its own stages.
  const { items } = await ctx.call<{ items: Pipeline[] }>('owner', 'GET', '/v1/crm/pipelines');
  let main = items.find((pipeline) => pipeline.isDefault) ?? items[0];
  main ??= await ctx.call<Pipeline>('owner', 'POST', '/v1/crm/pipelines', { name: 'New business' });
  let maintenance = await ctx.call<Pipeline>('owner', 'POST', '/v1/crm/pipelines', {
    name: 'Maintenance contracts',
  });
  maintenance =
    (await ctx.attempt<Pipeline>('owner', 'POST', `/v1/crm/pipelines/${maintenance.id}/stages`, {
      label: 'Site survey done',
      probabilityBp: 6000,
    })) ?? maintenance;
  ctx.refs.pipelines = { main: main.id, maintenance: maintenance.id };

  const open = (pipeline: Pipeline) =>
    pipeline.stages
      .filter((stage) => stage.outcome === 'open')
      .sort((a, b) => a.position - b.position);
  const outcome = (pipeline: Pipeline, kind: 'won' | 'lost') =>
    pipeline.stages.find((stage) => stage.outcome === kind);

  // Leads.
  const leads: { id: string; displayName: string; status: string; version: number }[] = [];
  for (const [index, seed] of LEADS.entries()) {
    const lead = await ctx.call<{ id: string; status: string; version: number }>(
      'admin',
      'POST',
      '/v1/crm/leads',
      {
        displayName: seed.displayName,
        companyName: seed.companyName,
        email: `${seed.displayName.split(' ')[0]!.toLowerCase()}@${seed.companyName.split(' ')[0]!.toLowerCase()}.example.com`,
        phone: `+20 110 ${String(200 + index)} ${String(1000 + index * 7)}`,
        source: seed.source,
        status: seed.status,
        assignedTo: index % 2 === 0 ? admin : owner,
        estimatedValue: seed.value,
        currencyCode: 'EGP',
        ...('notes' in seed ? { notes: seed.notes } : {}),
        ...('unqualifiedReason' in seed ? { unqualifiedReason: seed.unqualifiedReason } : {}),
      },
    );
    leads.push({
      id: lead.id,
      displayName: seed.displayName,
      status: lead.status,
      version: lead.version,
    });
  }

  // Three leads become customers, each with an opportunity.
  const opportunities: { id: string; title: string; customerId: string | null; status: string }[] =
    [];
  const converted: { customerId: string; opportunityId: string | null }[] = [];
  for (const [index, seed] of LEADS.entries()) {
    if (!('convert' in seed)) {
      continue;
    }
    const lead = leads[index]!;
    const result = await ctx.attempt<{ customerId: string; opportunityId: string | null }>(
      'admin',
      'POST',
      `/v1/crm/leads/${lead.id}/convert`,
      {
        expectedVersion: lead.version,
        customer: {
          mode: 'new',
          name: seed.companyName,
          email: `info@${seed.companyName.split(' ')[0]!.toLowerCase()}.example.com`,
          phone: `+20 2 2600 ${String(3000 + index)}`,
        },
        contact: {
          mode: 'new',
          name: seed.displayName,
          jobTitle: 'Decision maker',
          isPrimary: true,
        },
        opportunity: {
          title: `${seed.companyName}: first contract`,
          amount: seed.value,
          currencyCode: 'EGP',
          expectedCloseDate: day(30 + index),
        },
      },
    );
    if (result !== undefined) {
      lead.status = 'converted';
      converted.push(result);
      if (result.opportunityId !== null) {
        opportunities.push({
          id: result.opportunityId,
          title: `${seed.companyName}: first contract`,
          customerId: result.customerId,
          status: 'open',
        });
      }
    }
  }

  // Opportunities on existing customers, spread across the stages.
  const plans: {
    title: string;
    customer: number;
    amount: string;
    pipeline: Pipeline;
    /** Index into the open stages, or the outcome. */
    to: number | 'won' | 'lost';
    close: number;
    lostReason?: string;
  }[] = [
    {
      title: 'Tower A chiller replacement',
      customer: 0,
      amount: '1250000.00',
      pipeline: main,
      to: 2,
      close: 45,
    },
    {
      title: 'Theatre HVAC upgrade',
      customer: 1,
      amount: '2400000.00',
      pipeline: main,
      to: 3,
      close: 20,
    },
    {
      title: 'Bakehouse extraction system',
      customer: 2,
      amount: '380000.00',
      pipeline: main,
      to: 'won',
      close: -12,
    },
    {
      title: 'Cold store 1 refrigeration retrofit',
      customer: 3,
      amount: '960000.00',
      pipeline: main,
      to: 1,
      close: 60,
    },
    {
      title: 'School summer works package',
      customer: 4,
      amount: '540000.00',
      pipeline: main,
      to: 'lost',
      close: -20,
      lostReason: 'Budget moved to next year.',
    },
    {
      title: 'Resort annual maintenance',
      customer: 5,
      amount: '720000.00',
      pipeline: maintenance,
      to: 'won',
      close: -5,
    },
    {
      title: 'B12 LED lighting upgrade',
      customer: 6,
      amount: '210000.00',
      pipeline: main,
      to: 0,
      close: 75,
    },
    {
      title: 'Medical centre PPM renewal',
      customer: 1,
      amount: '450000.00',
      pipeline: maintenance,
      to: 1,
      close: 30,
    },
    {
      title: 'Zamalek towers PPM contract',
      customer: 0,
      amount: '600000.00',
      pipeline: maintenance,
      to: 'lost',
      close: -30,
      lostReason: 'Price: chose a cheaper provider.',
    },
    {
      title: 'Alexandria warehouse electrical survey',
      customer: 3,
      amount: '85000.00',
      pipeline: maintenance,
      to: 0,
      close: 14,
    },
  ];
  for (const [index, plan] of plans.entries()) {
    const customer = customers[plan.customer];
    if (customer === undefined) {
      continue;
    }
    const stages = open(plan.pipeline);
    let opportunity = await ctx.call<Opportunity>('admin', 'POST', '/v1/crm/opportunities', {
      title: plan.title,
      customerId: customer.id,
      ownerId: index % 3 === 0 ? owner : admin,
      amount: plan.amount,
      currencyCode: 'EGP',
      expectedCloseDate: day(plan.close),
      stageId: stages[0]?.id,
      description: `${plan.title} for ${customer.name}.`,
    });

    // Walk forward through the stages, as a salesperson would.
    const target =
      typeof plan.to === 'number' ? Math.min(plan.to, stages.length - 1) : stages.length - 1;
    for (let step = 1; step <= target; step++) {
      opportunity = (
        await ctx.call<{ opportunity: Opportunity }>(
          'admin',
          'POST',
          `/v1/crm/opportunities/${opportunity.id}/transitions`,
          { expectedVersion: opportunity.version, stageId: stages[step]!.id },
        )
      ).opportunity;
    }
    if (typeof plan.to === 'string') {
      const stage = outcome(plan.pipeline, plan.to);
      if (stage !== undefined) {
        const moved = await ctx.attempt<{ opportunity: Opportunity }>(
          'admin',
          'POST',
          `/v1/crm/opportunities/${opportunity.id}/transitions`,
          {
            expectedVersion: opportunity.version,
            stageId: stage.id,
            ...(plan.lostReason === undefined ? {} : { lostReason: plan.lostReason }),
          },
        );
        opportunity = moved?.opportunity ?? opportunity;
      }
    }
    opportunities.push({
      id: opportunity.id,
      title: plan.title,
      customerId: customer.id,
      status: opportunity.status,
    });
  }
  ctx.refs.opportunities = opportunities;
  ctx.refs.leads = leads.map(({ id, displayName, status }) => ({ id, displayName, status }));

  // Activities: done in the past, open in the future, some overdue.
  const activity = (body: Record<string, unknown>, as: 'owner' | 'admin' = 'admin') =>
    ctx.call<{ id: string; version: number }>(as, 'POST', '/v1/crm/activities', body);
  const lead = (index: number) => [leads[index]!.id];
  const opp = (index: number) =>
    opportunities[index] === undefined ? [] : [opportunities[index].id];
  const cust = (index: number) => (customers[index] === undefined ? [] : [customers[index].id]);

  const activities: Record<string, unknown>[] = [
    {
      kind: 'call',
      subject: 'Intro call',
      outcome: 'Interested; send brochure.',
      done: true,
      dueAt: at(-9, 10),
      leadIds: lead(0),
    },
    {
      kind: 'email',
      subject: 'Sent capabilities brochure',
      done: true,
      dueAt: at(-8, 14),
      leadIds: lead(0),
    },
    {
      kind: 'meeting',
      subject: 'Site walk-round at the food court',
      detail: 'Meet George at the management office.',
      dueAt: at(3, 11),
      leadIds: lead(2),
    },
    {
      kind: 'follow_up',
      subject: 'Chase decision on the FM tender',
      dueAt: at(-2, 9),
      leadIds: lead(2),
    },
    {
      kind: 'call',
      subject: 'Qualification call',
      outcome: 'Budget confirmed for Q1.',
      done: true,
      dueAt: at(-15, 12),
      leadIds: lead(4),
    },
    {
      kind: 'task',
      subject: 'Prepare data centre cooling proposal',
      dueAt: at(5, 9),
      leadIds: lead(8),
      assignedTo: owner,
    },
    {
      kind: 'meeting',
      subject: 'Chiller options review',
      detail: 'Bring the two manufacturer quotes.',
      dueAt: at(2, 13),
      opportunityIds: opp(3),
      customerIds: cust(0),
    },
    {
      kind: 'call',
      subject: 'Theatre downtime window',
      outcome: 'Two weekends in the next month are possible.',
      done: true,
      dueAt: at(-4, 16),
      opportunityIds: opp(4),
      customerIds: cust(1),
    },
    {
      kind: 'note',
      subject: 'Won: extraction system',
      detail: 'Signed PO received by email.',
      done: true,
      dueAt: at(-12, 15),
      opportunityIds: opp(5),
      customerIds: cust(2),
    },
    {
      kind: 'follow_up',
      subject: 'Ask why we lost the school package',
      dueAt: at(-1, 10),
      opportunityIds: opp(7),
      customerIds: cust(4),
    },
    {
      kind: 'task',
      subject: 'Send PPM renewal pricing',
      dueAt: at(7, 9),
      opportunityIds: opp(10),
      customerIds: cust(1),
    },
    {
      kind: 'email',
      subject: 'Quarterly service report sent',
      done: true,
      dueAt: at(-20, 11),
      customerIds: cust(5),
    },
    {
      kind: 'meeting',
      subject: 'Kick-off with new customer',
      dueAt: at(4, 10),
      opportunityIds: opp(0),
    },
    {
      kind: 'call',
      subject: 'Survey booking',
      dueAt: at(1, 12),
      opportunityIds: opp(12),
      customerIds: cust(3),
    },
  ];
  let count = 0;
  for (const [index, body] of activities.entries()) {
    const created = await ctx.attempt<{ id: string }>('admin', 'POST', '/v1/crm/activities', {
      ...body,
      ...(body.assignedTo === undefined ? { assignedTo: index % 2 === 0 ? admin : owner } : {}),
    });
    if (created !== undefined) {
      count++;
    }
  }
  // One cancelled.
  const cancelled = await activity({
    kind: 'meeting',
    subject: 'Lunch with Salah Hotels (postponed)',
    dueAt: at(6, 13),
    leadIds: lead(3),
  });
  await ctx.attempt('admin', 'PATCH', `/v1/crm/activities/${cancelled.id}`, {
    expectedVersion: cancelled.version,
    status: 'cancelled',
  });

  ctx.log(
    `2 pipelines, ${String(leads.length)} leads (${String(converted.length)} converted), ${String(opportunities.length)} opportunities, ${String(count + 1)} activities`,
  );
}
