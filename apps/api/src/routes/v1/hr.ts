import { randomUUID } from 'node:crypto';
import { holds, type Principal, roleSchema } from '@integr8/core';
import {
  type Employee,
  type EmployeeInput,
  type SealedField,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import { z } from 'zod';
import { ApiError, conflict, forbidden, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import {
  hrKey,
  lastFour,
  openField,
  SEALED_FIELDS,
  type SealedFieldName,
  sealField,
} from '../../hr/sealed-fields.js';
import { crmAudit as audit, versionConflict } from './crm-shared.js';
import { decodeNameCursor, encodeNameCursor } from './operations.js';
import { iso } from './schemas.js';

/**
 * Employee profiles (seventh round; ADR-0010).
 *
 * A profile links to a member or stands alone for someone who never signs in.
 * Job details are read by owners, admins and HR managers; ID, insurance and
 * bank numbers only by owners and HR managers (`hr.sensitive`), and by the
 * person themselves. Those numbers are sealed here, before they reach the
 * database, and opened only by an explicit, audited reveal.
 */

const TAGS = ['hr'];
const HR = 'hr' as const;

const last4Schema = z.object({ last4: z.string() }).nullable();

export const employeeSchema = z.object({
  id: z.uuid(),
  employeeNumber: z.string().nullable(),
  fullName: z.string(),
  jobTitle: z.string().nullable(),
  department: z.string().nullable(),
  phone: z.string().nullable(),
  hireDate: z.iso.date(),
  endDate: z.iso.date().nullable(),
  endReason: z.string().nullable(),
  status: z.enum(['active', 'ended']),
  /** The member this person signs in as; null for someone who never does. */
  member: z.object({ userId: z.uuid(), displayName: z.string(), role: roleSchema }).nullable(),
  /** Null unless the reader may see pay and ID details, or it is their own profile. */
  sensitive: z
    .object({
      nationalId: last4Schema,
      insuranceNumber: last4Schema,
      bankName: z.string().nullable(),
      bankAccount: last4Schema,
    })
    .nullable(),
  emergencyContact: z.object({ name: z.string().nullable(), phone: z.string().nullable() }),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  can: z.object({ edit: z.boolean(), reveal: z.boolean() }),
});

/** A number someone types: letters, digits, spaces and dashes, kept as typed. */
const secretInput = z
  .string()
  .trim()
  .min(4)
  .max(40)
  .regex(/^[0-9A-Za-z][0-9A-Za-z -]*$/u, 'Use letters, digits, spaces and dashes');

const text = (max: number) => z.string().trim().min(1).max(max);

const employeeBody = z.object({
  userId: z.uuid().nullable().optional(),
  employeeNumber: text(40).nullable().optional(),
  fullName: text(200).optional(),
  jobTitle: text(200).nullable().optional(),
  department: text(200).nullable().optional(),
  phone: text(40).nullable().optional(),
  hireDate: z.iso.date().optional(),
  nationalId: secretInput.nullable().optional(),
  insuranceNumber: secretInput.nullable().optional(),
  bankName: text(200).nullable().optional(),
  bankAccount: secretInput.nullable().optional(),
  emergencyContactName: text(200).nullable().optional(),
  emergencyContactPhone: text(40).nullable().optional(),
});

type EmployeeBody = z.infer<typeof employeeBody>;

const employeeParams = z.object({ employeeId: z.uuid() });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function keyOrRefuse(context: RequestContext): Buffer {
  const value = context.config.HR_DATA_KEY;
  if (value === undefined) {
    throw new ApiError(
      503,
      'hr_key_missing',
      'ID, insurance and bank numbers cannot be stored or shown until HR_DATA_KEY is set on the server.',
    );
  }
  return hrKey(value);
}

const own = (principal: Principal, employee: Employee) =>
  employee.userId !== null && employee.userId === principal.userId;

async function employeeView(
  tx: TenantTransaction,
  principal: Principal,
  employee: Employee,
): Promise<z.infer<typeof employeeSchema>> {
  const member =
    employee.userId === null ? undefined : await tx.tenantUsers.findByUserId(employee.userId);
  const sees = holds(principal, 'hr.sensitive') || own(principal, employee);
  const masked = (field: SealedField | null) => (field === null ? null : { last4: field.last4 });
  return {
    id: employee.id,
    employeeNumber: employee.employeeNumber,
    fullName: employee.fullName,
    jobTitle: employee.jobTitle,
    department: employee.department,
    phone: employee.phone,
    hireDate: employee.hireDate,
    endDate: employee.endDate,
    endReason: employee.endReason,
    status: employee.endDate === null ? 'active' : 'ended',
    member:
      member === undefined
        ? null
        : { userId: member.userId, displayName: member.displayName, role: member.role },
    sensitive: sees
      ? {
          nationalId: masked(employee.nationalId),
          insuranceNumber: masked(employee.insuranceNumber),
          bankName: employee.bankName,
          bankAccount: masked(employee.bankAccount),
        }
      : null,
    emergencyContact: {
      name: employee.emergencyContactName,
      phone: employee.emergencyContactPhone,
    },
    version: employee.version,
    createdAt: iso(employee.createdAt),
    updatedAt: iso(employee.updatedAt),
    can: {
      edit: holds(principal, 'hr.manage'),
      reveal: sees,
    },
  };
}

/**
 * Turns a body into what the repository writes: sensitive numbers sealed to
 * this employee, a linked member checked, the name taken from the member when
 * none is given.
 */
async function toInput(
  tx: TenantTransaction,
  context: RequestContext,
  employeeId: string,
  body: EmployeeBody,
): Promise<EmployeeInput> {
  const input: EmployeeInput = {};
  const plain = [
    'employeeNumber',
    'fullName',
    'jobTitle',
    'department',
    'phone',
    'hireDate',
    'bankName',
    'emergencyContactName',
    'emergencyContactPhone',
  ] as const;
  for (const key of plain) {
    if (body[key] !== undefined) {
      (input as Record<string, unknown>)[key] = body[key];
    }
  }
  if (body.userId !== undefined) {
    if (body.userId !== null) {
      const member = await tx.tenantUsers.findByUserId(body.userId);
      if (member === undefined) {
        throw unprocessable('member_not_found', 'No such member in this company.', [
          { field: 'body.userId', code: 'member_not_found', message: 'No such member.' },
        ]);
      }
      input.fullName ??= member.displayName;
    }
    input.userId = body.userId;
  }
  const touchesSecrets = SEALED_FIELDS.some((field) => body[field] !== undefined);
  if (touchesSecrets) {
    if (!holds(context.principal, 'hr.sensitive')) {
      throw forbidden('Only the owner and HR managers keep ID, insurance and bank numbers.');
    }
    const key = keyOrRefuse(context);
    for (const field of SEALED_FIELDS) {
      const value = body[field];
      if (value === undefined) {
        continue;
      }
      input[field] =
        value === null
          ? null
          : {
              sealed: sealField(value, key, {
                tenantId: context.principal.tenantId,
                employeeId,
                field,
              }),
              last4: lastFour(value),
            };
    }
  }
  return input;
}

function refusal(result: 'number_taken' | 'member_taken'): never {
  if (result === 'number_taken') {
    throw conflict('number_taken', 'Another employee has this number.');
  }
  throw conflict('member_taken', 'This member already has a profile.');
}

/** What an audit entry says changed: field names only, never the values. */
const changedFields = (body: Record<string, unknown>) =>
  Object.keys(body).filter((key) => key !== 'expectedVersion' && body[key] !== undefined);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const listEmployeesRoute = defineRoute({
  method: 'get',
  path: '/v1/hr/employees',
  operationId: 'listEmployees',
  summary: 'Employees, by name',
  description:
    '`q` matches the name, employee number, title or department. Active ones unless `status=ended` or `status=all`. ID and bank numbers appear only as their last four, and only to owners and HR managers.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'hr.read',
  feature: HR,
  params: noSchema,
  query: z.object({
    q: z.string().trim().max(200).optional(),
    status: z.enum(['active', 'ended', 'all']).default('active'),
    department: z.string().trim().max(200).optional(),
    cursor: z.string().max(400).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page.',
      schema: z.object({
        items: z.array(employeeSchema),
        nextCursor: z.string().nullable(),
        departments: z.array(z.string()),
      }),
    },
  },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const page = await tx.hrEmployees.list({
        ...(query.q === undefined ? {} : { q: query.q }),
        ...(query.status === 'all' ? {} : { status: query.status }),
        ...(query.department === undefined ? {} : { department: query.department }),
        after: decodeNameCursor(query.cursor),
        limit: query.limit,
      });
      return {
        items: await Promise.all(
          page.items.map((employee) => employeeView(tx, principal, employee)),
        ),
        nextCursor: encodeNameCursor(page.next),
        departments: await tx.hrEmployees.departments(),
      };
    });
    return { status: 200, body };
  },
});

