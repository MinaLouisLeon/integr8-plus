import { z } from 'zod';
import { ROLES, type Grant, type Role } from './roles.js';

/**
 * What each role may do, as one table.
 *
 * The alternative — a `role === 'admin'` check at each call site — spreads the
 * access-control policy across hundreds of files, where nobody can read it and
 * a missing check looks exactly like code that was never written. Here the
 * whole policy fits on a screen, and a reviewer can answer "what can a
 * dispatcher do?" by reading rather than by grepping.
 *
 * This is deliberately *not* derived from `roleRank`. Rank answers "is this
 * role at least as senior as that one", which is the right question for
 * guarding a whole surface and the wrong one for a specific capability: a
 * dispatcher outranks an engineer without needing to revoke anyone's sessions.
 * Every cell below is decided on its own, and `permissions.test.ts` fails if a
 * new permission is added without deciding it for all five roles.
 */

export const PERMISSIONS = [
  /** Read the company's own record: name, slug, status. */
  'tenant.read',
  /** Change company settings. Owner only — billing hangs off this in P17. */
  'tenant.update',
  /**
   * Set the company's look: logo, app icon, colours, default theme, website,
   * and whether its own apps are built. Staff-only (see
   * {@link STAFF_ONLY_PERMISSIONS}): the apps a company's people open are
   * built for that company by Integr8 and arrive wearing its brand, so nobody
   * in the company changes it, any more than they change their forms.
   */
  'branding.manage',

  'member.read',
  'member.invite',
  'member.update_role',
  'member.suspend',
  'member.remove',

  'invitation.read',
  'invitation.revoke',

  'session.read',
  'session.revoke',

  'audit.read',

  /** See forms and their published versions — everyone who fills one needs this. */
  'form.read',
  /**
   * Build, edit, clone and publish forms, and change who may fill them. A
   * published version can never be changed by anyone (migration 0006); this is
   * the permission to create the next one.
   *
   * Staff-only (see {@link STAFF_ONLY_PERMISSIONS}): Integr8 builds each
   * company's forms; the company's own owners and admins read and fill them.
   */
  'form.manage',

  /**
   * Start, fill and submit a form, and read one's own submissions. The form's
   * own fill roles narrow this further: holding the permission is necessary,
   * being in the form's list is also necessary.
   */
  'submission.fill',
  /** Read every submission in the company, not only one's own. */
  'submission.read_all',
  /**
   * Reopen a submitted form so it can be corrected, and submit the correction.
   * Every reopening and every amendment is kept (migration 0008); this is the
   * permission to add to that history, not to rewrite it.
   */
  'submission.amend',

  /** See how much storage the company's files use, by kind. What the company is billed for. */
  'storage.read',

  /** Read customers, their contacts and sites — access notes included, since the job needs them. */
  'customer.read',
  /** Create and change customers, contacts and sites, and attach files to them. */
  'customer.manage',
  /**
   * Configure job types: their forms, checklist, instructions and expected
   * duration. Staff-only, like `form.manage`, and for the same reason.
   */
  'job_type.manage',
  /** Read every work order, not only those one is assigned to. */
  'work_order.read_all',
  /** Create, edit, assign, dispatch, reschedule and cancel work orders, one at a time or in bulk. */
  'work_order.manage',
  /**
   * Work a job: travel, arrive, start, wait for parts, complete, tick its
   * checklist, comment and attach. Held by engineers for jobs they are assigned to.
   */
  'work_order.progress',
  /** Sign a completed job off, or send it back with a reason. */
  'work_order.review',
  /** Import customers, sites and work orders from CSV. */
  'import.run',

  /**
   * See what the company is paying for: the plan, the period, the card's
   * last failure. Separate from `billing.manage` because an admin may need to
   * know why uploads stopped without being able to change the subscription.
   */
  'billing.read',
  /**
   * Start a checkout, open the provider's portal, cancel. Owner only: the
   * person who signs up for a recurring charge should be the person who can
   * end it, and that is not everybody with an admin badge.
   */
  'billing.manage',
  /**
   * Define the company's own roles (ADR-0013): named roles built on a
   * built-in one, adding or taking away permissions. Owner only; owners and
   * admins give them to members with `member.update_role`.
   */
  'role.manage',

  // CRM (CRM/ERP plan, phase F1). Every one of these also needs the company's
  // `crm` module switched on (see MODULE_FEATURES in ./crm.ts): a permission
  // says what the seat may do, the module says whether the company has it.

  /**
   * Read the CRM: leads, opportunities, activities and the pipeline figures.
   * Separate from `customer.read` on purpose — an engineer reads a customer to
   * do a job, and has no business seeing what the customer is worth.
   */
  'crm.read',
  /** Add, edit, assign, qualify and archive leads. */
  'crm.lead.manage',
  /**
   * Convert a lead into a customer: links an existing customer or creates one.
   * Its own permission because it writes to the customer registry everybody
   * else works from.
   */
  'crm.lead.convert',
  /** Add and edit opportunities, and move them through the pipeline to won or lost. */
  'crm.opportunity.manage',
  /** Log calls, meetings and notes, and set and complete follow-ups. */
  'crm.activity.manage',
  /**
   * Add, rename, reorder and archive pipelines and their stages. Owners and
   * admins only (product decision, 2026-10-12; ADR-0012).
   */
  'crm.pipeline.manage',

  // Inventory and purchasing (CRM/ERP plan, phases E1 and E2). Each also needs
  // the company's `inventory` or `purchasing` module switched on.

  /** See the catalogue, stock locations, vans and how much is where. Not costs. */
  'inventory.read',
  /** Add and change items, categories, stock locations and vans, and assign vans. */
  'inventory.manage',
  /**
   * Move stock: receive, issue, transfer, adjust, count. Seats holding it also
   * see costs, because they are the ones who value what they move.
   */
  'inventory.move',
  /**
   * Record parts used on a job. Engineers hold it for jobs they are assigned
   * to and the van assigned to them; dispatchers and above for any job.
   */
  'inventory.consume',
  /** See suppliers and purchase orders. */
  'purchasing.read',
  /** Add suppliers, draft purchase orders and receive goods against approved ones. */
  'purchasing.manage',
  /**
   * Approve a purchase order so goods can be received against it. Owners and
   * admins only (product decision, 2026-10-11): spending is approved by the
   * people who answer for it.
   */
  'purchasing.approve',

  // Quotes and sales orders (CRM/ERP plan, phase S1). Each also needs the
  // company's `sales` module switched on.

  /** See quotes and sales orders, with their prices. */
  'sales.read',
  /**
   * Draft and revise quotes and orders, record a customer's answer, convert
   * an accepted quote, link or create jobs from an order.
   */
  'sales.manage',
  /**
   * Issue a quote to the customer and confirm an order, which reserves stock.
   * Owners and admins only (product decision, 2026-10-11): a price a customer
   * can hold the company to is approved by the people who answer for it.
   */
  'sales.issue',

  // A company's invoices, credit notes and payment receipts (CRM/ERP plan,
  // phase B1; ADR-0004, ADR-0007). Each also needs the company's `finance`
  // module switched on. Not Integr8's own billing (`billing.*`).

  /** See invoices, credit notes, payments and customer balances. */
  'finance.read',
  /** Draft invoices (blank, from an order or from a job) and credit notes. */
  'finance.manage',
  /**
   * Issue and void invoices, issue credit notes, record payments and allocate
   * them, and set the invoice issuer details and labour rates. Owners and
   * admins only (product decision, 2026-10-11): money the company claims or
   * received is answered for by the people who own it.
   */
  'finance.issue',

  // A company's register of the machines it services, their tags and their
  // service history (CRM/ERP plan, phase E3; ADR-0008). Each also needs the
  // company's `assets` module switched on.

  /**
   * See assets and their history. Engineers hold it for the sites they have a
   * job at; everyone else who holds it sees every asset.
   */
  'asset.read',
  /**
   * Register an asset at a job's site, record its condition and link it to the
   * job, from the phone or the office. Held by engineers for their own jobs
   * (product decision, 2026-10-11): the machine is usually found on site.
   */
  'asset.record',
  /** Edit, move, retire and tag assets, link them to any job, and import them. */
  'asset.manage',

  // The company's general ledger (CRM/ERP plan, phase A1; ADR-0009). Each also
  // needs the company's `ledger` module switched on. A management ledger, not
  // statutory accounts.

  /** See the chart, journals and the ledger's reports. */
  'ledger.read',
  /**
   * Draft and approve manual journals, post or set aside documents waiting in
   * the unposted list, and reverse journals. A manual journal is approved by
   * someone other than its drafter unless the owner allows self-approval.
   */
  'ledger.post',
  /** Set up the ledger, edit the chart and posting accounts, lock months and close a year. */
  'ledger.manage',
  /**
   * Unlock a month, reopen a closed year and allow self-approval. Owners only
   * (product decision, 2026-10-12): reopening the books is answered for by
   * the person who owns them.
   */
  'ledger.unlock',

  // HR, staff expenses and payroll (seventh round; ADR-0010). Each also needs
  // the company's `hr` module, and payroll its `payroll` module.

  /** See employee profiles' job details: title, department, dates. Not pay or ID numbers. */
  'hr.read',
  /**
   * See and change ID numbers, bank details and pay. Owners and HR managers
   * only (product decision, 2026-10-12); every reveal is audited.
   */
  'hr.sensitive',
  /** Add and change employee profiles, link them to members, end employment. */
  'hr.manage',
  /** Claim expenses back. Every member (product decision, 2026-10-12). */
  'expense.submit',
  /** Approve, reject and pay back other people's expense claims, and keep the categories. */
  'expense.approve',
  /** Keep pay terms and the payroll rule sets, and prepare pay runs. */
  'payroll.run',
  /** Approve a pay run someone else prepared, and confirm a rule set before use. */
  'payroll.approve',

  // Bills of materials, assembly and planning (seventh round; ADR-0011). Each
  // also needs the company's `manufacturing` module.

  /** See bills of materials, assembly orders and plans. */
  'manufacturing.read',
  /** Keep bills of materials, assemble and take apart, and run planning. */
  'manufacturing.manage',

  // PDF documents made from submissions (documents ADR-0001). Each also needs
  // the company's `documents` module switched on.

  /** See the company's register of generated PDFs, open them and copy their links. */
  'document.read',
  /**
   * Turn a submission into a PDF from one of its form's templates. The
   * submission must also be one the member may read.
   */
  'document.create',
  /** Expire, renew and delete generated PDFs. */
  'document.manage',
  /**
   * Design a form's PDF templates. Staff-only (see
   * {@link STAFF_ONLY_PERMISSIONS}), like the forms themselves.
   */
  'document.design',
] as const;

