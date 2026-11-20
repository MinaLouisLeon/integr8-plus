import { z } from 'zod';
import { defineRoute, noSchema } from '../../../http/routes.js';

/**
 * The staff apps' downloads, for the staff app's Downloads screen (P42): the
 * staff desktop app, Integr8 Forms for AI and the developer MCP server (P43),
 * which also reads this to update itself, signed in with a session limited to
 * test companies.
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

const devMcpDownloadSchema = z.object({
  name: z.string(),
  url: z.string(),
  platform: z.enum(['windows', 'macos', 'linux']),
  arch: z.enum(['x64', 'arm64']),
  kind: z.enum(['zip', 'program', 'keyring']),
  size: z.number().int().nullable(),
  checksumUrl: z.string().nullable(),
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
  devMcp: lookupSchema(
    z.object({
      tag: z.string(),
      version: z.string(),
      downloads: z.array(devMcpDownloadSchema),
      /** Integr8's signed list of the release's files and its signature (SEC-004); null without one. */
      signedList: z.object({ manifestUrl: z.string(), signatureUrl: z.string() }).nullable(),
    }),
  ),
});

export const platformDownloadsRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/downloads',
  operationId: 'getPlatformDownloads',
  summary:
    'The staff app, Integr8 Forms for AI and the developer MCP server, newest release of each',
  description:
    'Read from the GitHub releases this deployment is set to (`APP_RELEASES=github`). `devMcp` (P43) lists the developer program’s first download (`zip`) and the files an installed program updates itself with (`program`, `keyring`), each with its checksum, and `signedList`, Integr8’s signed list of the release’s hashes that an installed program checks before it updates itself (SEC-004); a staff session limited to test companies may read it. Each is `found` with its files, `none` when nothing is published (or releases are not read here), or `unavailable` when GitHub could not be asked.',
  tags: ['platform'],
  security: 'platform',
  platformScopes: ['full', 'test_companies'],
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
