import { totpCode } from '@integr8/auth';
import { getPlatformDataSource, type PlatformUser } from '@integr8/db';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ApiError, conflict, internal, notFound, unauthorised } from '../../../http/errors.js';
import { defineRoute, noSchema, type PlatformRequestContext } from '../../../http/routes.js';
import { iso } from '../schemas.js';
import { recordPlatformAction } from './audit.js';

/**
 * Integr8's own staff, as the dashboard manages them.
 *
 * Everybody signed in to the dashboard can see who else can; only a staff
 * manager can change that. A staff manager is an account the terminal command
 * (`admin-cli create`) made — somebody with a shell on the server. An account
 * added here is never one, so the power to add and remove people cannot spread
 * from the dashboard by itself: whoever holds the server decides who holds it.
 *
 * Removing somebody deactivates the account rather than deleting it, so the
 * audit log keeps a name for everything they did, and ends their dashboard
 * sessions and any company they were inside at that moment.
 */

const staffMemberSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  isActive: z.boolean(),
  /** Made by the terminal command, so may add and remove staff. */
  canManageStaff: z.boolean(),
  /** Who added this account from the dashboard; null for terminal accounts. */
  addedBy: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  /** Whether the account has both a password and a second factor. */
  ready: z.boolean(),
  createdAt: z.iso.datetime(),
  lastSignedInAt: z.iso.datetime().nullable(),
  /** The account this request is signed in as. */
  isYou: z.boolean(),
});

/** Shown once, to the manager who asked, and stored nowhere in readable form. */
const staffCredentialsSchema = z.object({
  member: staffMemberSchema,
  password: z.string(),
  totpSecret: z.string(),
  /** An `otpauth://` address to show as a QR code. */
  totpUri: z.string(),
});

const staffParams = z.object({ platformUserId: z.uuid() });

/** Refuses anybody the terminal command did not make. */
export async function requireStaffManager(context: PlatformRequestContext): Promise<PlatformUser> {
  const account = await getPlatformDataSource().platformUsers.findById(
    context.platform.platformUserId,
  );
  if (!account?.isActive) {
    throw unauthorised();
  }
  if (!account.canManageStaff) {
    throw new ApiError(
      403,
      'staff_manager_only',
      'Only an account made with the terminal command can add or remove staff.',
    );
  }
  return account;
}

export const listStaffRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/staff',
  operationId: 'listPlatformStaff',
  summary: 'Everybody who can sign in to the dashboard',
  description:
    'Every platform account, including removed ones, oldest first. Anybody signed in may read it; `canManageStaff` on `/v1/platform/me` says whether they may change it.',
  tags: ['platform'],
  security: 'platform',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The staff.', schema: z.object({ items: z.array(staffMemberSchema) }) },
  },
  handler: async (_input, context) => {
    const accounts = await getPlatformDataSource().platformUsers.list();
    const names = new Map(accounts.map((account) => [account.id, account.displayName]));
    return {
      status: 200,
      body: {
        items: accounts.map((account) =>
          toStaffMember(account, context.platform.platformUserId, names),
        ),
      },
    };
  },
});

export const addStaffRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/staff',
  operationId: 'addPlatformStaff',
  summary: 'Give somebody a dashboard account',
  description:
    'Staff managers only. Creates the account with a generated password and second factor and returns both once. An address that belonged to a removed account brings it back with new credentials. The new account can use the dashboard but cannot add or remove staff.',
  tags: ['platform'],
  security: 'platform',
  params: noSchema,
  query: noSchema,
  body: z.object({
    email: z.email().max(320),
    displayName: z.string().trim().min(1).max(120),
  }),
  responses: {
    201: { description: 'Added; the credentials are shown once.', schema: staffCredentialsSchema },
    403: { description: '`staff_manager_only`: this account cannot add staff.' },
    409: { description: '`staff_exists`: somebody already signs in with this address.' },
  },
  handler: async ({ body }, context) => {
    const manager = await requireStaffManager(context);
    const platform = getPlatformDataSource();

    const existing = await platform.platformUsers.findByEmail(body.email);
    if (existing?.isActive === true) {
      throw conflict(
        'staff_exists',
        'Somebody already signs in to the dashboard with this address.',
      );
    }

    let account: PlatformUser;
    if (existing === undefined) {
      account = await platform.platformUsers.create({
        email: body.email,
        displayName: body.displayName,
        canManageStaff: false,
        addedBy: manager.id,
      });
    } else {
      // A terminal account that was removed comes back through the terminal,
      // where it was made, so the dashboard never hands out that power.
      if (existing.canManageStaff) {
        throw conflict(
          'staff_exists',
          'This address belongs to an account made with the terminal command. Bring it back from the terminal.',
        );
      }
      await platform.platformUsers.reactivate(existing.id, manager.id);
      account = existing;
    }

    const credentials = await issueCredentials(context, account.id);

    await recordPlatformAction(context, {
      action: existing === undefined ? 'staff.added' : 'staff.restored',
      targetKind: 'platform_user',
      targetId: account.id,
      metadata: { email: account.email },
    });

    return {
      status: 201,
      body: { member: await memberById(account.id, manager.id), ...credentials },
    };
  },
});

