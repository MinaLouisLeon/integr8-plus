import { readFileSync } from 'node:fs';
import type { EtaEnvironment } from '@integr8/core';
import type { EtaSettings } from '@integr8/db';
import { ETA_DEFAULT_URLS } from '@integr8/eta';
import {
  createNodeTransport,
  EtaClient,
  type EtaEndpoints,
  EtaTokenCache,
  type EtaTransport,
} from '@integr8/eta/node';
import type { ApiConfig } from '../config.js';
import { etaKey, openCredential } from './credentials.js';

/**
 * What the server needs to talk to the ETA (ADR-0014): one transport per
 * environment, and the in-memory token cache.
 *
 * PreProd's transport trusts `ETA_PREPROD_CA_FILE` in addition to the system
 * store; production's never does. Neither can turn verification off. Tests
 * replace a transport with a fake; nothing in CI reaches the ETA.
 */
export interface EtaServices {
  transports: Record<EtaEnvironment, EtaTransport>;
  tokens: EtaTokenCache;
  /**
   * What is wrong with this deployment's e-invoicing settings, said at startup
   * by the API and the worker. Never a reason to refuse to start: e-invoicing
   * is off until Integr8 switches it on for a company.
   */
  problems?: readonly string[];
}

export function buildEtaServices(config: ApiConfig): EtaServices {
  const problems: string[] = [];
  let preprodCa: string | null = null;
  if (config.ETA_PREPROD_CA_FILE !== undefined) {
    try {
      preprodCa = readFileSync(config.ETA_PREPROD_CA_FILE, 'utf8');
    } catch {
      problems.push(
        `ETA_PREPROD_CA_FILE (${config.ETA_PREPROD_CA_FILE}) cannot be read; calls to PreProd trust the system's certificates only.`,
      );
    }
  }
  return {
    transports: {
      preprod: createNodeTransport({ extraCaPem: preprodCa }),
      production: createNodeTransport(),
    },
    tokens: new EtaTokenCache(),
    problems,
  };
}

export function etaEndpoints(config: ApiConfig, environment: EtaEnvironment): EtaEndpoints {
  const defaults = ETA_DEFAULT_URLS[environment];
  return environment === 'preprod'
    ? {
        identityBaseUrl: config.ETA_PREPROD_IDENTITY_URL ?? defaults.identity,
        apiBaseUrl: config.ETA_PREPROD_API_URL ?? defaults.api,
      }
    : {
        identityBaseUrl: config.ETA_PRODUCTION_IDENTITY_URL ?? defaults.identity,
        apiBaseUrl: config.ETA_PRODUCTION_API_URL ?? defaults.api,
      };
}

/** Why a client could not be made for a company. Each is a code the screens explain. */
export type EtaClientProblem =
  | 'eta_disabled'
  | 'eta_key_missing'
  | 'eta_credentials_missing'
  | 'eta_credentials_unreadable'
  | 'eta_production_disabled';

/** The token cache key: company, environment, credential version. */
export const tokenCacheKey = (tenantId: string, environment: EtaEnvironment, version: number) =>
  `${tenantId}:${environment}:${String(version)}`;

/** Forgets a company's tokens: its credentials or environment changed. */
export function forgetTokens(services: EtaServices, tenantId: string): void {
  services.tokens.invalidatePrefix(`${tenantId}:`);
}

/**
 * Whether the company's environment may be used on this deployment. A
 * company set to production is refused, not quietly sent to PreProd, while
 * `ETA_ALLOW_PRODUCTION` is off.
 */
export function environmentProblem(
  config: ApiConfig,
  environment: EtaEnvironment,
): EtaClientProblem | null {
  return environment === 'production' && !config.ETA_ALLOW_PRODUCTION
    ? 'eta_production_disabled'
    : null;
}

/**
 * A client for one company's credentials in its chosen environment. The
 * credentials are opened here, used for the token request, and kept nowhere
 * but the client object for the life of one request or job.
 */
export function openEtaClient(
  deps: { config: ApiConfig; eta: EtaServices },
  tenantId: string,
  settings: EtaSettings,
  sealed: { clientId: string; clientSecret: string; version: number } | undefined,
  options: { requireEnabled?: boolean } = {},
): { client: EtaClient } | { problem: EtaClientProblem } {
  if ((options.requireEnabled ?? true) && !settings.enabled) {
    return { problem: 'eta_disabled' };
  }
  const environment = environmentProblem(deps.config, settings.environment);
  if (environment !== null) {
    return { problem: environment };
  }
  if (deps.config.ETA_CREDENTIALS_KEY === undefined) {
    return { problem: 'eta_key_missing' };
  }
  if (sealed === undefined) {
    return { problem: 'eta_credentials_missing' };
  }
  let credentials: { clientId: string; clientSecret: string };
  try {
    const key = etaKey(deps.config.ETA_CREDENTIALS_KEY);
    credentials = {
      clientId: openCredential(sealed.clientId, key, tenantId, 'clientId'),
      clientSecret: openCredential(sealed.clientSecret, key, tenantId, 'clientSecret'),
    };
  } catch {
    // A rotated key, or a value restored into another company. Never logged.
    return { problem: 'eta_credentials_unreadable' };
  }
  return {
    client: new EtaClient({
      endpoints: etaEndpoints(deps.config, settings.environment),
      credentials,
      cacheKey: tokenCacheKey(tenantId, settings.environment, sealed.version),
      cache: deps.eta.tokens,
      transport: deps.eta.transports[settings.environment],
      onBehalfOf: settings.intermediaryFor,
      timeoutMs: deps.config.ETA_REQUEST_TIMEOUT_MS,
    }),
  };
}
