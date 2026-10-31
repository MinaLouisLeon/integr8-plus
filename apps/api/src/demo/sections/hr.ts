import { day, type DemoContext, type DemoPerson, monthStart } from '../context.js';

/**
 * HR: employee profiles, expense claims in every state, payroll.
 *
 * Adds to refs:
 *   employees  { id, name, userId | null }[]
 *   payRuns    { id, reference, status }[]
 *
 * ID, insurance and bank numbers are sealed with the server's HR_DATA_KEY, and
 * refused without it, so they are only sent when the key is set.
 */

interface EmployeeSeed {
  person: DemoPerson['key'];
  number: string;
  jobTitle: string;
  department: string;
  hiredMonthsAgo: number;
  basic: string;
  allowances: string;
  payMethod?: 'bank_transfer' | 'cash';
  nationalId: string;
  bank: string;
}

const EMPLOYEES: readonly EmployeeSeed[] = [
  {
    person: 'owner',
    number: 'E-001',
    jobTitle: 'Managing director',
    department: 'Management',
    hiredMonthsAgo: 72,
    basic: '45000',
    allowances: '5000',
    nationalId: '27501011234561',
    bank: 'National Bank of Egypt',
  },
  {
    person: 'admin',
    number: 'E-002',
    jobTitle: 'Operations manager',
    department: 'Operations',
    hiredMonthsAgo: 48,
    basic: '28000',
    allowances: '3000',
    nationalId: '28203151234562',
    bank: 'Banque Misr',
  },
  {
    person: 'hr',
    number: 'E-003',
    jobTitle: 'HR & payroll officer',
    department: 'Administration',
    hiredMonthsAgo: 30,
    basic: '18000',
    allowances: '1500',
    nationalId: '29007221234563',
    bank: 'CIB',
  },
  {
    person: 'store',
    number: 'E-004',
    jobTitle: 'Storekeeper',
    department: 'Stores',
    hiredMonthsAgo: 26,
    basic: '12000',
    allowances: '1000',
    nationalId: '29111031234564',
    bank: 'Banque Misr',
  },
  {
    person: 'dispatcher',
    number: 'E-005',
    jobTitle: 'Dispatcher',
    department: 'Operations',
    hiredMonthsAgo: 20,
    basic: '13000',
    allowances: '1200',
    nationalId: '29504181234565',
    bank: 'National Bank of Egypt',
  },
  {
    person: 'engineer1',
    number: 'E-006',
    jobTitle: 'Senior HVAC engineer',
    department: 'Field service',
    hiredMonthsAgo: 40,
    basic: '22000',
    allowances: '3500',
    nationalId: '28809091234566',
    bank: 'CIB',
  },
  {
    person: 'engineer2',
    number: 'E-007',
    jobTitle: 'HVAC engineer',
    department: 'Field service',
    hiredMonthsAgo: 18,
    basic: '16000',
    allowances: '2500',
    nationalId: '29602141234567',
    bank: 'QNB',
  },
  {
    person: 'engineer3',
    number: 'E-008',
    jobTitle: 'Electrical engineer',
    department: 'Field service',
    hiredMonthsAgo: 9,
    basic: '15000',
    allowances: '2500',
    payMethod: 'cash',
    nationalId: '29810301234568',
    bank: 'Banque Misr',
  },
  {
    person: 'viewer',
    number: 'E-009',
    jobTitle: 'Accounts assistant',
    department: 'Finance',
    hiredMonthsAgo: 14,
    basic: '11000',
    allowances: '800',
    nationalId: '29905051234569',
    bank: 'National Bank of Egypt',
  },
];

interface Claim {
  id: string;
  version: number;
}