export const permissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof permissionSchema>;

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(PERMISSIONS);

/** True for a permission this build knows. */
export function isPermission(value: string): value is Permission {
  return KNOWN_PERMISSIONS.has(value);
}

/**
 * The matrix. Every role lists every permission it holds, in full — no
 * inheritance, no spreading of one role into another.
 *
 * Inheritance is how a matrix silently grants something: widening `admin`
 * quietly widens everything built on top of it, and the diff that did it shows
 * one line in an unrelated role. Repetition here is the point.
 */
const MATRIX: Readonly<Record<Role, readonly Permission[]>> = Object.freeze({
  owner: [
    'tenant.read',
    'tenant.update',
    'branding.manage',
    'billing.read',
    'billing.manage',
    'role.manage',
    'member.read',
    'member.invite',
    'member.update_role',
    'member.suspend',
    'member.remove',
    'invitation.read',
    'invitation.revoke',
    'session.read',
    'session.revoke',
    'audit.read',
    'form.read',
    'form.manage',
    'submission.fill',
    'submission.read_all',
    'submission.amend',
    'storage.read',
    'customer.read',
    'customer.manage',
    'job_type.manage',
    'work_order.read_all',
    'work_order.manage',
    'work_order.progress',
    'work_order.review',
    'import.run',
    'crm.read',
    'crm.lead.manage',
    'crm.lead.convert',
    'crm.opportunity.manage',
    'crm.activity.manage',
    'crm.pipeline.manage',
    'inventory.read',
    'inventory.manage',
    'inventory.move',
    'inventory.consume',
    'purchasing.read',
    'purchasing.manage',
    'purchasing.approve',
    'sales.read',
    'sales.manage',
    'sales.issue',
    'finance.read',
    'finance.manage',
    'finance.issue',
    'asset.read',
    'asset.record',
    'asset.manage',
    'ledger.read',
    'ledger.post',
    'ledger.manage',
    'ledger.unlock',
    'hr.read',
    'hr.sensitive',
    'hr.manage',
    'expense.submit',
    'expense.approve',
    'payroll.run',
    'payroll.approve',
    'manufacturing.read',
    'manufacturing.manage',
    'document.read',
    'document.create',
    'document.manage',
    'document.design',
  ],

  // Everything an owner can do except change the company itself. The line is
  // drawn at what an owner would want to be the only person able to alter:
  // company identity, and the subscription that pays for it (P17). An admin
  // may read the billing state, because "why did uploads stop" is a question
  // they will be asked before the owner is.
  admin: [
    'tenant.read',
    'billing.read',
    'member.read',
    'member.invite',
    'member.update_role',
    'member.suspend',
    'member.remove',
    'invitation.read',
    'invitation.revoke',
    'session.read',
    'session.revoke',
    'audit.read',
    'form.read',
    'form.manage',
    'submission.fill',
    'submission.read_all',
    'submission.amend',
    'storage.read',
    'customer.read',
    'customer.manage',
    'job_type.manage',
    'work_order.read_all',
    'work_order.manage',
    'work_order.progress',
    'work_order.review',
    'import.run',
    'crm.read',
    'crm.lead.manage',
    'crm.lead.convert',
    'crm.opportunity.manage',
    'crm.activity.manage',
    'crm.pipeline.manage',
    'inventory.read',
    'inventory.manage',
    'inventory.move',
    'inventory.consume',
    'purchasing.read',
    'purchasing.manage',
    'purchasing.approve',
    'sales.read',
    'sales.manage',
    'sales.issue',
    'finance.read',
    'finance.manage',
    'finance.issue',
    'asset.read',
    'asset.record',
    'asset.manage',
    'ledger.read',
    'ledger.post',
    'ledger.manage',
    'hr.read',
    'expense.submit',
    'expense.approve',
    'manufacturing.read',
    'manufacturing.manage',
    'document.read',
    'document.create',
    'document.manage',
    'document.design',
  ],

  // Keeps HR and payroll (ADR-0010): the people, their pay and their claims,
  // and nothing of the operation. Reads members to link profiles to them.
  hr_manager: [
    'tenant.read',
    'member.read',
    'form.read',
    'hr.read',
    'hr.sensitive',
    'hr.manage',
    'expense.submit',
    'expense.approve',
    'payroll.run',
    'payroll.approve',
  ],

  // Keeps the store (ADR-0010, ADR-0011): the catalogue, stock, vans,
  // suppliers and purchase orders, bills of materials and assembly. Approving
  // spending stays with owners and admins (2026-10-11).
  inventory_manager: [
    'tenant.read',
    'member.read',
    'form.read',
    'customer.read',
    'inventory.read',
    'inventory.manage',
    'inventory.move',
    'inventory.consume',
    'purchasing.read',
    'purchasing.manage',
    'sales.read',
    'expense.submit',
    'manufacturing.read',
    'manufacturing.manage',
  ],

  // Runs the day: needs to see who is available, not to change who they are.
  // Reads every submission to follow the day's work, and can fill a form on an
  // engineer's behalf; correcting a submitted one is left to owners and admins.
  // Owns work orders and customer records; signing a job off and configuring
  // job types are left to owners and admins too.
  dispatcher: [
    'tenant.read',
    'member.read',
    'form.read',
    'submission.fill',
    'submission.read_all',
    'customer.read',
    'customer.manage',
    'work_order.read_all',
    'work_order.manage',
    'work_order.progress',
    // Product decision (2026-10-11): the dispatcher runs the CRM day to day,
    // conversion included, as well as the jobs it leads to.
    'crm.read',
    'crm.lead.manage',
    'crm.lead.convert',
    'crm.opportunity.manage',
    'crm.activity.manage',
    // Product decision (2026-10-11): runs stock and drafts purchases; approving
    // a purchase is left to owners and admins.
    'inventory.read',
    'inventory.manage',
    'inventory.move',
    'inventory.consume',
    'purchasing.read',
    'purchasing.manage',
    // Product decision (2026-10-11): drafts quotes and orders and records the
    // customer's answer; issuing and confirming are left to owners and admins.
    'sales.read',
    'sales.manage',
    // Product decision (2026-10-11): drafts invoices and credit notes; issuing,
    // voiding and recording money are left to owners and admins.
    'finance.read',
    'finance.manage',
    'asset.read',
    'asset.record',
    'asset.manage',
    'expense.submit',
    'document.read',
    'document.create',
  ],

  // Does the work. Sees colleagues so a job can be handed over, their own
  // submissions, and the jobs they are assigned to — with the customer and site
  // details those jobs need.
  engineer: [
    'tenant.read',
    'member.read',
    'form.read',
    'submission.fill',
    'customer.read',
    'work_order.progress',
    // Product decision (2026-10-11): sees stock and records the parts used on
    // their own jobs, from the van assigned to them.
    'inventory.read',
    'inventory.consume',
    'asset.read',
    'asset.record',
    'expense.submit',
    'document.create',
  ],

  // Reads, and only reads: every submission and every job, and nothing to fill.
  viewer: [
    'tenant.read',
    'member.read',
    'form.read',
    'submission.read_all',
    'customer.read',
    'work_order.read_all',
    // Reads the CRM and changes nothing in it, like everything else a viewer sees.
    'crm.read',
    'inventory.read',
    'purchasing.read',
    'sales.read',
    'finance.read',
    'asset.read',
    'ledger.read',
    'expense.submit',
    'manufacturing.read',
    'document.read',
  ],
});

