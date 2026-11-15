import { z } from 'zod';
import { defineRoute, noSchema } from '../../../http/routes.js';

/**
 * The staff apps' downloads, for the staff app's Downloads screen (P42): the
 * staff desktop app and Integr8 Forms for AI.
 *
 * Before P42 the web dashboard asked its own server for these. The list is
 * read from GitHub releases (`APP_RELEASES`); the file links themselves stay
 * plain links, through the public site for a private repository, because the
 * staff app's updater needs them without a sign-in.
 */

const installerSchema = z.object({
  name: z.string(),
  url: z.string(),
  platform: z.enum(['windows', 'macos', 'linux', 'android']),
  kind: z.enum(['exe', 'msi', 'dmg', 'appimage', 'deb', 'rpm', 'apk']),
  arch: z.enum(['x64', 'arm64', 'universal']).nullable(),
  size: z.number().int().nullable(),
});

const formsAiDownloadSchema = z.object({
  name: z.string(),
  url: z.string(),
  platform: z.enum(['windows', 'macos', 'linux']),
  arch: z.enum(['x64', 'arm64']),
  size: z.number().int().nullable(),
});

/** `none`: nothing published (or no releases read here); `unavailable`: GitHub did not answer. */
const lookupSchema = <T extends z.ZodType>(release: T) =>
  z.discriminatedUnion('status', [
    z.object({ status: z.literal('found'), release }),
    z.object({ status: z.literal('none') }),
    z.object({ status: z.literal('unavailable') }),
  ]);

const downloadsSchema = z.object({
  staff: lookupSchema(
    z.object({ tag: z.string(), version: z.string(), installers: z.array(installerSchema) }),
  ),
  formsAi: lookupSchema(
    z.object({ tag: z.string(), version: z.string(), downloads: z.array(formsAiDownloadSchema) }),
  ),
});

export const platformDownloadsRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/downloads',
  operationId: 'getPlatformDownloads',
  summary: 'The staff app and Integr8 Forms for AI, newest release of each',
  description:
    'Read from the GitHub releases this deployment is set to (`APP_RELEASES=github`). Each is `found` with its files, `none` when nothing is published (or releases are not read here), or `unavailable` when GitHub could not be asked.',
  tags: ['platform'],
  security: 'platform',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'What can be downloaded.', schema: downloadsSchema },
  },
  handler: async (_input, context) => ({
    status: 200,
    body: await context.services.appReleases.staffDownloads(),
  }),
});

export const platformDownloadsRoutes = [platformDownloadsRoute];
