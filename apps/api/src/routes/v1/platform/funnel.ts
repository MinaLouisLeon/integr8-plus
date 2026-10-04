import { getPlatformDataSource, SIGNUP_STATUSES } from '@integr8/db';
import { z } from 'zod';
import { defineRoute, noSchema } from '../../../http/routes.js';
import { SIGNUP_STEPS } from '../../../signup/service.js';
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
 *
 * **Landing to first form** is the second exit criterion, and it is measured
 * here from the earliest moment that can be tied to a company — the company
 * coming to exist — to its first `submitted_at`. Page views before that have
 * no id and are not guessed at. The response carries company ids and seconds,
 * never an address: the funnel's no-personal-data promise holds for this too.
 */

const funnelStepSchema = z.object({
  step: z.string(),
  count: z.number().int(),
});

const timeToFirstFormSchema = z.object({
  /** How many companies created in the window have submitted a form at all. */
  companies: z.number().int(),
  /** Null until one company has been measured. */
  medianSeconds: z.number().nullable(),
  items: z.array(z.object({ tenantId: z.uuid(), seconds: z.number() })),
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
        timeToFirstForm: timeToFirstFormSchema,
        signups: z.array(signupSchema),
      }),
    },
  },
  handler: async ({ query }, context) => {
    void context;
    const { signup, insights } = getPlatformDataSource();
    const since = new Date(Date.now() - query.days * 24 * 60 * 60 * 1000);

    const [steps, recent, timings] = await Promise.all([
      signup.funnel(since),
      signup.recent(50),
      insights.timeToFirstSubmission({
        since,
        provisionedStep: SIGNUP_STEPS.provisioned,
        startedStep: SIGNUP_STEPS.started,
      }),
    ]);

    return {
      status: 200,
      body: {
        days: query.days,
        steps,
        timeToFirstForm: {
          companies: timings.length,
          medianSeconds: median(timings.map((timing) => timing.seconds)),
          items: timings,
        },
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

/**
 * The middle value, or null when there is nothing to take the middle of.
 *
 * A median rather than a mean, because the first few companies will include
 * one that signed up on a Friday and filled in a form on Monday, and a mean
 * would let that one decide the number for everybody.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) {
    return upper;
  }
  return ((sorted[middle - 1] ?? 0) + upper) / 2;
}

export const funnelRoutes = [signupFunnelRoute];
