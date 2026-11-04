import { isSwitchableSection, shownTabs, tabChoice, toTenantId } from '@integr8/core';
import { getPlatformDataSource, withTenant } from '@integr8/db';
import { forgetTenantFeatures } from '../http/features.js';
import { unprocessable } from '../http/errors.js';

/**
 * Which tabs a company sees, as Integr8 staff choose them (0075).
 *
 * Staff pick tabs, not modules: every switchable tab left out is hidden, and a
 * module with tabs follows them — on with any of its tabs, off with none (see
 * `tabChoice` in `@integr8/core`). The company's people never see these
 * switches. Hiding a tab is presentation; the module switches still guard the
 * data on the server, so turning a module off this way is the real block.
 */

/** Refuses a key that is not a tab staff may switch, naming it. */
export function assertKnownTabs(tabs: readonly string[]): void {
  const unknown = tabs.filter((key) => !isSwitchableSection(key));
  if (unknown.length > 0) {
    throw unprocessable('unknown_tab', 'These are not tabs that can be switched.', [
      { field: 'body.tabs', code: 'unknown_tab', message: unknown.join(', ') },
    ]);
  }
}

export interface AppliedTabs {
  /** The tabs the company now sees. */
  tabs: string[];
  hidden: string[];
  /** Each module's override, as just written. */
  modules: Record<string, boolean>;
}

/** Writes the hidden tabs and the module overrides that follow from `tabs`. */
export async function applyTabChoice(
  tenantId: string,
  tabs: readonly string[],
  by: string,
): Promise<AppliedTabs> {
  assertKnownTabs(tabs);
  const choice = tabChoice(tabs);
  await withTenant(toTenantId(tenantId), (tx) =>
    tx.settings.update({ hiddenNavSections: choice.hidden }),
  );
  const platform = getPlatformDataSource().settings;
  const modules: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(choice.modules)) {
    await platform.setFlag({ tenantId, key, enabled, updatedBy: by });
    modules[key] = enabled;
  }
  // The company sees the change on its next request, not after the cache's TTL.
  forgetTenantFeatures(tenantId);
  const flags = await platform.flagsFor(tenantId);
  return { tabs: shownTabs(choice.hidden, flags), hidden: choice.hidden, modules };
}
