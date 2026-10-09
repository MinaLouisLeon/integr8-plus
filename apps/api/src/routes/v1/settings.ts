import { assertHolds, PermissionDeniedError } from '@integr8/core';
import { companyThemeSchema, getPlatformDataSource, TENANT_PLANS, withTenant } from '@integr8/db';
import { z } from 'zod';
import { forbidden, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';

/**
 * How a company works, and what the plans cost (P18).
 *
 * Two unrelated things in one file because both are small and both are "facts
 * about a company or about what it could buy", rather than operations.
 *
 * The pricing route is the interesting one. Its exit criterion is *every plan
 * limit shown on the pricing page matches what the entitlement service
 * enforces*, and the only way to guarantee that is for the page to read the
 * same `plan_allowances` rows the API enforces. Copy on a marketing page is a
 * second source of truth, and the two disagree the first time somebody edits a
 * plan from the dashboard.
 */

const TAGS = ['workspace'];

const colourSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/u);

const settingsSchema = z.object({
  logoMediaId: z.uuid().nullable(),
  brandColour: z.string().nullable(),
  /** The dashboard shell (sidebar, top bar) colour, `#RRGGBB`, or null for the product's own. */
  shellColour: z.string().nullable(),
  /** The theme every app of this company opens in. */
  defaultTheme: companyThemeSchema,
  /** The company's own website, https only. */
  websiteUrl: z.string().nullable(),
  /** A square image for installer and phone icons, or null for the product's own. */
  appIconMediaId: z.uuid().nullable(),
  /** Whether the release pipeline builds this company's own desktop and phone apps. */
  appsEnabled: z.boolean(),
  timezone: z.string(),
  currency: z.string(),
  locale: z.string(),
  /** Minutes from midnight, in the company's own timezone. */
  workDayStarts: z.number().int(),
  workDayEnds: z.number().int(),
  /** ISO weekday numbers; 1 is Monday. Empty means the company is closed. */
  workingDays: z.array(z.number().int().min(1).max(7)),
});

export const getSettingsRoute = defineRoute({
  method: 'get',
  path: '/v1/settings',
  operationId: 'getSettings',
  summary: 'How this company works',
  description:
    'Branding, where they are and when they work. Readable by anybody in the company, because the working day shapes what every screen shows.',
  tags: TAGS,
  security: 'authenticated',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'The settings.', schema: settingsSchema } },
  handler: async (_input, context) => {
    const settings = await withTenant(context.principal.tenantId, (tx) => tx.settings.get());
    return { status: 200, body: toBody(settings) };
  },
});

export const updateSettingsRoute = defineRoute({
  method: 'patch',
  path: '/v1/settings',
  operationId: 'updateSettings',
  summary: 'Change how this company works',
  description:
    'Only what is sent is changed, so a screen that edits branding cannot blank working hours it never showed. The branding fields — logo, app icon, colours, default theme, website and whether the company’s own apps are built — are Integr8’s to set (`branding.manage`), and a company owner sending one of them is refused with 403; timezone, currency, locale and working hours stay the owner’s.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'tenant.update',
  params: noSchema,
  query: noSchema,
  body: z.object({
    logoMediaId: z.uuid().nullable().optional(),
    /** `#RRGGBB`. The database refuses anything else. */
    brandColour: colourSchema.nullable().optional(),
    shellColour: colourSchema.nullable().optional(),
    defaultTheme: companyThemeSchema.optional(),
    /** https only; the phone app shows this page in a web view. */
    websiteUrl: z
      .string()
      .max(2048)
      .regex(/^https:\/\/\S+$/u)
      .nullable()
      .optional(),
    appIconMediaId: z.uuid().nullable().optional(),
    appsEnabled: z.boolean().optional(),
    /** An IANA name. Validated against the runtime's own tz database. */
    timezone: z.string().min(1).max(64).optional(),
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/u)
      .optional(),
    locale: z.string().min(2).max(12).optional(),
    workDayStarts: z.number().int().min(0).max(1440).optional(),
    workDayEnds: z.number().int().min(0).max(1440).optional(),
    workingDays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  }),
  responses: {
    200: { description: 'The settings, as they now are.', schema: settingsSchema },
    403: { description: 'A branding field was sent by somebody other than Integr8 staff.' },
    422: {
      description:
        'An unknown timezone (`unknown_timezone`), or a logo or app icon that is not a stored image of this company’s (`logo_not_found`, `app_icon_not_found`).',
    },
  },
  handler: async ({ body }, context) => {
    if (body.timezone !== undefined && !isKnownTimezone(body.timezone)) {
      throw unprocessableTimezone(body.timezone);
    }

    if (BRANDING_FIELDS.some((field) => body[field] !== undefined)) {
      try {
        assertHolds(context.principal, 'branding.manage');
      } catch (error) {
        if (error instanceof PermissionDeniedError) {
          throw forbidden(
            'Your company’s look — logo, colours, theme and website — is set up by Integr8. Ask us, and we will make the change for you.',
          );
        }
        throw error;
      }
    }

    const settings = await withTenant(context.principal.tenantId, async (tx) => {
      if (body.logoMediaId != null) {
        // The column's foreign key already refuses another company's file and
        // a file that does not exist, but it refuses with a constraint error
        // that would surface as a 500. Checked here so a crafted request gets
        // a 422 that names the field, and so a deleted file or a PDF cannot
        // become the logo: the key does not know what kind of file it is.
        await assertStoredImage(tx, body.logoMediaId, 'logoMediaId', 'logo_not_found', 'logo');
      }
      if (body.appIconMediaId != null) {
        await assertStoredImage(
          tx,
          body.appIconMediaId,
          'appIconMediaId',
          'app_icon_not_found',
          'app icon',
        );
      }
      const updated = await tx.settings.update(body);
      await tx.auditLog.append({
        actorKind: 'tenant_user',
        actorId: context.principal.userId,
        actorLabel: context.principal.userId,
        action: 'settings.updated',
        resourceType: 'tenant',
        resourceId: context.principal.tenantId,
        metadata: { fields: Object.keys(body) },
      });
      return updated;
    });

    return { status: 200, body: toBody(settings) };
  },
});

