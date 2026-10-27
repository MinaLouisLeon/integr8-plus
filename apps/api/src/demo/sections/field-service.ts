import { at, type DemoContext } from '../context.js';
import { REPORT_ANSWERS } from './forms.js';
import { itemBySku } from './inventory.js';

/**
 * Work orders in every state, with crews, visits on the schedule, checklist
 * ticks, comments, parts used from the vans, a part bought on the way, and
 * jobs linked to assets.
 *
 * Adds to refs:
 *   workOrders  { id, state, customerId, siteId }[]
 *   submissions { id, status }[]  service reports engineers filled in
 */

type State =
  | 'scheduled'
  | 'dispatched'
  | 'travelling'
  | 'on_site'
  | 'in_progress'
  | 'awaiting_parts'
  | 'complete'
  | 'reviewed'
  | 'cancelled';

type Engineer = 'engineer1' | 'engineer2' | 'engineer3';

interface JobSeed {
  customer: number;
  site: number;
  type: 'INSTALL' | 'PPM' | 'REPAIR' | 'INSPECT' | 'CALLOUT';
  title: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  /** Days from today the visit is booked (negative: in the past). */
  when: number;
  engineer: Engineer;
  state: State;
  parts?: [sku: string, quantity: string][];
  comment?: string;
}

/**
 * Twenty-six jobs. Gas inspections and installs go to engineer1, who holds the
 * certificates they need; engineer3's electrical certificate has lapsed.
 */
