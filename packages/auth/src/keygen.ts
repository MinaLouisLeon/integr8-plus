import { generateSigningKeyPair } from './keys.js';

/**
 * Generates a signing key pair and prints the three environment variables that
 * carry it.
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
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
