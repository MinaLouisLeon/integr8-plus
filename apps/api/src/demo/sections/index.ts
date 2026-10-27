import type { DemoContext } from '../context.js';
import { seedAssetsAndContracts } from './assets.js';
import { seedCrm } from './crm.js';
import { holdCustomers, seedCustomers } from './customers.js';
import { seedEInvoicing } from './e-invoicing.js';
import { seedFieldService } from './field-service.js';
import { seedFinance } from './finance.js';
import { seedFormsAndDocuments } from './forms.js';
import { seedHr } from './hr.js';
import { seedInventory } from './inventory.js';
import { seedLedgerActivity, seedLedgerSetup } from './ledger.js';
import { seedManufacturing } from './manufacturing.js';
import { seedPurchasing } from './purchasing.js';
import { seedSales } from './sales.js';
import { seedSetup } from './setup.js';

export interface DemoSection {
  key: string;
  name: string;
  run: (ctx: DemoContext) => Promise<void>;
  /** Everything else depends on these, so `--only` never skips them. */
  always?: boolean;
}

/** In dependency order: later sections read the ids earlier ones leave in `ctx.refs`. */
export const DEMO_SECTIONS: readonly DemoSection[] = [
  { key: 'setup', name: 'Company setup, roles and qualifications', run: seedSetup, always: true },
  // Before anything that posts to the ledger, so every posting lands in it.
  { key: 'ledger-setup', name: 'Ledger: chart of accounts and settings', run: seedLedgerSetup },
  { key: 'customers', name: 'Customers, contacts and sites', run: seedCustomers, always: true },
  {
    key: 'inventory',
    name: 'Stock: suppliers, items, locations, opening stock',
    run: seedInventory,
    always: true,
  },
  { key: 'purchasing', name: 'Purchasing: prices, orders, receipts', run: seedPurchasing },
  {
    key: 'manufacturing',
    name: 'Manufacturing: BOMs, assembly orders, plans',
    run: seedManufacturing,
  },
  { key: 'assets', name: 'Assets, contracts and maintenance plans', run: seedAssetsAndContracts },
  { key: 'field-service', name: 'Work orders, visits and parts used', run: seedFieldService },
  { key: 'forms', name: 'Forms, submissions and documents', run: seedFormsAndDocuments },
  { key: 'crm', name: 'CRM: pipelines, leads, opportunities, activities', run: seedCrm },
  { key: 'sales', name: 'Sales: quotes, orders, deliveries', run: seedSales },
  { key: 'hr', name: 'HR: employees, expenses, payroll', run: seedHr },
  { key: 'finance', name: 'Finance: invoices, credit notes, payments', run: seedFinance },
  { key: 'e-invoicing', name: 'E-invoicing (ETA) setup and documents', run: seedEInvoicing },
  { key: 'ledger', name: 'Ledger: journals, postings, periods', run: seedLedgerActivity },
  { key: 'holds', name: 'Customer holds', run: holdCustomers },
];