/** Lookup form of {@link MATRIX}, written out so no cast is needed to build it. */
const BY_ROLE: Readonly<Record<Role, ReadonlySet<Permission>>> = Object.freeze({
  owner: new Set(MATRIX.owner),
  admin: new Set(MATRIX.admin),
  hr_manager: new Set(MATRIX.hr_manager),
  inventory_manager: new Set(MATRIX.inventory_manager),
  dispatcher: new Set(MATRIX.dispatcher),
  engineer: new Set(MATRIX.engineer),
  viewer: new Set(MATRIX.viewer),
});

/** True when `role` holds `permission`. */
export function can(role: Role, permission: Permission): boolean {
  return BY_ROLE[role].has(permission);
}

/** Every permission a role holds, for building a UI or debugging a denial. */
export function permissionsFor(role: Role): Permission[] {
  return [...MATRIX[role]];
}

/**
 * Thrown when a permission check fails.
 *
 * Carries the role and permission so the API can log precisely what was denied
 * while telling the caller only that it was.
 */
export class PermissionDeniedError extends Error {
  constructor(
    readonly role: Role,
    readonly permission: Permission,
    /**
     * `role`: the role never holds it. `staff_only`: the role's seat would,
     * but only with Integr8 staff in it (see {@link STAFF_ONLY_PERMISSIONS}).
     */
    readonly reason: 'role' | 'staff_only' = 'role',
  ) {
    super(
      reason === 'staff_only'
        ? `Permission "${permission}" is held only by Integr8 staff acting for the company`
        : `Role "${role}" does not hold permission "${permission}"`,
    );
    this.name = 'PermissionDeniedError';
  }
}