const JOBS: readonly JobSeed[] = [
  // Done and signed off, last month.
  {
    customer: 0,
    site: 0,
    type: 'PPM',
    title: 'Quarterly chiller service',
    priority: 'normal',
    when: -28,
    engineer: 'engineer2',
    state: 'reviewed',
    parts: [
      ['HV-FLT-001', '4'],
      ['CN-CLN-005', '2'],
    ],
  },
  {
    customer: 1,
    site: 0,
    type: 'REPAIR',
    title: 'Theatre AHU not cooling',
    priority: 'urgent',
    when: -24,
    engineer: 'engineer2',
    state: 'reviewed',
    parts: [['HV-CAP-035', '1']],
    comment: 'Capacitor failed. Replaced and tested; theatre back to 19°C.',
  },
  {
    customer: 2,
    site: 0,
    type: 'REPAIR',
    title: 'Extraction fan noisy',
    priority: 'high',
    when: -21,
    engineer: 'engineer3',
    state: 'reviewed',
    parts: [['CN-SIL-300', '1']],
  },
  {
    customer: 4,
    site: 0,
    type: 'INSPECT',
    title: 'Annual gas safety inspection',
    priority: 'normal',
    when: -18,
    engineer: 'engineer1',
    state: 'reviewed',
  },
  {
    customer: 3,
    site: 0,
    type: 'PPM',
    title: 'Cold store compressor check',
    priority: 'normal',
    when: -15,
    engineer: 'engineer3',
    state: 'reviewed',
    parts: [['HV-FLT-001', '2']],
  },
  {
    customer: 6,
    site: 0,
    type: 'INSTALL',
    title: 'New LED panels, level 2',
    priority: 'normal',
    when: -12,
    engineer: 'engineer1',
    state: 'reviewed',
    parts: [
      ['EL-CBL-025', '20'],
      ['EL-MCB-032', '2'],
    ],
  },
  // Done, waiting for the office to review.
  {
    customer: 5,
    site: 0,
    type: 'REPAIR',
    title: 'Pool pump leaking',
    priority: 'high',
    when: -6,
    engineer: 'engineer2',
    state: 'complete',
    parts: [
      ['PL-VLV-022', '1'],
      ['CN-SIL-300', '1'],
    ],
  },
  {
    customer: 0,
    site: 1,
    type: 'CALLOUT',
    title: 'Lift lobby lights out',
    priority: 'urgent',
    when: -4,
    engineer: 'engineer3',
    state: 'complete',
    parts: [
      ['EL-MCB-032', '1'],
      ['CN-TAP-019', '1'],
    ],
    comment: 'Tripped breaker replaced. Customer asked for a quote to rewire the lobby.',
  },
  {
    customer: 1,
    site: 1,
    type: 'PPM',
    title: 'Water heater service',
    priority: 'low',
    when: -3,
    engineer: 'engineer1',
    state: 'complete',
  },
  // Today, in the field.
  {
    customer: 3,
    site: 1,
    type: 'REPAIR',
    title: 'Boiler pressure dropping',
    priority: 'high',
    when: 0,
    engineer: 'engineer3',
    state: 'in_progress',
    parts: [['PL-VLV-022', '1']],
  },
  {
    customer: 1,
    site: 0,
    type: 'PPM',
    title: 'Monthly theatre filter change',
    priority: 'normal',
    when: 0,
    engineer: 'engineer2',
    state: 'on_site',
    parts: [['HV-FLT-001', '6']],
  },
  {
    customer: 4,
    site: 0,
    type: 'REPAIR',
    title: 'Classroom AC dripping',
    priority: 'normal',
    when: 0,
    engineer: 'engineer1',
    state: 'travelling',
  },
  {
    customer: 2,
    site: 0,
    type: 'REPAIR',
    title: 'Oven fan motor failed',
    priority: 'urgent',
    when: -1,
    engineer: 'engineer2',
    state: 'awaiting_parts',
    comment: 'Needs a 250W fan motor; none on the van. Ordered from Cairo Cooling.',
  },
  // Booked.
  {
    customer: 0,
    site: 0,
    type: 'INSPECT',
    title: 'Gas safety inspection, Tower A',
    priority: 'normal',
    when: 1,
    engineer: 'engineer1',
    state: 'dispatched',
  },
  {
    customer: 6,
    site: 0,
    type: 'PPM',
    title: 'Server room CRAC service',
    priority: 'high',
    when: 1,
    engineer: 'engineer2',
    state: 'dispatched',
  },
  {
    customer: 5,
    site: 0,
    type: 'INSTALL',
    title: 'Two new split AC units, reception',
    priority: 'normal',
    when: 3,
    engineer: 'engineer1',
    state: 'scheduled',
  },
  {
    customer: 3,
    site: 0,
    type: 'PPM',
    title: 'Cold store door seals',
    priority: 'low',
    when: 4,
    engineer: 'engineer3',
    state: 'scheduled',
  },
  {
    customer: 4,
    site: 0,
    type: 'PPM',
    title: 'Term-break HVAC service',
    priority: 'normal',
    when: 6,
    engineer: 'engineer2',
    state: 'scheduled',
  },
  {
    customer: 1,
    site: 1,
    type: 'INSPECT',
    title: 'Clinic gas appliance check',
    priority: 'normal',
    when: 8,
    engineer: 'engineer1',
    state: 'scheduled',
  },
  {
    customer: 2,
    site: 0,
    type: 'PPM',
    title: 'Bakehouse extraction deep clean',
    priority: 'normal',
    when: 9,
    engineer: 'engineer3',
    state: 'scheduled',
  },
  {
    customer: 0,
    site: 1,
    type: 'REPAIR',
    title: 'Tower B corridor AC',
    priority: 'normal',
    when: 10,
    engineer: 'engineer2',
    state: 'scheduled',
  },
  {
    customer: 6,
    site: 0,
    type: 'INSTALL',
    title: 'Meeting room thermostat upgrade',
    priority: 'low',
    when: 12,
    engineer: 'engineer1',
    state: 'scheduled',
  },
  {
    customer: 5,
    site: 0,
    type: 'PPM',
    title: 'Resort kitchen extraction service',
    priority: 'normal',
    when: 13,
    engineer: 'engineer3',
    state: 'scheduled',
  },
  // Not yet given to anybody.
  {
    customer: 3,
    site: 1,
    type: 'REPAIR',
    title: 'Warehouse dock heater',
    priority: 'normal',
    when: 5,
    engineer: 'engineer3',
    state: 'scheduled',
  },
  // Called off.
  {
    customer: 4,
    site: 0,
    type: 'REPAIR',
    title: 'Staff room fridge (not ours)',
    priority: 'low',
    when: -9,
    engineer: 'engineer3',
    state: 'cancelled',
  },
  {
    customer: 6,
    site: 0,
    type: 'CALLOUT',
    title: 'Fire alarm sounding',
    priority: 'urgent',
    when: -2,
    engineer: 'engineer2',
    state: 'cancelled',
  },
];

/** The unassigned one: booked, but nobody on it yet. */
const UNASSIGNED = 'Warehouse dock heater';

/** The path from scheduled to each state, one step at a time. */
const PATH: Record<State, State[]> = {
  scheduled: [],
  dispatched: ['dispatched'],
  travelling: ['dispatched', 'travelling'],
  on_site: ['dispatched', 'travelling', 'on_site'],
  in_progress: ['dispatched', 'on_site', 'in_progress'],
  awaiting_parts: ['dispatched', 'on_site', 'in_progress', 'awaiting_parts'],
  complete: ['dispatched', 'on_site', 'in_progress', 'complete'],
  reviewed: ['dispatched', 'on_site', 'in_progress', 'complete', 'reviewed'],
  cancelled: ['cancelled'],
};

