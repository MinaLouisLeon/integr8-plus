import { randomBytes } from 'node:crypto';
import { generateSigningKeyPair } from './keys.js';
import {
  generateAuthDbPassword,
  generateAuthJwtSecret,
  mintServiceRoleKey,
} from './supabase-auth-keys.js';

/**
 * Generates a signing key pair and prints the three environment variables that
 * carry it, the platform secret key, and the three secrets the self-hosted
 * Supabase Auth container needs.
 *
 * Run once per environment, and again for a rotation — for which the published
 * verification list holds both keys until every token signed by the old one has
 * expired. With a seven-day offline grant, that is seven days.
 *
 *   pnpm --filter @integr8/auth keygen
 */
async function main(): Promise<void> {
  const { kid, privateJwk, publicJwk } = await generateSigningKeyPair();

  console.log(`# Ed25519 signing key "${kid}", generated ${new Date().toISOString()}`);
  console.log('#');
  console.log('# AUTH_SIGNING_KEY is a private key. It belongs in a secret manager and');
  console.log('# never in git — gitleaks runs on this repository and will say so.');
  console.log('#');
  console.log('# AUTH_VERIFICATION_KEYS is public. It is served at the JWKS endpoint and');
  console.log('# embedded in the mobile app so an offline grant can be verified with no');
  console.log('# network. To rotate: add the new public key here, deploy everywhere, then');
  console.log('# switch AUTH_SIGNING_KEY and AUTH_SIGNING_KEY_ID, and only remove the old');
  console.log('# public key once every token it signed has expired.');
  console.log('');
  console.log(`AUTH_SIGNING_KEY_ID=${kid}`);
  console.log(`AUTH_SIGNING_KEY=${JSON.stringify(privateJwk)}`);
  console.log(`AUTH_VERIFICATION_KEYS=${JSON.stringify([publicJwk])}`);
  console.log('');
  console.log('# PLATFORM_SECRET_KEY encrypts super admins’ second-factor secrets at rest');
  console.log('# (P15). Rotating it makes every enrolled second factor unreadable, so every');
  console.log('# super admin has to enrol again — plan it, do not do it casually.');
  console.log(`PLATFORM_SECRET_KEY=${randomBytes(32).toString('base64')}`);
  console.log('');

  const jwtSecret = generateAuthJwtSecret();
  console.log('# The self-hosted Supabase Auth container (P36). Generated together: the');
  console.log('# service role key is signed with the JWT secret, so a new secret needs a new');
  console.log('# key, and changing the secret signs nobody out — Auth holds no sessions here.');
  console.log('#');
  console.log('# SUPABASE_AUTH_JWT_SECRET goes to the auth container only.');
  console.log('# SUPABASE_SERVICE_ROLE_KEY goes to the API and worker only.');
  console.log('# SUPABASE_AUTH_DB_PASSWORD is the supabase_auth_admin database password.');
  console.log(`SUPABASE_AUTH_JWT_SECRET=${jwtSecret}`);
  console.log(`SUPABASE_SERVICE_ROLE_KEY=${await mintServiceRoleKey(jwtSecret)}`);
  console.log(`SUPABASE_AUTH_DB_PASSWORD=${generateAuthDbPassword()}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
