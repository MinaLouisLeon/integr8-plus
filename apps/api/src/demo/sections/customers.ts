import type { DemoContext } from '../context.js';

/**
 * Customers, their contacts and their sites.
 *
 * Adds to refs:
 *   customers  { id, name, email, contacts: string[], sites: { id, name }[] }[]
 */

interface SiteSeed {
  name: string;
  line1: string;
  city: string;
  region: string;
  postcode: string;
  latitude: number;
  longitude: number;
  access?: { gateCode?: string; parking?: string; askFor?: string; hazards?: string };
}

interface CustomerSeed {
  name: string;
  accountNumber: string;
  email: string;
  phone: string;
  status?: 'active' | 'on_hold';
  tags: string[];
  notes?: string;
  contacts: { name: string; jobTitle: string; email: string; phone: string }[];
  sites: SiteSeed[];
}

const CUSTOMERS: readonly CustomerSeed[] = [
  {
    name: 'Zamalek Towers Management',
    accountNumber: 'C-1001',
    email: 'facilities@zamalektowers.example.com',
    phone: '+20 2 2735 0101',
    tags: ['residential', 'contract'],
    notes: 'Two residential towers. Access via the security office.',
    contacts: [
      {
        name: 'Hany Shawky',
        jobTitle: 'Facilities manager',
        email: 'hany@zamalektowers.example.com',
        phone: '+20 100 111 0101',
      },
      {
        name: 'Dina Farouk',
        jobTitle: 'Accounts',
        email: 'accounts@zamalektowers.example.com',
        phone: '+20 100 111 0102',
      },
    ],
    sites: [
      {
        name: 'Tower A',
        line1: '12 Abu El Feda Street',
        city: 'Cairo',
        region: 'Zamalek',
        postcode: '11211',
        latitude: 30.0626,
        longitude: 31.2247,
        access: {
          gateCode: '4471',
          parking: 'Basement level -1, bays 10–12',
          askFor: 'Security desk',
        },
      },
      {
        name: 'Tower B',
        line1: '14 Abu El Feda Street',
        city: 'Cairo',
        region: 'Zamalek',
        postcode: '11211',
        latitude: 30.0631,
        longitude: 31.2251,
      },
    ],
  },
  {
    name: 'Heliopolis Medical Centre',
    accountNumber: 'C-1002',
    email: 'engineering@heliomed.example.com',
    phone: '+20 2 2418 0202',
    tags: ['healthcare', 'priority'],
    notes: 'Theatres must stay cool. Any HVAC fault is urgent.',
    contacts: [
      {
        name: 'Dr. Rania Selim',
        jobTitle: 'Operations director',
        email: 'rania@heliomed.example.com',
        phone: '+20 101 222 0201',
      },
      {
        name: 'Mostafa Kamal',
        jobTitle: 'Chief engineer',
        email: 'mostafa@heliomed.example.com',
        phone: '+20 101 222 0202',
      },
    ],
    sites: [
      {
        name: 'Main hospital',
        line1: '5 El Merghany Street',
        city: 'Cairo',
        region: 'Heliopolis',
        postcode: '11341',
        latitude: 30.0911,
        longitude: 31.3225,
        access: {
          hazards: 'Medical gases in plant room B',
          askFor: 'Engineering office, ground floor',
        },
      },
      {
        name: 'Outpatients clinic',
        line1: '21 Baghdad Street',
        city: 'Cairo',
        region: 'Heliopolis',
        postcode: '11341',
        latitude: 30.0889,
        longitude: 31.3301,
      },
    ],
  },
  {
    name: 'Nile Bakeries Co.',
    accountNumber: 'C-1003',
    email: 'ops@nilebakeries.example.com',
    phone: '+20 2 3761 0303',
    tags: ['food', 'industrial'],
    contacts: [
      {
        name: 'Sherif Lotfy',
        jobTitle: 'Plant manager',
        email: 'sherif@nilebakeries.example.com',
        phone: '+20 102 333 0301',
      },
    ],
    sites: [
      {
        name: 'Giza bakehouse',
        line1: '88 Faisal Street',
        city: 'Giza',
        region: 'Giza',
        postcode: '12511',
        latitude: 30.0131,
        longitude: 31.1656,
        access: { hazards: 'Hot ovens; hairnets required', parking: 'Loading yard' },
      },
    ],
  },
  {
    name: 'Alexandria Port Logistics',
    accountNumber: 'C-1004',
    email: 'maintenance@alexportlog.example.com',
    phone: '+20 3 480 0404',
    tags: ['logistics', 'industrial'],
    contacts: [
      {
        name: 'Tamer Ezzat',
        jobTitle: 'Warehouse manager',
        email: 'tamer@alexportlog.example.com',
        phone: '+20 103 444 0401',
      },
    ],
    sites: [
      {
        name: 'Cold store 1',
        line1: 'Gate 27, El Max Road',
        city: 'Alexandria',
        region: 'El Max',
        postcode: '21511',
        latitude: 31.1467,
        longitude: 29.8499,
        access: { gateCode: 'Port pass needed', askFor: 'Gate 27 control room' },
      },
      {
        name: 'Distribution warehouse',
        line1: '3 Industrial Zone Road',
        city: 'Alexandria',
        region: 'Borg El Arab',
        postcode: '21934',
        latitude: 30.9167,
        longitude: 29.6833,
      },
    ],
  },
  {
    name: 'Maadi International School',
    accountNumber: 'C-1005',
    email: 'estates@maadischool.example.com',
    phone: '+20 2 2359 0505',
    tags: ['education'],
    notes: 'Work during term time only after 15:00.',
    contacts: [
      {
        name: 'Ms. Heba Aziz',
        jobTitle: 'Estates manager',
        email: 'heba@maadischool.example.com',
        phone: '+20 104 555 0501',
      },
    ],
    sites: [
      {
        name: 'Main campus',
        line1: '9 Road 233, Degla',
        city: 'Cairo',
        region: 'Maadi',
        postcode: '11431',
        latitude: 29.9602,
        longitude: 31.2569,
        access: { askFor: 'Reception', parking: 'Staff car park' },
      },
    ],
  },
  {
    name: 'Red Sea Resorts Group',
    accountNumber: 'C-1006',
    email: 'technical@redsearesorts.example.com',
    phone: '+20 65 344 0606',
    tags: ['hospitality', 'contract'],
    contacts: [
      {
        name: 'Wael Gaber',
        jobTitle: 'Technical manager',
        email: 'wael@redsearesorts.example.com',
        phone: '+20 105 666 0601',
      },
      {
        name: 'Nada Hamdy',
        jobTitle: 'Purchasing',
        email: 'purchasing@redsearesorts.example.com',
        phone: '+20 105 666 0602',
      },
    ],
    sites: [
      {
        name: 'Hurghada Bay Resort',
        line1: 'Km 7, Safaga Road',
        city: 'Hurghada',
        region: 'Red Sea',
        postcode: '84511',
        latitude: 27.1783,
        longitude: 33.8116,
      },
    ],
  },
  {
    name: 'Smart Village Offices',
    accountNumber: 'C-1007',
    email: 'fm@smartvillageoffices.example.com',
    phone: '+20 2 3537 0707',
    tags: ['commercial'],
    contacts: [
      {
        name: 'Ayman Rizk',
        jobTitle: 'Building manager',
        email: 'ayman@smartvillageoffices.example.com',
        phone: '+20 106 777 0701',
      },
    ],
    sites: [
      {
        name: 'Building B12',
        line1: 'B12, Smart Village',
        city: 'Giza',
        region: '6th of October',
        postcode: '12577',
        latitude: 30.0717,
        longitude: 31.0186,
      },
    ],
  },
  {
    name: 'El Tahrir Pharmacy Chain',
    accountNumber: 'C-1008',
    email: 'branches@tahrirpharma.example.com',
    phone: '+20 2 2575 0808',
    status: 'on_hold',
    tags: ['retail'],
    notes: 'On hold: two invoices overdue. Check with accounts before booking work.',
    contacts: [
      {
        name: 'Samir Wahba',
        jobTitle: 'Owner',
        email: 'samir@tahrirpharma.example.com',
        phone: '+20 107 888 0801',
      },
    ],
    sites: [
      {
        name: 'Downtown branch',
        line1: '30 Talaat Harb Street',
        city: 'Cairo',
        region: 'Downtown',
        postcode: '11511',
        latitude: 30.0478,
        longitude: 31.2394,
      },
    ],
  },
];

