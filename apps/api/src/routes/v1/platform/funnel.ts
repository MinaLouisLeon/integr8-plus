import { getPlatformDataSource, SIGNUP_STATUSES } from '@integr8/db';
import { z } from 'zod';
import { defineRoute, noSchema } from '../../../http/routes.js';
import { iso, isoOrNull } from '../schemas.js';

/**
 * Where people give up (P18).
 *
 * P18's fourth exit criterion is *the funnel is instrumented and drop-off is
 * visible per step*, and this is the visible half. It reads `signup_events`,
 * which exists because `audit_log` could not serve: that table is tenant-scoped
 * and every step worth measuring here happens before a company exists.
 *
 * **Counted two different ways, and the screen says so.** From "asked for a
 * company" onwards each attempt has a signup id and is counted once. The page
 * steps before that have no id — nobody has identified themselves and nothing
 * should make them — so those count visits. A chart that quietly mixed the two
 * would overstate the top of the funnel and understate every drop below it.
 */

const funnelStepSchema = z.object({
  step: z.string(),
  count: z.number().int(),
});

const signupSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  companyName: z.string(),
  status: z.enum(SIGNUP_STATUSES),
  createdAt: z.iso.datetime(),
  verifiedAt: z.iso.datetime().nullable(),
  tenantId: z.uuid().nullable(),
});

export const signupFunnelRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/funnel',
  operationId: 'getSignupFunnel',
  summary: 'The signup funnel, and where it leaks',
  description:
    'Steps with how many attempts reached each, over a window. The page steps count visits and the rest count attempts; they cannot be combined into one number honestly, so they are not.',
  tags: ['platform'],
  security: 'platform',
  params: noSchema,
  query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
  body: noSchema,
  responses: {
    200: {
      description: 'The funnel and the recent signups behind it.',
      schema: z.object({
        days: z.number().int(),
        steps: z.array(funnelStepSchema),
        signups: z.array(signupSchema),
      }),
    },
  },
  handler: async ({ query }, context) => {
    void context;
    const signup = getPlatformDataSource().signup;
    const since = new Date(Date.now() - query.days * 24 * 60 * 60 * 1000);

    const [steps, recent] = await Promise.all([signup.funnel(since), signup.recent(50)]);

    return {
      status: 200,
      body: {
        days: query.days,
        steps,
        signups: recent.map((request) => ({
          id: request.id,
          email: request.email,
          companyName: request.companyName,
          status: request.status,
          createdAt: iso(request.createdAt),
          verifiedAt: isoOrNull(request.verifiedAt),
          tenantId: request.tenantId,
        })),
      },
    };
  },
});

export const funnelRoutes = [signupFunnelRoute];