export const myEmployeeProfileRoute = defineRoute({
  method: 'get',
  path: '/v1/hr/me',
  operationId: 'getMyEmployeeProfile',
  summary: 'My own employee profile',
  description:
    'Every member reads their own profile, ID and bank details included. 404 when there is none.',
  tags: TAGS,
  security: 'authenticated',
  feature: HR,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The profile.', schema: employeeSchema },
    404: { description: 'No profile for this member.' },
  },
  handler: async (_request, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const employee = await tx.hrEmployees.findByUser(principal.userId);
      if (employee === undefined) {
        throw notFound('You have no employee profile yet.');
      }
      return employeeView(tx, principal, employee);
    });
    return { status: 200, body };
  },
});

export const getEmployeeRoute = defineRoute({
  method: 'get',
  path: '/v1/hr/employees/:employeeId',
  operationId: 'getEmployee',
  summary: 'An employee profile',
  description: 'For `hr.read`, or the person themselves.',
  tags: TAGS,
  security: 'authenticated',
  feature: HR,
  params: employeeParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The profile.', schema: employeeSchema },
    404: { description: 'No such employee.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const employee = await tx.hrEmployees.find(params.employeeId);
      if (employee === undefined || !(holds(principal, 'hr.read') || own(principal, employee))) {
        throw notFound('No such employee.');
      }
      return employeeView(tx, principal, employee);
    });
    return { status: 200, body };
  },
});

