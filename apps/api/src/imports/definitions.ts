import type { ImportKind } from '@integr8/db';
import { csvLine } from './csv.js';

/**
 * What each import accepts, column by column. The same list is the template a
 * person downloads, the check on their header row, and the documentation.
 */

export interface ImportColumn {
  name: string;
  required: boolean;
  description: string;
  example: string;
}

const address = (example: { line1: string; city: string; postcode: string }): ImportColumn[] => [
  {
    name: 'address_line1',
    required: false,
    description: 'First line of the address.',
    example: example.line1,
  },
  {
    name: 'address_line2',
    required: false,
    description: 'Second line of the address.',
    example: '',
  },
  { name: 'city', required: false, description: 'Town or city.', example: example.city },
  { name: 'region', required: false, description: 'County, state or emirate.', example: '' },
  { name: 'postcode', required: false, description: 'Postal code.', example: example.postcode },
  {
    name: 'country',
    required: false,
    description: 'Two-letter country code, such as GB or AE.',
    example: 'GB',
  },
];

const customerReference: ImportColumn[] = [
  {
    name: 'customer_account_number',
    required: false,
    description: 'The customer, by account number. Either this or customer_name is needed.',
    example: 'RH-001',
  },
  {
    name: 'customer_name',
    required: false,
    description: 'The customer, by exact name, when there is no account number.',
    example: '',
  },
];

export const IMPORT_COLUMNS: Record<ImportKind, readonly ImportColumn[]> = {
  customers: [
    {
      name: 'name',
      required: true,
      description: 'The customer’s name.',
      example: 'Riverside Housing',
    },
    {
      name: 'account_number',
      required: false,
      description: 'Your reference for the customer. Unique; a row repeating one is refused.',
      example: 'RH-001',
    },
    {
      name: 'status',
      required: false,
      description: 'active, on_hold or closed. Default active.',
      example: 'active',
    },
    {
      name: 'email',
      required: false,
      description: 'Main email address.',
      example: 'accounts@riverside.example',
    },
    { name: 'phone', required: false, description: 'Main phone number.', example: '0113 496 0000' },
    ...address({ line1: '1 River Road', city: 'Leeds', postcode: 'LS1 1AA' }),
    {
      name: 'tags',
      required: false,
      description: 'Separated by semicolons.',
      example: 'social housing; priority',
    },
    { name: 'notes', required: false, description: 'Anything else.', example: '' },
  ],
  sites: [
    ...customerReference,
    {
      name: 'site_name',
      required: true,
      description: 'The site’s name, unique for its customer.',
      example: 'Block A',
    },
    ...address({ line1: '1 River Road', city: 'Leeds', postcode: 'LS1 1AA' }).map((column) =>
      column.name === 'address_line1' ? { ...column, required: true } : column,
    ),
    {
      name: 'latitude',
      required: false,
      description:
        'Decimal degrees. With longitude, places the site by hand instead of geocoding it.',
      example: '',
    },
    { name: 'longitude', required: false, description: 'Decimal degrees.', example: '' },
    { name: 'gate_code', required: false, description: 'Gate or door code.', example: '4471#' },
    {
      name: 'parking',
      required: false,
      description: 'Where to park.',
      example: 'Visitor bays at the rear',
    },
    {
      name: 'ask_for',
      required: false,
      description: 'Who to ask for on arrival.',
      example: 'Caretaker, ext 12',
    },
    {
      name: 'hazards',
      required: false,
      description: 'Safety hazards on arrival.',
      example: 'Asbestos in plant room',
    },
    {
      name: 'access_notes',
      required: false,
      description: 'Anything else about getting in.',
      example: '',
    },
  ],
  work_orders: [
    ...customerReference,
    {
      name: 'site_name',
      required: true,
      description: 'One of the customer’s sites, by name.',
      example: 'Block A',
    },
    {
      name: 'job_type',
      required: true,
      description: 'A job type, by code or name.',
      example: 'BOILER-SERVICE',
    },
    {
      name: 'title',
      required: false,
      description: 'Defaults to the job type’s name.',
      example: '',
    },
    {
      name: 'description',
      required: false,
      description: 'What the job is.',
      example: 'Annual service, flat 4',
    },
    {
      name: 'instructions',
      required: false,
      description: 'Defaults to the job type’s instructions.',
      example: '',
    },
    {
      name: 'priority',
      required: false,
      description: 'low, normal, high or urgent.',
      example: 'normal',
    },
    {
      name: 'due_from',
      required: false,
      description:
        'Earliest start: 2026-10-01 or 2026-10-01 09:00, in your time zone, or ISO 8601 with an offset.',
      example: '2026-10-01 09:00',
    },
    {
      name: 'due_by',
      required: false,
      description: 'Latest finish. A date alone means the end of that day.',
      example: '2026-10-01',
    },
    {
      name: 'engineers',
      required: false,
      description: 'Email addresses of the crew, separated by semicolons.',
      example: 'sam@yourcompany.example',
    },
    {
      name: 'lead',
      required: false,
      description: 'The lead’s email address, if a crew of several.',
      example: '',
    },
  ],
};

/** The template to download: a header row and one example row. */
export function importTemplate(kind: ImportKind): string {
  const columns = IMPORT_COLUMNS[kind];
  return `${csvLine(columns.map((column) => column.name))}\r\n${csvLine(columns.map((column) => column.example))}\r\n`;
}

/** Largest file accepted, and most rows: enough for a company's history, small enough to finish in minutes. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 20_000;