export async function seedCustomers(ctx: DemoContext): Promise<void> {
  const customers: {
    id: string;
    name: string;
    email: string;
    contacts: string[];
    sites: { id: string; name: string }[];
  }[] = [];

  for (const seed of CUSTOMERS) {
    const first = seed.sites[0]!;
    const customer = await ctx.call<{ id: string }>('dispatcher', 'POST', '/v1/customers', {
      name: seed.name,
      accountNumber: seed.accountNumber,
      email: seed.email,
      phone: seed.phone,
      // On hold is set after the sites go in, below.
      address: {
        line1: first.line1,
        city: first.city,
        region: first.region,
        postcode: first.postcode,
        countryCode: 'EG',
      },
      tags: seed.tags,
      ...(seed.notes === undefined ? {} : { notes: seed.notes }),
    });

    const contacts: string[] = [];
    for (const [index, contact] of seed.contacts.entries()) {
      const created = await ctx.call<{ id: string }>(
        'dispatcher',
        'POST',
        `/v1/customers/${customer.id}/contacts`,
        { ...contact, isPrimary: index === 0 },
      );
      contacts.push(created.id);
    }

    const sites: { id: string; name: string }[] = [];
    for (const site of seed.sites) {
      const created = await ctx.call<{ id: string }>(
        'dispatcher',
        'POST',
        `/v1/customers/${customer.id}/sites`,
        {
          name: site.name,
          address: {
            line1: site.line1,
            city: site.city,
            region: site.region,
            postcode: site.postcode,
            countryCode: 'EG',
          },
          ...(contacts[0] === undefined ? {} : { contactId: contacts[0] }),
          location: { latitude: site.latitude, longitude: site.longitude },
          ...(site.access === undefined ? {} : { access: site.access }),
        },
      );
      sites.push({ id: created.id, name: site.name });
    }

    customers.push({ id: customer.id, name: seed.name, email: seed.email, contacts, sites });
  }

  ctx.refs.customers = customers;
  // On hold last, so its sites and contacts could still be added.
  const held = CUSTOMERS.findIndex((seed) => seed.status === 'on_hold');
  ctx.refs.onHoldCustomerIndex = held;

  const sites = customers.reduce((total, customer) => total + customer.sites.length, 0);
  ctx.log(`${String(customers.length)} customers, ${String(sites)} sites`);
}

/** Runs last, once every section has had the chance to book work for this customer. */
export async function holdCustomers(ctx: DemoContext): Promise<void> {
  const index = ctx.refs.onHoldCustomerIndex as number;
  const customer = (ctx.refs.customers as { id: string }[] | undefined)?.[index];
  if (customer !== undefined) {
    await ctx.attempt('owner', 'PATCH', `/v1/customers/${customer.id}`, { status: 'on_hold' });
    ctx.log('one customer put on hold');
  }
}