interface WorkOrderDetail {
  workOrder: { id: string; revision: number; state: State };
  checklist: { id: string; done: boolean }[];
}

interface DemoCustomer {
  id: string;
  sites: { id: string }[];
}

export async function seedFieldService(ctx: DemoContext): Promise<void> {
  const customers = ctx.refs.customers as DemoCustomer[];
  const jobTypes = ctx.refs.jobTypes as Record<string, string>;
  const locations = ctx.refs.locations as Record<string, string>;
  const vans: Record<Engineer, string | undefined> = {
    engineer1: locations.van1,
    engineer2: locations.van2,
    engineer3: locations.van3,
  };

  const detail = (id: string) =>
    ctx.call<WorkOrderDetail>('dispatcher', 'GET', `/v1/work-orders/${id}`);

  const workOrders: { id: string; state: State; customerId: string; siteId: string }[] = [];
  let failed = 0;
  // The service report, filled in on the first jobs that reach the work.
  const reportId = (ctx.refs.forms as Record<string, string> | undefined)?.serviceReport;
  const reports = [...REPORT_ANSWERS];
  const submissions: { id: string; status: string }[] = [];

  for (const seed of JOBS) {
    const customer = customers[seed.customer];
    const site = customer?.sites[seed.site];
    const jobTypeId = jobTypes[seed.type];
    if (customer === undefined || site === undefined || jobTypeId === undefined) {
      continue;
    }
    const engineer = ctx.people[seed.engineer];
    const unassigned = seed.title === UNASSIGNED;

    try {
      const created = await ctx.call<WorkOrderDetail>('dispatcher', 'POST', '/v1/work-orders', {
        customerId: customer.id,
        siteId: site.id,
        jobTypeId,
        title: seed.title,
        priority: seed.priority,
        dueFrom: at(seed.when, 8),
        dueBy: at(seed.when, 17),
        ...(unassigned ? {} : { crew: [{ userId: engineer.userId, lead: true }] }),
        description: `${seed.title}. Raised by the office from the customer's request.`,
      });
      const id = created.workOrder.id;

      // A visit on the schedule, for everybody with an engineer.
      let visitId: string | undefined;
      if (!unassigned && seed.state !== 'cancelled') {
        const visit = await ctx.attempt<{ visit: { id: string } }>(
          'dispatcher',
          'POST',
          `/v1/work-orders/${id}/visits`,
          {
            startsAt: at(seed.when, 9),
            endsAt: at(seed.when, 12),
            assigneeIds: [engineer.userId],
            notes: 'Call the site contact 30 minutes before arriving.',
          },
        );
        visitId = visit?.visit.id;
      }

      // Walk it to its state, as whoever would really move it.
      for (const step of PATH[seed.state]) {
        const current = await detail(id);
        const actor =
          step === 'dispatched' || step === 'cancelled'
            ? 'dispatcher'
            : step === 'reviewed'
              ? 'admin'
              : seed.engineer;

        if (step === 'complete') {
          // The checklist ticked, parts recorded, sign-off noted.
          for (const item of current.checklist) {
            await ctx.attempt(
              seed.engineer,
              'PATCH',
              `/v1/work-orders/${id}/checklist/${item.id}`,
              { done: true },
            );
          }
          await ctx.attempt(seed.engineer, 'PUT', `/v1/work-orders/${id}/signoff`, {
            unavailableReason: 'Site contact was not available; photos left with security.',
          });
        }

        const reason =
          step === 'cancelled'
            ? seed.title.includes('not ours')
              ? 'Customer equipment under its own maker warranty'
              : 'False alarm: panel reset by the building manager'
            : undefined;
        const moved = await ctx.attempt<unknown>(
          actor,
          'POST',
          `/v1/work-orders/${id}/transitions`,
          {
            to: step,
            expectedRevision: (await detail(id)).workOrder.revision,
            ...(reason === undefined ? {} : { reason }),
          },
        );
        if (moved === undefined) {
          break;
        }

        // The service report, filled in while on the job.
        if (
          step === 'in_progress' &&
          reportId !== undefined &&
          seed.type !== 'INSTALL' &&
          seed.type !== 'INSPECT'
        ) {
          const answers = reports.shift();
          if (answers !== undefined) {
            await ctx.attempt('dispatcher', 'POST', `/v1/work-orders/${id}/forms`, {
              formId: reportId,
              required: false,
            });
            const started = await ctx.attempt<{ submission: { id: string; revision: number } }>(
              seed.engineer,
              'POST',
              '/v1/submissions',
              { formId: reportId, workOrderId: id },
            );
            if (started !== undefined) {
              const sent = await ctx.attempt<unknown>(
                seed.engineer,
                'POST',
                `/v1/submissions/${started.submission.id}/submit`,
                {
                  answers,
                  expectedRevision: started.submission.revision,
                },
              );
              submissions.push({
                id: started.submission.id,
                status: sent === undefined ? 'draft' : 'submitted',
              });
            }
          }
        }

        // Parts go on once the engineer is working.
        if (step === 'in_progress' && seed.parts !== undefined) {
          for (const [sku, quantity] of seed.parts) {
            await ctx.attempt(seed.engineer, 'POST', `/v1/work-orders/${id}/materials`, {
              itemId: itemBySku(ctx, sku).id,
              ...(vans[seed.engineer] === undefined ? {} : { locationId: vans[seed.engineer] }),
              quantity,
            });
          }
        }
      }

      if (visitId !== undefined && (seed.state === 'complete' || seed.state === 'reviewed')) {
        await ctx.attempt(seed.engineer, 'POST', `/v1/visits/${visitId}/done`, {
          completedAt: at(seed.when, 12),
        });
      }

      if (seed.comment !== undefined) {
        await ctx.attempt(
          unassigned ? 'dispatcher' : seed.engineer,
          'POST',
          `/v1/work-orders/${id}/comments`,
          {
            body: seed.comment,
            visibility: 'internal',
          },
        );
      }

      const final = await detail(id);
      workOrders.push({
        id,
        state: final.workOrder.state,
        customerId: customer.id,
        siteId: site.id,
      });
    } catch (error) {
      failed += 1;
      ctx.warn(
        `work order "${seed.title}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  ctx.refs.workOrders = workOrders;
  ctx.refs.submissions = submissions;

  // A customer-facing note, a part bought at a merchant, and jobs tied to assets.
  const first = workOrders[0];
  if (first !== undefined) {
    await ctx.attempt('dispatcher', 'POST', `/v1/work-orders/${first.id}/comments`, {
      body: 'Service completed. Next visit due in three months.',
      visibility: 'customer',
    });
  }
  const awaiting = workOrders.find((wo) => wo.state === 'awaiting_parts');
  if (awaiting !== undefined) {
    await ctx.attempt('engineer2', 'POST', `/v1/work-orders/${awaiting.id}/purchases`, {
      id: crypto.randomUUID(),
      description: 'Fan motor mounting bolts (M8, pack of 10)',
      merchant: 'El Sabtiya hardware market',
      quantity: '1',
      unitPrice: '85.00',
      occurredAt: at(-1, 13),
    });
  }
  const assets = (ctx.refs.assets as { id: string; siteId: string }[] | undefined) ?? [];
  let linked = 0;
  for (const wo of workOrders) {
    const asset = assets.find((candidate) => candidate.siteId === wo.siteId);
    if (asset !== undefined && linked < 8) {
      // Answers 204, so success is "no new warning" rather than a body.
      const before = ctx.warnings.length;
      await ctx.attempt('dispatcher', 'POST', `/v1/work-orders/${wo.id}/assets`, {
        assetId: asset.id,
      });
      if (ctx.warnings.length === before) {
        linked += 1;
      }
    }
  }

  // Saved views on the work orders list.
  await ctx.attempt('dispatcher', 'POST', '/v1/saved-views', {
    name: 'Urgent and open',
    filters: {
      priority: ['urgent', 'high'],
      state: ['scheduled', 'dispatched', 'travelling', 'on_site', 'in_progress', 'awaiting_parts'],
    },
    shared: true,
  });
  await ctx.attempt('dispatcher', 'POST', '/v1/saved-views', {
    name: 'Waiting for review',
    filters: { state: ['complete'] },
    shared: true,
  });

  const byState = new Map<string, number>();
  for (const wo of workOrders) {
    byState.set(wo.state, (byState.get(wo.state) ?? 0) + 1);
  }
  ctx.log(
    `${String(workOrders.length)} work orders (${[...byState].map(([state, count]) => `${String(count)} ${state}`).join(', ')}), ${String(linked)} linked to assets${failed > 0 ? `, ${String(failed)} failed` : ''}`,
  );
}