export const resetStaffCredentialsRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/staff/:platformUserId/credentials',
  operationId: 'resetPlatformStaffCredentials',
  summary: 'Give a staff member a new password and second factor',
  description:
    'Staff managers only, and only for accounts added from the dashboard: a terminal account resets from the terminal. Ends every session the account has and returns the new credentials once.',
  tags: ['platform'],
  security: 'platform',
  params: staffParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'Reset; the credentials are shown once.', schema: staffCredentialsSchema },
    403: {
      description: '`staff_manager_only`, or `terminal_account` for an account the terminal made.',
    },
    404: { description: 'No such staff member, or one who was removed.' },
  },
  handler: async ({ params }, context) => {
    const manager = await requireStaffManager(context);
    const account = await removableAccount(params.platformUserId, manager);

    const credentials = await issueCredentials(context, account.id);
    await getPlatformDataSource().platformUsers.unlock(account.id);

    await recordPlatformAction(context, {
      action: 'staff.credentials_reset',
      targetKind: 'platform_user',
      targetId: account.id,
      metadata: { email: account.email },
    });

    return {
      status: 200,
      body: { member: await memberById(account.id, manager.id), ...credentials },
    };
  },
});

export const removeStaffRoute = defineRoute({
  method: 'delete',
  path: '/v1/platform/staff/:platformUserId',
  operationId: 'removePlatformStaff',
  summary: 'Take somebody off the staff',
  description:
    'Staff managers only, and only for accounts added from the dashboard. The account is deactivated, not deleted, so the audit log keeps its name. Every dashboard session it has ends now, and so does any company it is inside.',
  tags: ['platform'],
  security: 'platform',
  params: staffParams,
  query: noSchema,
  body: noSchema,
  responses: {
    204: { description: 'Removed.' },
    403: {
      description: '`staff_manager_only`, or `terminal_account` for an account the terminal made.',
    },
    404: { description: 'No such staff member, or one already removed.' },
  },
  handler: async ({ params }, context) => {
    const manager = await requireStaffManager(context);
    const account = await removableAccount(params.platformUserId, manager);
    const platform = getPlatformDataSource();

    const now = new Date();
    await platform.platformUsers.setActive(account.id, false);
    const sessions = await platform.platformSessions.revokeAllFor(
      account.id,
      'account_disabled',
      now,
    );
    const impersonations = await platform.platformUsers.endLiveImpersonations(account.id, now);

    await recordPlatformAction(context, {
      action: 'staff.removed',
      targetKind: 'platform_user',
      targetId: account.id,
      metadata: { email: account.email, sessions, impersonations },
    });

    return { status: 204, body: undefined };
  },
});

/**
 * An account a manager may reset or remove: one that exists, is still on the
 * staff, and was added from the dashboard. A manager is always a terminal
 * account, so this also refuses the manager acting on themselves.
 */
async function removableAccount(id: string, manager: PlatformUser): Promise<PlatformUser> {
  const account = await getPlatformDataSource().platformUsers.findById(id);
  if (!account?.isActive) {
    throw notFound('No such staff member.');
  }
  if (account.canManageStaff || account.id === manager.id) {
    throw new ApiError(
      403,
      'terminal_account',
      'This account was made with the terminal command and can only be changed from there.',
    );
  }
  return account;
}

/** A fresh password and second factor, the same way the terminal command makes them. */
async function issueCredentials(
  context: PlatformRequestContext,
  id: string,
): Promise<{ password: string; totpSecret: string; totpUri: string }> {
  const sessions = context.services.platform;
  // 192 random bits as URL-safe text. Setting it ends every session the
  // account had, which is what a reset is for.
  const password = randomBytes(24).toString('base64url');
  await sessions.setPassword(id, password);

  const enrolment = await sessions.beginTotpEnrolment(id);
  if (!(await sessions.confirmTotpEnrolment(id, totpCode(enrolment.secret)))) {
    throw internal('Could not set up the second factor.');
  }
  return { password, totpSecret: enrolment.secret, totpUri: enrolment.uri };
}

async function memberById(id: string, you: string): Promise<z.infer<typeof staffMemberSchema>> {
  const platform = getPlatformDataSource();
  const account = await platform.platformUsers.findById(id);
  if (account === undefined) {
    throw notFound('No such staff member.');
  }
  const addedBy =
    account.addedBy === null ? undefined : await platform.platformUsers.findById(account.addedBy);
  const names = new Map(addedBy === undefined ? [] : [[addedBy.id, addedBy.displayName]]);
  return toStaffMember(account, you, names);
}

function toStaffMember(
  account: PlatformUser,
  you: string,
  names: ReadonlyMap<string, string>,
): z.infer<typeof staffMemberSchema> {
  const addedByName = account.addedBy === null ? undefined : names.get(account.addedBy);
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    isActive: account.isActive,
    canManageStaff: account.canManageStaff,
    addedBy:
      account.addedBy === null || addedByName === undefined
        ? null
        : { id: account.addedBy, displayName: addedByName },
    ready: account.hasPassword && account.totpEnrolledAt !== null,
    createdAt: iso(account.createdAt),
    lastSignedInAt: account.lastSignedInAt === null ? null : iso(account.lastSignedInAt),
    isYou: account.id === you,
  };
}

export const platformStaffRoutes = [
  listStaffRoute,
  addStaffRoute,
  resetStaffCredentialsRoute,
  removeStaffRoute,
];
