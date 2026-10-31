import {
  loadAuthConfig,
  loadSigningKey,
  loadVerificationKeys,
  PlatformSessionService,
  SessionService,
  SupabaseIdentityProvider,
  TokenService,
  totpCode,
  type VerifiedIdentity,
} from '@integr8/auth';
import {
  closeDatabase,
  configureDatabase,
  getPlatformDataSource,
  loadDatabaseConfig,
} from '@integr8/db';
import { randomBytes } from 'node:crypto';
import { loadApiConfig, supabaseAuthSettings } from '../config.js';

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
 *
 * An account this command makes is a staff manager: the only kind that can add
 * and remove people on the dashboard's Staff screen. Running `create` for an
 * address the dashboard added makes that account a manager too, and brings a
 * removed account back — whoever has this terminal decides who manages staff.
 *
 *   node dist/platform/admin-cli.js remove <email>
 *
 * Takes any account off the staff, terminal-made ones included, which the
 * dashboard cannot do. It ends every session the account has.
 *
 *   node dist/platform/admin-cli.js user-password <email>
 *
 * For company people (P36): gives the address a new generated password in the
 * self-hosted Supabase Auth container and prints it once, then signs out every
 * device they were signed in on. The way back in for somebody who cannot
 * receive the emailed sign-in code. An address with no account gets one, as
 * long as it is not already a member somewhere (a member always has one). The
 * person still needs a membership to get into a company (an invitation, or
 * onboarding); this only sets what they type.
 */

const USAGE = `
Usage:
  admin-cli create <email> <display name...>   Create a super admin who can manage
                                               staff, or reset an existing one's
                                               password and second factor, and
                                               print both once.
  admin-cli remove <email>                      Take an account off the staff and
                                               end its sessions.
  admin-cli list                                Every platform account.
  admin-cli user-password <email>               Give a company person a new
                                               password in the Auth container,
                                               print it once, and sign out their
                                               devices.
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
          const kind = account.canManageStaff ? 'staff manager' : 'staff';
          console.log(`${account.email}\t${account.displayName}\t${kind}\t${state}`);
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
        const account =
          existing ??
          (await platform.platformUsers.create({ email, displayName, canManageStaff: true }));
        if (existing !== undefined) {
          await platform.platformUsers.setCanManageStaff(account.id, true);
          await platform.platformUsers.reactivate(account.id, null);
        }

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

      case 'remove': {
        const [email] = rest;
        if (!email?.includes('@')) {
          console.error(USAGE);
          return 1;
        }
        const account = await platform.platformUsers.findByEmail(email);
        if (account === undefined) {
          console.error(`No platform account ${email}.`);
          return 1;
        }

        const now = new Date();
        await platform.platformUsers.setActive(account.id, false);
        const ended = await platform.platformSessions.revokeAllFor(
          account.id,
          'account_disabled',
          now,
        );
        await platform.platformUsers.endLiveImpersonations(account.id, now);
        await platform.platformAudit.append({
          platformUserId: null,
          actorLabel: 'terminal',
          action: 'staff.removed',
          targetKind: 'platform_user',
          targetId: account.id,
          metadata: { email: account.email, sessions: ended },
        });
        console.log(`Removed ${account.email}; ended ${ended} session(s).`);
        return 0;
      }

      case 'user-password': {
        const [email] = rest;
        if (!email?.includes('@')) {
          console.error(USAGE);
          return 1;
        }
        const auth = supabaseAuthSettings(process.env);
        if ('problems' in auth) {
          console.error(['The Auth container is not configured:', ...auth.problems].join('\n  '));
          return 1;
        }
        const identity = new SupabaseIdentityProvider(auth.settings);
        const address = email.trim().toLowerCase();
        const password = randomBytes(18).toString('base64url');

        const existing = await identity.findByEmail(address);
        let userId: VerifiedIdentity['userId'];
        if (existing === undefined) {
          // A member's id is the one their companies name; a new account would
          // get another and open none of them. Members always have an account,
          // so this only means the account was lost: say so rather than guess.
          if ((await platform.tenants.memberUserIdsByEmail(address)).length > 0) {
            console.error(
              `${address} is a member of a company but has no sign-in account. Nothing was changed; ask a developer.`,
            );
            return 1;
          }
          userId = (await identity.createIdentity(address, password)).userId;
        } else {
          await identity.setPassword(existing.userId, password);
          userId = existing.userId;
        }

        // Every device signed in with the old password, in every company.
        const people = new SessionService({ tokens, config: authConfig });
        let signedOut = 0;
        for (const tenantId of await platform.tenants.withLiveSessionsFor(userId)) {
          signedOut += await people.revokeAllForUser(tenantId, userId, 'password_changed');
        }

        console.log(
          [
            existing === undefined
              ? `Created a sign-in for ${address}.`
              : `Set a new password for ${address}; ${String(signedOut)} device(s) signed out.`,
            '',
            'Shown once. Send it privately; they sign in with it at',
            `${config.WEB_APP_URL ?? '<WEB_APP_URL>'}/sign-in, then choose Change password.`,
            '',
            `  Password:  ${password}`,
            '',
            existing === undefined
              ? 'If they are not in a company yet, invite this address from the company, or onboard a company with it as the owner.'
              : '',
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
