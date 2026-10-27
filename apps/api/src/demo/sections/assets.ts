import { withTenant } from '@integr8/db';
import { makeJobs } from '../../maintenance/tasks.js';
import { day, type DemoContext } from '../context.js';
import { itemBySku } from './inventory.js';

/**
 * Assets at customer sites, service contracts, maintenance plans and the
 * company's deadline rules.
 *
 * Adds to refs:
 *   assets     { id, name, customerId, siteId }[]
 *   contracts  { id, reference, customerId, standing }[]
 */

interface DemoCustomer {
  id: string;
  name: string;
  sites: { id: string; name: string }[];
}

interface AssetBody {
  asset: { id: string; version: number; name: string };
}

interface ContractBody {
  id: string;
  reference: string;
  version: number;
  standing: string;
}

interface AssetSeed {
  customer: number;
  site: number;
  name: string;
  make: string;
  model: string;
  serial: string;
  sku?: string;
  location: string;
  installedDaysAgo: number;
  /** Days from today; negative is expired. */
  warrantyDays: number;
  condition: 'good' | 'fair' | 'poor' | 'unusable';
}

const ASSETS: readonly AssetSeed[] = [
  {
    customer: 0,
    site: 0,
    name: 'Rooftop chiller CH-1',
    make: 'Carrier',
    model: '30RB-162',
    serial: 'CR30RB-77812',
    location: 'Roof, north side',
    installedDaysAgo: 1400,
    warrantyDays: -300,
    condition: 'fair',
  },
  {
    customer: 0,
    site: 1,
    name: 'Lobby split AC',
    make: 'Sharp',
    model: 'AY-X24',
    serial: 'SHX24-55120',
    sku: 'EQ-SPL-240',
    location: 'Ground floor lobby',
    installedDaysAgo: 300,
    warrantyDays: 430,
    condition: 'good',
  },
  {
    customer: 1,
    site: 0,
    name: 'Theatre AHU 1',
    make: 'Trane',
    model: 'CLCP-14',
    serial: 'TR-CL14-0091',
    location: 'Plant room B',
    installedDaysAgo: 900,
    warrantyDays: 20,
    condition: 'good',
  },
  {
    customer: 1,
    site: 0,
    name: 'Fire alarm panel',
    make: 'Honeywell',
    model: 'Notifier NFS2',
    serial: 'HN-NFS2-3301',
    location: 'Security office',
    installedDaysAgo: 1200,
    warrantyDays: -100,
    condition: 'good',
  },
  {
    customer: 1,
    site: 1,
    name: 'Clinic water heater',
    make: 'Ariston',
    model: 'Pro1 80L',
    serial: 'AR-P80-6610',
    sku: 'EQ-WHT-080',
    location: 'Staff kitchen',
    installedDaysAgo: 200,
    warrantyDays: 530,
    condition: 'good',
  },
  {
    customer: 2,
    site: 0,
    name: 'Oven extraction fan',
    make: 'Systemair',
    model: 'KBT 280',
    serial: 'SY-KBT-1180',
    location: 'Bakehouse ceiling',
    installedDaysAgo: 700,
    warrantyDays: -20,
    condition: 'poor',
  },
  {
    customer: 3,
    site: 0,
    name: 'Cold store compressor',
    make: 'Bitzer',
    model: '4FES-5Y',
    serial: 'BZ-4FES-2040',
    location: 'Cold store 1 plant deck',
    installedDaysAgo: 1000,
    warrantyDays: 60,
    condition: 'fair',
  },
  {
    customer: 3,
    site: 1,
    name: 'Warehouse gas boiler',
    make: 'Baxi',
    model: 'Power HT 85',
    serial: 'BX-PHT-8571',
    location: 'Boiler house',
    installedDaysAgo: 1600,
    warrantyDays: -700,
    condition: 'good',
  },
  {
    customer: 4,
    site: 0,
    name: 'Classroom split AC (Block C)',
    make: 'LG',
    model: 'S12EQ',
    serial: 'LG-S12-90021',
    sku: 'EQ-SPL-120',
    location: 'Block C, room 12',
    installedDaysAgo: 150,
    warrantyDays: 580,
    condition: 'good',
  },
  {
    customer: 5,
    site: 0,
    name: 'Pool circulation pump',
    make: 'Grundfos',
    model: 'CR 15-3',
    serial: 'GF-CR15-4410',
    sku: 'PL-PMP-001',
    location: 'Pool plant room',
    installedDaysAgo: 500,
    warrantyDays: 230,
    condition: 'good',
  },
  {
    customer: 6,
    site: 0,
    name: 'Server room CRAC unit',
    make: 'Vertiv',
    model: 'Liebert PEX',
    serial: 'VT-PEX-1203',
    location: 'Level 2 server room',
    installedDaysAgo: 800,
    warrantyDays: 5,
    condition: 'good',
  },
];