/**
 * What each plan costs and allows, for anybody at all.
 *
 * Public because the pricing page is public and has no session. It exposes only
 * what a pricing page shows — no provider price ids, no internal flags — and it
 * is the same row the entitlement service reads, which is the point.
 */
export const publicPlansRoute = defineRoute({
  method: 'get',
  path: '/v1/plans',
  operationId: 'listPublicPlans',
  summary: 'What each plan costs and allows',
  description:
    'The same rows the API enforces its limits from. A pricing page that reads this cannot disagree with a refusal, which is exactly what it would do if the numbers were written into the copy.',
  tags: ['signup'],
  security: 'public',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The plans, cheapest first.',
      schema: z.object({
        items: z.array(
          z.object({
            plan: z.enum(TENANT_PLANS),
            priceCents: z.number().int().nullable(),
            currency: z.string().nullable(),
            seats: z.number().int().nullable(),
            submissionsPerMonth: z.number().int().nullable(),
            storageBytes: z.number().int().nullable(),
            retentionDays: z.number().int().nullable(),
            /** Whether somebody could actually buy it today. */
            purchasable: z.boolean(),
          }),
        ),
      }),
    },
  },
  handler: async (_input, context) => {
    void context;
    const allowances = await getPlatformDataSource().metering.allowances();

    return {
      status: 200,
      body: {
        items: allowances.map((allowance) => ({
          plan: allowance.plan,
          priceCents: allowance.priceCents,
          currency: allowance.currency,
          seats: allowance.seats,
          submissionsPerMonth: allowance.submissionsPerMonth,
          storageBytes: allowance.storageBytes,
          retentionDays: allowance.retentionDays,
          // Said plainly rather than hidden: a plan with no price at the
          // provider cannot be bought, and the checkout refuses it. A pricing
          // page that offered it anyway would send somebody to a dead end.
          purchasable:
            allowance.providerPriceMonthly !== null || allowance.providerPriceYearly !== null,
        })),
      },
    };
  },
});

/** What `branding.manage` guards: the look of the company's apps, and whether they are built. */
const BRANDING_FIELDS = [
  'logoMediaId',
  'brandColour',
  'shellColour',
  'defaultTheme',
  'websiteUrl',
  'appIconMediaId',
  'appsEnabled',
] as const;

/**
 * Refuses a media id that is not a live image of this company's, with a 422
 * that names the field rather than the constraint error the key would raise.
 */
async function assertStoredImage(
  tx: {
    files: { find(id: string): Promise<{ deletedAt: Date | null; category: string } | undefined> };
  },
  mediaId: string,
  field: string,
  code: string,
  what: string,
): Promise<void> {
  const file = await tx.files.find(mediaId);
  // Missing, deleted, or not an image: `deletedAt` is `undefined` for a
  // missing file, which is `!== null` and so is refused with the rest.
  if (file?.deletedAt !== null || file.category !== 'image') {
    throw unprocessable(code, `The ${what} must be an image uploaded by this company.`, [
      { field: `body.${field}`, code, message: 'Not a stored image.' },
    ]);
  }
}

function toBody(settings: {
  logoMediaId: string | null;
  brandColour: string | null;
  shellColour: string | null;
  defaultTheme: 'light' | 'dark' | 'system';
  websiteUrl: string | null;
  appIconMediaId: string | null;
  appsEnabled: boolean;
  timezone: string;
  currency: string;
  locale: string;
  workDayStarts: number;
  workDayEnds: number;
  workingDays: number[];
}) {
  return {
    logoMediaId: settings.logoMediaId,
    brandColour: settings.brandColour,
    shellColour: settings.shellColour,
    defaultTheme: settings.defaultTheme,
    websiteUrl: settings.websiteUrl,
    appIconMediaId: settings.appIconMediaId,
    appsEnabled: settings.appsEnabled,
    timezone: settings.timezone,
    currency: settings.currency,
    locale: settings.locale,
    workDayStarts: settings.workDayStarts,
    workDayEnds: settings.workDayEnds,
    workingDays: settings.workingDays,
  };
}

/**
 * Whether the runtime has heard of this timezone.
 *
 * Asked of `Intl` rather than checked against a list of our own: the list would
 * be wrong within a year, and a company whose timezone this process cannot
 * resolve is one whose working day cannot be computed anywhere.
 */
function isKnownTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

function unprocessableTimezone(name: string) {
  return unprocessable('unknown_timezone', `"${name}" is not a timezone this server knows.`, [
    { field: 'body.timezone', code: 'unknown_timezone', message: 'Unknown timezone.' },
  ]);
}

export const settingsRoutes = [getSettingsRoute, updateSettingsRoute, publicPlansRoute];