/** {@link can}, but throwing. The form most call sites want. */
export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) {
    throw new PermissionDeniedError(role, permission);
  }
}

// ---------------------------------------------------------------------------
// What Integr8 does for a company, rather than the company for itself
// ---------------------------------------------------------------------------

/**
 * Permissions that only Integr8 staff hold, however senior the seat.
 *
 * The product is sold with its forms and job types built by Integr8 for each
 * company: a company's people fill forms and work jobs, and ask Integr8 when
 * something about either needs to change. So an owner's `form.manage` in the
 * matrix above is the *ceiling* for the seat, and this set says which of those
 * capabilities are only reached when the seat is held by a staff member —
 * which, in a token, is an impersonation claim (`imp`), since staff never
 * become members of a company (`tenant_users_reject_platform_user`).
 *
 * Kept as an overlay rather than removed from the matrix so that the matrix
 * still answers "what can this role's seat do when Integr8 sits in it", and
 * so an impersonated engineer gains nothing: the ceiling still applies.
 */
export const STAFF_ONLY_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'form.manage',
  'job_type.manage',
  'branding.manage',
  'document.design',
]);

/**
 * The part of a principal that decides what it may actually do: the role
 * (its ceiling) and whether Integr8 staff are behind it. Structurally a
 * `Principal`, so one can be passed as is.
 */