export const createEmployeeRoute = defineRoute({
  method: 'post',
  path: '/v1/hr/employees',
  operationId: 'createEmployee',
  summary: 'Add an employee',
  description:
    'Linked to a member (`userId`; the name defaults to theirs, 409 `member_taken` when they have a profile) or standing alone with a `fullName`. ID, insurance and bank numbers are sealed before they are stored and need `hr.sensitive` and the server’s HR_DATA_KEY (503 `hr_key_missing`). Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'hr.manage',
  feature: HR,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: employeeBody.extend({ hireDate: z.iso.date() }),
  responses: {
    201: { description: 'The profile.', schema: employeeSchema },
    409: { description: 'The number or the member is already taken.' },
    422: { description: 'No name, or no such member.' },
    503: { description: 'HR_DATA_KEY is not set.' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const created = await withTenant(principal.tenantId, async (tx) => {
      const id = randomUUID();
      const input = await toInput(tx, context, id, body);
      if (input.fullName === undefined) {
        throw unprocessable('name_required', 'Give a name, or link the profile to a member.', [
          { field: 'body.fullName', code: 'name_required', message: 'Required.' },
        ]);
      }
      const result = await tx.hrEmployees.create(
        { ...input, id, fullName: input.fullName, hireDate: body.hireDate },
        principal.userId,
      );
      if (typeof result === 'string') {
        refusal(result);
      }
      await audit(tx, context, 'hr.employee_created', 'hr_employee', result.id, {
        fields: changedFields(body),
      });
      return employeeView(tx, principal, result);
    });
    return { status: 201, body: created };
  },
});

export const updateEmployeeRoute = defineRoute({
  method: 'patch',
  path: '/v1/hr/employees/:employeeId',
  operationId: 'updateEmployee',
  summary: 'Change an employee profile, or end their employment',
  description:
    'With `expectedVersion` (409 `version_conflict`). `endDate` with `endReason` ends the employment; both `null` brings them back. A sensitive number is replaced by sending it, cleared by `null`. The audit names the fields changed, never their values.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'hr.manage',
  feature: HR,
  params: employeeParams,
  query: noSchema,
  body: employeeBody
    .extend({
      expectedVersion: z.number().int().min(1),
      endDate: z.iso.date().nullable().optional(),
      endReason: text(1000).nullable().optional(),
    })
    .refine(
      (body) => (body.endDate === undefined) === (body.endReason === undefined),
      'Give endDate and endReason together',
    ),
  responses: {
    200: { description: 'The profile.', schema: employeeSchema },
    404: { description: 'No such employee.' },
    409: { description: 'Changed elsewhere, or the number or member is taken.' },
    422: { description: 'An end before the hire date, or no such member.' },
    503: { description: 'HR_DATA_KEY is not set.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const updated = await withTenant(principal.tenantId, async (tx) => {
      const current = await tx.hrEmployees.lock(params.employeeId);
      if (current === undefined) {
        throw notFound('No such employee.');
      }
      const input = await toInput(tx, context, current.id, body);
      if (body.endDate !== undefined) {
        if ((body.endDate === null) !== (body.endReason === null)) {
          throw unprocessable('end_pairing', 'Give an end date with its reason, or neither.');
        }
        const hire = input.hireDate ?? current.hireDate;
        if (body.endDate !== null && body.endDate < hire) {
          throw unprocessable('end_before_hire', `Employment ends on or after ${hire}.`, [
            { field: 'body.endDate', code: 'end_before_hire', message: `On or after ${hire}.` },
          ]);
        }
        input.endDate = body.endDate;
        input.endReason = body.endReason ?? null;
      }
      const result = await tx.hrEmployees.update(current.id, body.expectedVersion, input);
      if (result === 'version_conflict') {
        throw versionConflict();
      }
      if (typeof result === 'string') {
        refusal(result);
      }
      const ended = current.endDate === null && result.endDate !== null;
      await audit(
        tx,
        context,
        ended ? 'hr.employee_ended' : 'hr.employee_updated',
        'hr_employee',
        result.id,
        { fields: changedFields(body) },
      );
      return employeeView(tx, principal, result);
    });
    return { status: 200, body: updated };
  },
});