export async function seedAssetsAndContracts(ctx: DemoContext): Promise<void> {
  const customers = ctx.refs.customers as DemoCustomer[];
  const jobTypes = ctx.refs.jobTypes as Record<string, string>;

  // Warranties flagged a month ahead.
  const settings = await ctx.call<{ version: number }>('owner', 'GET', '/v1/assets/settings');
  await ctx.attempt('owner', 'PUT', '/v1/assets/settings', {
    expectedVersion: settings.version,
    warrantyAlertDays: 30,
  });

  // --- Assets ---------------------------------------------------------------
  const assets: {
    id: string;
    name: string;
    customerId: string;
    siteId: string;
    version: number;
  }[] = [];
  for (const seed of ASSETS) {
    const customer = customers[seed.customer]!;
    const site = customer.sites[seed.site]!;
    const created = await ctx.call<AssetBody>('dispatcher', 'POST', '/v1/assets', {
      name: seed.name,
      make: seed.make,
      model: seed.model,
      serialNumber: seed.serial,
      ...(seed.sku === undefined ? {} : { itemId: itemBySku(ctx, seed.sku).id }),
      locationNote: seed.location,
      installDate: day(-seed.installedDaysAgo),
      warrantyExpiresOn: day(seed.warrantyDays),
      siteId: site.id,
      condition: seed.condition,
    });
    assets.push({
      id: created.asset.id,
      name: seed.name,
      customerId: customer.id,
      siteId: site.id,
      version: created.asset.version,
    });
  }

  // A little history: the lobby AC moved to Tower A, the bakery fan out of
  // service after a poor inspection, a replacement tag for the fire panel.
  const lobby = assets[1]!;
  const towerA = customers[0]!.sites[0]!;
  const moved = await ctx.attempt<AssetBody>(
    'dispatcher',
    'POST',
    `/v1/assets/${lobby.id}/relocate`,
    {
      expectedVersion: lobby.version,
      siteId: towerA.id,
      locationNote: 'Tower A reception',
      note: 'Moved during the Tower B lobby refit',
    },
  );
  if (moved !== undefined) {
    lobby.siteId = towerA.id;
    lobby.version = moved.asset.version;
  }

  const fan = assets[5]!;
  // The office records it: an engineer only sees assets on jobs they are working.
  const worn = await ctx.attempt<AssetBody>(
    'dispatcher',
    'POST',
    `/v1/assets/${fan.id}/condition`,
    {
      condition: 'unusable',
      note: 'Bearing seized; motor overheating. Replacement quoted.',
    },
  );
  if (worn !== undefined) {
    fan.version = worn.asset.version;
  }
  const stopped = await ctx.attempt<AssetBody>(
    'dispatcher',
    'POST',
    `/v1/assets/${fan.id}/status`,
    {
      expectedVersion: fan.version,
      status: 'out_of_service',
      note: 'Isolated until the new motor arrives',
    },
  );
  if (stopped !== undefined) {
    fan.version = stopped.asset.version;
  }

  const panel = assets[3]!;
  const tagged = await ctx.attempt<AssetBody>('dispatcher', 'POST', `/v1/assets/${panel.id}/tag`, {
    expectedVersion: panel.version,
  });
  if (tagged !== undefined) {
    panel.version = tagged.asset.version;
  }

  ctx.refs.assets = assets.map(({ id, name, customerId, siteId }) => ({
    id,
    name,
    customerId,
    siteId,
  }));
  ctx.log(`${String(assets.length)} assets (one moved, one out of service, one re-tagged)`);

  // --- Contracts ------------------------------------------------------------
  const contracts: { id: string; reference: string; customerId: string; standing: string }[] = [];
  const contract = async (body: Record<string, unknown>) => {
    const created = await ctx.call<ContractBody>('admin', 'POST', '/v1/contracts', body);
    contracts.push({
      id: created.id,
      reference: created.reference,
      customerId: body.customerId as string,
      standing: created.standing,
    });
    return created;
  };

  const zamalek = customers[0]!;
  const helio = customers[1]!;
  const alex = customers[3]!;
  const resorts = customers[5]!;
  const village = customers[6]!;

  await contract({
    customerId: zamalek.id,
    title: 'Comprehensive HVAC maintenance — both towers',
    startsOn: day(-200),
    endsOn: day(165),
    value: '240000.00',
    renewalNoticeDays: 60,
    siteIds: zamalek.sites.map((site) => site.id),
    assetIds: [assets[0]!.id, assets[1]!.id],
    jobTypeIds: [jobTypes.PPM, jobTypes.REPAIR, jobTypes.CALLOUT].filter(Boolean),
    includedCallouts: 12,
    notes: 'Quarterly PPM, unlimited repairs, 12 emergency call-outs a year.',
  });
  await contract({
    customerId: helio.id,
    title: 'Critical systems support — hospital',
    startsOn: day(-340),
    endsOn: day(25),
    value: '480000.00',
    renewalNoticeDays: 60,
    siteIds: [helio.sites[0]!.id],
    assetIds: [assets[2]!.id, assets[3]!.id],
    jobTypeIds: [jobTypes.PPM, jobTypes.REPAIR, jobTypes.INSPECT, jobTypes.CALLOUT].filter(Boolean),
    includedCallouts: 24,
    notes: 'Ending soon: renewal under discussion with Dr. Selim.',
  });
  const cold = await contract({
    customerId: alex.id,
    title: 'Cold store refrigeration — first year',
    startsOn: day(-400),
    endsOn: day(-35),
    value: '150000.00',
    siteIds: [alex.sites[0]!.id],
    assetIds: [assets[6]!.id],
    jobTypeIds: [jobTypes.PPM, jobTypes.REPAIR].filter(Boolean),
    includedCallouts: 6,
  });
  const renewed = await ctx.attempt<ContractBody>(
    'admin',
    'POST',
    `/v1/contracts/${cold.id}/renew`,
    {
      expectedVersion: cold.version,
      startsOn: day(-34),
      endsOn: day(330),
      value: '165000.00',
      title: 'Cold store refrigeration — second year',
    },
  );
  if (renewed !== undefined) {
    contracts.push({
      id: renewed.id,
      reference: renewed.reference,
      customerId: alex.id,
      standing: renewed.standing,
    });
  }
  const pool = await contract({
    customerId: resorts.id,
    title: 'Resort pool and plant maintenance',
    startsOn: day(-90),
    endsOn: day(275),
    value: '90000.00',
    siteIds: [resorts.sites[0]!.id],
    assetIds: [assets[9]!.id],
    jobTypeIds: [jobTypes.PPM].filter(Boolean),
  });
  const cancelled = await ctx.attempt<ContractBody>(
    'admin',
    'POST',
    `/v1/contracts/${pool.id}/cancel`,
    {
      expectedVersion: pool.version,
      cancelledOn: day(-5),
      reason: 'Resort moved plant maintenance in-house.',
    },
  );
  if (cancelled !== undefined) {
    contracts[contracts.length - 1]!.standing = cancelled.standing;
  }
  await contract({
    customerId: village.id,
    title: 'Server room cooling — 24/7 response',
    startsOn: day(14),
    endsOn: day(379),
    value: '120000.00',
    siteIds: [village.sites[0]!.id],
    assetIds: [assets[10]!.id],
    jobTypeIds: [jobTypes.REPAIR, jobTypes.CALLOUT].filter(Boolean),
    includedCallouts: 10,
    notes: 'Starts in two weeks.',
  });
  ctx.refs.contracts = contracts;
  ctx.log(`${String(contracts.length)} contracts (active, ending, renewed, cancelled, upcoming)`);

  // --- Maintenance plans ------------------------------------------------------
  const zamalekContract = contracts[0]!.id;
  const helioContract = contracts[1]!.id;
  const coldContract = contracts.find((entry) => entry.reference === renewed?.reference)?.id;
  const plans: Record<string, unknown>[] = [
    {
      assetId: assets[0]!.id,
      contractId: zamalekContract,
      title: 'Quarterly chiller service',
      intervalCount: 3,
      intervalUnit: 'month',
      counting: 'calendar',
      startsOn: day(6),
      leadDays: 14,
      windowBeforeDays: 7,
      windowAfterDays: 7,
      instructions: 'Check refrigerant pressures, clean condenser coils, log readings.',
    },
    {
      assetId: assets[1]!.id,
      contractId: zamalekContract,
      title: 'Monthly filter change',
      intervalCount: 1,
      intervalUnit: 'month',
      counting: 'calendar',
      startsOn: day(3),
      leadDays: 7,
    },
    {
      assetId: assets[2]!.id,
      contractId: helioContract,
      title: 'Theatre AHU monthly PPM',
      intervalCount: 1,
      intervalUnit: 'month',
      counting: 'calendar',
      startsOn: day(10),
      leadDays: 14,
      instructions: 'Theatre must be empty. Book with the theatre manager.',
    },
    {
      assetId: assets[3]!.id,
      contractId: helioContract,
      title: 'Fire panel six-monthly test',
      intervalCount: 6,
      intervalUnit: 'month',
      counting: 'calendar',
      startsOn: day(40),
      leadDays: 14,
      jobType: 'INSPECT',
    },
    {
      assetId: assets[6]!.id,
      ...(coldContract === undefined ? {} : { contractId: coldContract }),
      title: 'Compressor service',
      intervalCount: 2,
      intervalUnit: 'month',
      counting: 'completion',
      startsOn: day(12),
      leadDays: 21,
    },
    {
      assetId: assets[7]!.id,
      title: 'Annual boiler service',
      intervalCount: 1,
      intervalUnit: 'year',
      counting: 'calendar',
      startsOn: day(45),
      leadDays: 30,
      jobType: 'INSPECT',
    },
    {
      assetId: assets[8]!.id,
      title: 'Termly AC clean',
      intervalCount: 4,
      intervalUnit: 'month',
      counting: 'calendar',
      startsOn: day(20),
      leadDays: 14,
    },
    {
      assetId: assets[10]!.id,
      title: 'CRAC unit quarterly check',
      intervalCount: 3,
      intervalUnit: 'month',
      counting: 'calendar',
      startsOn: day(30),
      leadDays: 14,
    },
  ];
  let planCount = 0;
  for (const { jobType, ...plan } of plans) {
    const jobTypeId = jobTypes[(jobType as string | undefined) ?? 'PPM'];
    if (jobTypeId === undefined) {
      continue;
    }
    const made = await ctx.attempt<unknown>('dispatcher', 'POST', '/v1/maintenance-plans', {
      ...plan,
      jobTypeId,
    });
    if (made !== undefined) {
      planCount += 1;
    }
  }
  // The nightly task raises each plan's job once it is within its lead time.
  // Run it now, so the first jobs are on the board straight away.
  const raised = await withTenant(ctx.tenantId, (tx) => makeJobs(tx, new Date()));
  ctx.log(
    `${String(planCount)} maintenance plans, ${String(raised.jobsCreated)} planned jobs raised`,
  );

  // --- Deadline rules -----------------------------------------------------------
  await ctx.call('owner', 'PUT', '/v1/deadline-rules', {
    rules: [
      {
        priority: 'urgent',
        responseMinutes: 120,
        completionMinutes: 480,
        clock: 'always',
        warnMinutes: 30,
      },
      {
        priority: 'high',
        responseMinutes: 240,
        completionMinutes: 1440,
        clock: 'working_hours',
        warnMinutes: 60,
      },
      {
        priority: 'normal',
        responseMinutes: 1440,
        completionMinutes: 4320,
        clock: 'working_hours',
        warnMinutes: 240,
      },
      {
        priority: 'low',
        responseMinutes: 2880,
        completionMinutes: 10080,
        clock: 'working_hours',
        warnMinutes: 480,
      },
    ],
  });
  ctx.log('deadline rules for every priority');
}