export interface Seat {
  readonly role: Role;
  /** Capabilities given on top of the role (ADR-0010); none when absent. */
  readonly grants?: readonly Grant[] | undefined;
  /**
   * The company's own role this seat holds (ADR-0013), on top of `role`, its
   * base: what it adds and takes away. None when absent.
   */
  readonly customRole?: CustomRoleOverlay | undefined;
  /** Present when a super admin is acting through this seat. */
  readonly impersonatedBy?: object | undefined;
}

/**
 * What each grant adds on top of a role: the area of the role of the same
 * name, without its basics. Never a member-management permission, so a grant
 * can never be used to give out grants.
 */
export const GRANT_PERMISSIONS: Readonly<Record<Grant, readonly Permission[]>> = Object.freeze({
  hr_manager: [
    'hr.read',
    'hr.sensitive',
    'hr.manage',
    'expense.approve',
    'payroll.run',
    'payroll.approve',
  ],
  inventory_manager: [
    'inventory.read',
    'inventory.manage',
    'inventory.move',
    'inventory.consume',
    'purchasing.read',
    'purchasing.manage',
    'manufacturing.read',
    'manufacturing.manage',
  ],
});

/** True when the seat's role, or one of its grants, holds the permission. */
function seatCan(seat: Seat, permission: Permission): boolean {
  return (
    roleCan(seat, permission) ||
    (seat.grants ?? []).some((grant) => GRANT_PERMISSIONS[grant].includes(permission))
  );
}