export const revealEmployeeFieldRoute = defineRoute({
  method: 'post',
  path: '/v1/hr/employees/:employeeId/reveal',
  operationId: 'revealEmployeeField',
  summary: 'Show one sensitive number in full',
  description:
    'For owners and HR managers, or the person themselves. Every reveal is audited with who, when and which field.',
  tags: TAGS,
  security: 'authenticated',
  feature: HR,
  params: employeeParams,
  query: noSchema,
  body: z.object({ field: z.enum(SEALED_FIELDS) }),
  responses: {
    200: {
      description: 'The value.',
      schema: z.object({ field: z.enum(SEALED_FIELDS), value: z.string().nullable() }),
    },
    404: { description: 'No such employee.' },
    503: { description: 'HR_DATA_KEY is not set.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const value = await withTenant(principal.tenantId, async (tx) => {
      const employee = await tx.hrEmployees.find(params.employeeId);
      if (
        employee === undefined ||
        !(holds(principal, 'hr.sensitive') || own(principal, employee))
      ) {
        throw notFound('No such employee.');
      }
      const field: SealedFieldName = body.field;
      const sealedValue = employee[field];
      if (sealedValue === null) {
        return null;
      }
      const opened = openField(sealedValue.sealed, keyOrRefuse(context), {
        tenantId: principal.tenantId,
        employeeId: employee.id,
        field,
      });
      await audit(tx, context, 'hr.field_revealed', 'hr_employee', employee.id, { field });
      return opened;
    });
    return { status: 200, body: { field: body.field, value } };
  },
});

export const hrRoutes = [
  listEmployeesRoute,
  myEmployeeProfileRoute,
  getEmployeeRoute,
  createEmployeeRoute,
  updateEmployeeRoute,
  revealEmployeeFieldRoute,
];