export async function seedHr(ctx: DemoContext): Promise<void> {
  const sealed = (process.env.HR_DATA_KEY ?? '').trim() !== '';

  // 1. Employees, one per member, and a standalone leaver.
  const employees: { id: string; name: string; userId: string | null }[] = [];
  for (const [index, seed] of EMPLOYEES.entries()) {
    const person = ctx.people[seed.person];
    const created = await ctx.call<{ id: string }>('hr', 'POST', '/v1/hr/employees', {
      userId: person.userId,
      employeeNumber: seed.number,
      jobTitle: seed.jobTitle,
      department: seed.department,
      phone: `+20 10${String(index)} 900 ${String(1000 + index)}`,
      hireDate: day(-30 * seed.hiredMonthsAgo),
      emergencyContactName: 'Family contact',
      emergencyContactPhone: `+20 11${String(index)} 800 ${String(2000 + index)}`,
      ...(sealed
        ? {
            nationalId: seed.nationalId,
            insuranceNumber: `INS ${String(4400100 + index)}`,
            bankName: seed.bank,
            bankAccount: `EG38 0019 0005 ${String(10000000 + index * 7919)}`,
          }
        : {}),
    });
    employees.push({ id: created.id, name: person.displayName, userId: person.userId });
  }

  const leaver = await ctx.call<{ id: string; version: number }>('hr', 'POST', '/v1/hr/employees', {
    employeeNumber: 'E-010',
    fullName: 'Hossam Ragab',
    jobTitle: 'Driver',
    department: 'Field service',
    phone: '+20 112 700 3001',
    hireDate: day(-30 * 36),
  });
  await ctx.call('hr', 'PATCH', `/v1/hr/employees/${leaver.id}`, {
    expectedVersion: leaver.version,
    endDate: day(-45),
    endReason: 'Resigned: moved to Aswan',
  });
  employees.push({ id: leaver.id, name: 'Hossam Ragab', userId: null });
  ctx.refs.employees = employees;
  ctx.log(
    `${String(employees.length)} employees (one has left)${sealed ? '' : ' — no HR_DATA_KEY, so no ID or bank numbers'}`,
  );

  // 2. Expense categories.
  const categories: Record<string, string> = {};
  for (const name of [
    'Fuel',
    'Parking & tolls',
    'Meals',
    'Tools & small parts',
    'Travel & hotels',
    'Phone',
  ]) {
    categories[name] = (
      await ctx.call<{ id: string }>('hr', 'POST', '/v1/expenses/categories', { name })
    ).id;
  }

  const claim = async (
    who: DemoPerson['key'],
    category: string,
    amount: string,
    description: string,
    daysAgo: number,
  ): Promise<Claim> =>
    ctx.call<Claim>(who, 'POST', '/v1/expenses', {
      categoryId: categories[category],
      spentOn: day(-daysAgo),
      amount,
      description,
    });
  const approve = (c: Claim, settleVia: 'direct' | 'payroll') =>
    ctx.call<Claim>('hr', 'POST', `/v1/expenses/${c.id}/approve`, {
      expectedVersion: c.version,
      settleVia,
    });

  // Waiting for a decision.
  await claim('engineer1', 'Fuel', '350.00', 'Fuel: Heliopolis and Zamalek visits', 2);
  await claim(
    'dispatcher',
    'Parking & tolls',
    '150.00',
    'Taxi to the Smart Village site meeting',
    1,
  );
  await claim('engineer2', 'Phone', '200.00', 'Mobile data top-up for the job app', 3);
  // Approved, paid back directly.
  const parking = await approve(
    await claim('engineer1', 'Parking & tolls', '60.00', 'Zamalek tower parking', 12),
    'direct',
  );
  await ctx.call('hr', 'POST', `/v1/expenses/${parking.id}/pay`, {
    expectedVersion: parking.version,
    via: 'bank_transfer',
    reference: 'TRF-88213',
  });
  const cash = await approve(
    await claim('dispatcher', 'Meals', '90.00', 'Lunch for the night shift crew', 9),
    'direct',
  );
  await ctx.call('hr', 'POST', `/v1/expenses/${cash.id}/pay`, {
    expectedVersion: cash.version,
    via: 'cash',
  });
  // Approved, not yet paid.
  await approve(
    await claim('engineer2', 'Tools & small parts', '1450.00', 'Replacement crimping tool', 6),
    'direct',
  );
  // Rejected.
  const meals = await claim('engineer2', 'Meals', '220.00', 'Dinner, Alexandria trip', 10);
  await ctx.call('hr', 'POST', `/v1/expenses/${meals.id}/reject`, {
    expectedVersion: meals.version,
    reason: 'Covered by the daily allowance for that trip.',
  });
  // Withdrawn by the claimant.
  const fuel = await claim(
    'engineer3',
    'Fuel',
    '400.00',
    'Fuel (duplicate of last week’s claim)',
    8,
  );
  await ctx.call('engineer3', 'POST', `/v1/expenses/${fuel.id}/withdraw`, {
    expectedVersion: fuel.version,
  });
  ctx.log('6 expense categories, 8 claims (waiting, approved, paid, rejected, withdrawn)');

  // 3. Payroll: the rules, confirmed by the owner; everyone's pay; two past
  //    months approved; this month prepared and waiting for approval.
  const ruleSet = await ctx.call<{ id: string; version: number }>(
    'hr',
    'POST',
    '/v1/payroll/rule-sets',
    {
      name: 'Egypt payroll rules',
      effectiveFrom: monthStart(-6),
    },
  );
  await ctx.call('owner', 'POST', `/v1/payroll/rule-sets/${ruleSet.id}/confirm`, {
    expectedVersion: ruleSet.version,
    note: 'Checked against the current tax and social insurance guides by our accountant.',
  });

  for (const [index, seed] of EMPLOYEES.entries()) {
    await ctx.call('hr', 'POST', `/v1/hr/employees/${employees[index]!.id}/pay-terms`, {
      effectiveFrom: monthStart(-6),
      basic: seed.basic,
      allowances: seed.allowances,
      insured: true,
      standardHours: '208',
      overtimeRate: ((Number(seed.basic) / 208) * 1.35).toFixed(2),
      payMethod: seed.payMethod ?? 'bank_transfer',
    });
  }
  // A pay rise from last month for the senior engineer.
  await ctx.call('hr', 'POST', `/v1/hr/employees/${employees[5]!.id}/pay-terms`, {
    effectiveFrom: monthStart(-1),
    basic: '24000',
    allowances: '3500',
    insured: true,
  });

  interface Run {
    id: string;
    reference: string;
    status: string;
    version: number;
    lines: { id: string; version: number; employee: { id: string } }[];
  }
  const payRuns: { id: string; reference: string; status: string }[] = [];
  const prepare = (months: number) =>
    ctx.call<Run>('hr', 'POST', '/v1/payroll/runs', { month: monthStart(months).slice(0, 7) });
  const editLine = (run: Run, employeeIndex: number, patch: Record<string, string>) => {
    const line = run.lines.find(
      (candidate) => candidate.employee.id === employees[employeeIndex]!.id,
    );
    if (line === undefined) {
      return Promise.resolve(run);
    }
    return ctx.call<Run>('hr', 'PATCH', `/v1/payroll/runs/${run.id}/lines/${line.id}`, {
      expectedRunVersion: run.version,
      expectedVersion: line.version,
      ...patch,
    });
  };

  for (const months of [-2, -1]) {
    let run = await prepare(months);
    run = await editLine(run, 5, { overtimeHours: '12', note: 'Hospital chiller emergency' });
    run = await editLine(run, 6, { bonus: '1000', note: 'Customer commendation' });
    const approved = await ctx.call<Run>('owner', 'POST', `/v1/payroll/runs/${run.id}/approve`, {
      expectedVersion: run.version,
    });
    payRuns.push({ id: approved.id, reference: approved.reference, status: approved.status });
  }

  // Claims to be paid back through this month's payroll.
  await approve(
    await claim(
      'engineer3',
      'Travel & hotels',
      '1800.00',
      'Hotel, two nights: Alexandria cold store job',
      5,
    ),
    'payroll',
  );
  await approve(
    await claim('engineer1', 'Fuel', '275.50', 'Fuel: Giza bakehouse callout', 4),
    'payroll',
  );

  let current = await prepare(0);
  current = await editLine(current, 7, { unpaidDays: '1', note: 'One day unpaid leave' });
  current = await editLine(current, 4, { overtimeHours: '6' });
  payRuns.push({ id: current.id, reference: current.reference, status: current.status });
  ctx.refs.payRuns = payRuns;
  ctx.log('confirmed rule set, pay terms for everyone, 2 approved pay runs and this month’s draft');

  // 4. A capability on top of a role: the dispatcher also keeps the store.
  await ctx.call(
    'owner',
    'PUT',
    `/v1/members/${ctx.people.dispatcher.userId}/grants/inventory_manager`,
  );
  ctx.log('dispatcher granted the store-keeping capability');
}
