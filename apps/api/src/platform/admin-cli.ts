import {
  loadAuthConfig,
  loadSigningKey,
  loadVerificationKeys,
  PlatformSessionService,
  TokenService,
  totpCode,
} from '@integr8/auth';
import {
  closeDatabase,
  configureDatabase,
  getPlatformDataSource,
  loadDatabaseConfig,
} from '@integr8/db';
import { randomBytes } from 'node:crypto';
import { loadApiConfig } from '../config.js';

/**
 * The first super admin, and any later one, from a terminal.
 *
 * The dashboard has no self-service signup — a super admin can reach every
 * company, so nobody becomes one by filling in a form. Until this existed the
 * only code that created a platform account was the development seed, which
 * refuses to run anywhere else, so a fresh deployment had a dashboard nobody
 * could sign in to.
 *
 *   node dist/platform/admin-cli.js create <email> <display name>
 *
 * Creates the account (or finds it by address), sets a generated password and
 * enrols a second factor, then prints the password and the authenticator
 * secret exactly once. Both are shown rather than stored anywhere: the person
 * types one into a password manager and the other into an authenticator app,
 * and signs in. Changing the password afterwards ends this session of it.
 */

const USAGE = `
Usage:
  admin-cli create <email> <display name...>   Create a super admin, or reset an
                                               existing one's password and second
                                               factor, and print both once.
  admin-cli list                                Every platform account.
`.trim();

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command === undefined ? 1 : 0;
  }

  const config = loadApiConfig();
  // Only the platform half of the service graph: this never signs a customer
  // in, so it does not need the identity provider the full graph insists on.
  configureDatabase(loadDatabaseConfig(process.env));
  const authConfig = loadAuthConfig(process.env);
  const tokens = new TokenService({
    config: authConfig,
    signingKey: await loadSigningKey(authConfig),
    verificationKeys: await loadVerificationKeys(authConfig),
  });
  const sessions = new PlatformSessionService({ tokens, config: authConfig });
  const platform = getPlatformDataSource();

  try {
    switch (command) {
      case 'list': {
        const accounts = await platform.platformUsers.list();
        if (accounts.length === 0) {
          console.log('No platform accounts.');
          return 0;
        }
        for (const account of accounts) {
          const state = !account.isActive
            ? 'inactive'
            : !account.hasPassword
              ? 'needs a password'
              : account.totpEnrolledAt === null
                ? 'needs a second factor'
                : 'ready';
          console.log(`${account.email}\t${account.displayName}\t${state}`);
        }
        return 0;
      }

      case 'create': {
        const [email, ...nameParts] = rest;
        const displayName = nameParts.join(' ').trim();
        if (email === undefined || !email.includes('@') || displayName === '') {
          console.error(USAGE);
          return 1;
        }

        const existing = await platform.platformUsers.findByEmail(email);
        const account = existing ?? (await platform.platformUsers.create({ email, displayName }));

        // 192 random bits as URL-safe text: well past the policy, and nothing a
        // person would choose. They change it after the first sign-in.
        const password = randomBytes(24).toString('base64url');
        await sessions.setPassword(account.id, password);

        // Enrol and confirm in one go, with a code from the secret itself, so
        // the account is usable the moment this prints. The person adds the same
        // secret to their authenticator app; every code it produces will match.
        const enrolment = await sessions.beginTotpEnrolment(account.id);
        const confirmed = await sessions.confirmTotpEnrolment(
          account.id,
          totpCode(enrolment.secret),
        );
        if (!confirmed) {
          console.error('Could not confirm the second factor; nothing was changed.');
          return 1;
        }

        console.log(
          [
            existing === undefined
              ? `Created super admin ${account.email}.`
              : `Reset credentials for ${account.email}.`,
            '',
            'Shown once. Put the password in a password manager and add the secret to an',
            'authenticator app (scan the URI as a QR code, or type the secret).',
            '',
            `  Password:  ${password}`,
            `  Secret:    ${enrolment.secret}`,
            `  URI:       ${enrolment.uri}`,
            '',
            `Sign in at ${config.WEB_APP_URL ?? '<WEB_APP_URL>'}/platform/sign-in.`,
          ].join('\n'),
        );
        return 0;
      }

      default:
        console.error(`Unknown command "${command}".\n\n${USAGE}`);
        return 1;
    }
  } finally {
    await closeDatabase();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