/** The seat's role, built-in or the company's own, holds the permission. */
function roleCan(seat: Seat, permission: Permission): boolean {
  const custom = seat.customRole;
  if (custom === undefined || seat.role === 'owner') {
    return can(seat.role, permission);
  }
  if (custom.removed.includes(permission)) {
    return false;
  }
  return (
    can(seat.role, permission) ||
    (custom.added.includes(permission) && customRoleMayHold(permission))
  );
}

/** True when Integr8 staff hold the seat. */
export function isStaffSeat(seat: Seat): boolean {
  return seat.impersonatedBy !== undefined;
}

/**
 * True when this seat may do this now: the role holds the permission, and the
 * permission is either open to the company or the seat is held by staff.
 *
 * Call sites that have a principal use this rather than {@link can}; `can`
 * remains the matrix lookup for code that only has a role in hand (such as a
 * form's fill roles).
 */
export function holds(seat: Seat, permission: Permission): boolean {
  return (
    seatCan(seat, permission) && (!STAFF_ONLY_PERMISSIONS.has(permission) || isStaffSeat(seat))
  );
}

/** Every permission a seat holds right now, for `/v1/me` and the screens built on it. */
export function permissionsHeld(seat: Seat): Permission[] {
  const granted = (seat.grants ?? []).flatMap((grant) => GRANT_PERMISSIONS[grant]);
  const added = seat.customRole?.added ?? [];
  return [...new Set([...permissionsFor(seat.role), ...added, ...granted])].filter((permission) =>
    holds(seat, permission),
  );
}

/** {@link holds}, but throwing, with the reason for the denial attached. */
export function assertHolds(seat: Seat, permission: Permission): void {
  if (!seatCan(seat, permission)) {
    throw new PermissionDeniedError(seat.role, permission);
  }
  if (!holds(seat, permission)) {
    throw new PermissionDeniedError(seat.role, permission, 'staff_only');
  }
}

// ---------------------------------------------------------------------------
// The company's own roles (ADR-0013)
// ---------------------------------------------------------------------------

/** The built-in roles a custom role may start from: every one but the owner. */
export const CUSTOM_ROLE_BASES = ROLES.filter(
  (role): role is Exclude<Role, 'owner'> => role !== 'owner',
);
export type CustomRoleBase = (typeof CUSTOM_ROLE_BASES)[number];

/**
 * Permissions no custom role may hold: what only the owner does (the
 * company's settings and billing, unlocking a closed month, defining roles),
 * and what only Integr8 staff do.
 */
export const OWNER_ONLY_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'tenant.update',
  'billing.manage',
  'ledger.unlock',
  'role.manage',
]);

/** True when a custom role may add this permission to its base. */
export function customRoleMayHold(permission: Permission): boolean {
  return !OWNER_ONLY_PERMISSIONS.has(permission) && !STAFF_ONLY_PERMISSIONS.has(permission);
}

/** A custom role as a seat carries it: what it adds to and takes from its base role. */
export interface CustomRoleOverlay {
  readonly id: string;
  readonly added: readonly Permission[];
  readonly removed: readonly Permission[];
}

/** Every permission a custom role on this base holds, before staff-only rules. */
export function customRolePermissions(
  base: CustomRoleBase,
  overlay: Pick<CustomRoleOverlay, 'added' | 'removed'>,
): Permission[] {
  const removed = new Set(overlay.removed);
  return [
    ...new Set([
      ...permissionsFor(base).filter((permission) => !removed.has(permission)),
      ...overlay.added.filter(customRoleMayHold),
    ]),
  ];
}
