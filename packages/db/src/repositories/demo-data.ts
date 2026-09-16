import type { Kysely } from 'kysely';
import type { Database } from '../schema.js';

/**
 * Sample data, labelled so it can be taken away again (P18).
 *
 * A new company with nothing in it is a company where nobody can tell what any
 * screen is for. So onboarding offers to put a few customers, sites and jobs
 * in — and the whole point is that **removing them is one action that cannot
 * touch anything real.**
 *
 * That is why `is_demo` is a column on the rows rather than a list of ids kept
 * somewhere: a list goes stale the moment somebody edits a demo customer into a
 * real one, and then removal deletes their work. Marked on the row, the label
 * travels with it, and any route that meaningfully edits a row can clear the
 * flag — at which point removal leaves it alone, which is the correct
 * behaviour rather than a special case.
 *
 * Nothing here creates media, submissions or anything with a foreign key into
 * another company's world. The sample is deliberately shallow: enough to make
 * the lists non-empty and the screens legible, not a simulation.
 */

export interface DemoCounts {
  customers: number;
  sites: number;
  workOrders: number;
}

interface DemoSeed {
  customer: { name: string; email: string; phone: string; city: string; postcode: string };
  site: { name: string; line1: string };
  job: { title: string; priority: 'low' | 'normal' | 'high' };
}

/**
 * Three customers, one site each, one job each.
 *
 * Plausibly British field-service work, because that is what this product is
 * for and generic placeholders ("Customer 1", "Site A") teach nobody anything
 * about what the screen does.
 */
const SEEDS: readonly DemoSeed[] = [
  {
    customer: {
      name: 'Hollis Property Management',
      email: 'maintenance@hollis.example',
      phone: '020 7946 0101',
      city: 'London',
      postcode: 'SE1 7PB',
    },
    site: { name: 'Bermondsey Court', line1: '14 Tanner Street' },
    job: { title: 'Annual boiler service', priority: 'normal' },
  },
  {
    customer: {
      name: 'Aldridge & Sons Bakery',
      email: 'ops@aldridgebakery.example',
      phone: '0161 496 0202',
      city: 'Manchester',
      postcode: 'M4 1HN',
    },
    site: { name: 'Ancoats Bakehouse', line1: '8 Blossom Street' },
    job: { title: 'Extraction fan repair', priority: 'high' },
  },
  {
    customer: {
      name: 'Greenfield Primary School',
      email: 'site@greenfieldprimary.example',
      phone: '0113 496 0303',
      city: 'Leeds',
      postcode: 'LS6 2AB',
    },
    site: { name: 'Main building', line1: '2 Grove Lane' },
    job: { title: 'Gas safety inspection', priority: 'normal' },
  },
];

export class DemoDataRepository {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly tenantId: string,
  ) {}

  async counts(): Promise<DemoCounts> {
    const count = async (table: 'customers' | 'sites' | 'work_orders') => {
      const row = await this.db
        .selectFrom(table)
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('tenant_id', '=', this.tenantId)
        .where('is_demo', '=', true)
        .executeTakeFirstOrThrow();
      return Number(row.count);
    };

    return {
      customers: await count('customers'),
      sites: await count('sites'),
      workOrders: await count('work_orders'),
    };
  }

  /**
   * Puts the sample in, once.
   *
   * Loading twice would double it, so a company that already has sample data
   * gets nothing and is told so. Loading after somebody has removed it is
   * allowed: they asked for it back.
   */
  async load(createdBy: string, jobTypeId: string | null): Promise<DemoCounts> {
    const existing = await this.counts();
    if (existing.customers > 0) {
      return existing;
    }

    for (const seed of SEEDS) {
      const customer = await this.db
        .insertInto('customers')
        .values({
          tenant_id: this.tenantId,
          created_by: createdBy,
          name: seed.customer.name,
          email: seed.customer.email,
          phone: seed.customer.phone,
          city: seed.customer.city,
          postcode: seed.customer.postcode,
          is_demo: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const site = await this.db
        .insertInto('sites')
        .values({
          tenant_id: this.tenantId,
          customer_id: customer.id,
          created_by: createdBy,
          name: seed.site.name,
          address_line1: seed.site.line1,
          city: seed.customer.city,
          postcode: seed.customer.postcode,
          is_demo: true,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      // A job needs a type, and a brand-new company has the seeded ones. If it
      // somehow has none, the customers and sites still go in: a partial
      // sample is more useful than none, and far better than a failure.
      if (jobTypeId !== null) {
        await this.db
          .insertInto('work_orders')
          .values({
            tenant_id: this.tenantId,
            customer_id: customer.id,
            site_id: site.id,
            job_type_id: jobTypeId,
            created_by: createdBy,
            last_actor: createdBy,
            title: seed.job.title,
            priority: seed.job.priority,
            is_demo: true,
          })
          .executeTakeFirstOrThrow();
      }
    }

    return this.counts();
  }

  /**
   * Takes the sample away.
   *
   * Jobs first, then sites, then customers: the foreign keys are
   * `on delete restrict`, so removing a customer whose site still exists would
   * be refused. Anything somebody has edited into real data has had its flag
   * cleared and is not touched.
   */
  async remove(): Promise<DemoCounts> {
    const before = await this.counts();

    await this.db
      .deleteFrom('work_orders')
      .where('tenant_id', '=', this.tenantId)
      .where('is_demo', '=', true)
      .execute();

    await this.db
      .deleteFrom('sites')
      .where('tenant_id', '=', this.tenantId)
      .where('is_demo', '=', true)
      .execute();

    await this.db
      .deleteFrom('customers')
      .where('tenant_id', '=', this.tenantId)
      .where('is_demo', '=', true)
      .execute();

    return before;
  }

  /**
   * Stops a row being treated as sample data.
   *
   * Called when somebody edits one into something real. After this, removing
   * the sample leaves it alone — which is the whole reason the label lives on
   * the row.
   */
  async claim(table: 'customers' | 'sites' | 'work_orders', id: string): Promise<void> {
    await this.db
      .updateTable(table)
      .set({ is_demo: false })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', id)
      .where('is_demo', '=', true)
      .execute();
  }
}
