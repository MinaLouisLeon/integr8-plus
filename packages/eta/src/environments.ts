/**
 * The ETA's environments and their base URLs (README "Environments", from the
 * SDK FAQ). Servers may override them by configuration; a company only ever
 * chooses which environment, never a URL.
 */

import type { EtaEnvironment } from '@integr8/core';

export const ETA_DEFAULT_URLS: Readonly<
  Record<EtaEnvironment, { identity: string; api: string; portal: string }>
> = Object.freeze({
  preprod: {
    identity: 'https://id.preprod.eta.gov.eg',
    api: 'https://api.preprod.invoicing.eta.gov.eg',
    portal: 'https://preprod.invoicing.eta.gov.eg',
  },
  production: {
    identity: 'https://id.eta.gov.eg',
    api: 'https://api.invoicing.eta.gov.eg',
    portal: 'https://invoicing.eta.gov.eg',
  },
});
