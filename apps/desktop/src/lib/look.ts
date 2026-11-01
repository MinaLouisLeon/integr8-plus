import { LOOK_ATTRIBUTE, LOOK_VALUE } from '@integr8/tokens';
import { APP_FLAVOR, type AppFlavor } from './env';

/**
 * Integr8's own look on Integr8's own app (Low 3).
 *
 * The staff build is Integr8's tool, so its frame — the side menu, the top bar
 * and the sign-in screen — wears the Integr8 Media look, the same as the web
 * dashboard at `/platform`. The screens inside the frame keep the company's
 * brand, because staff use them to set that brand up and need to see it. A
 * company's own build never carries the look: it is that company's app.
 *
 * Spread onto an element: `<aside {...integr8Look()}>`.
 */
export function integr8Look(flavor: AppFlavor = APP_FLAVOR): Record<string, string> {
  return flavor === 'staff' ? { [LOOK_ATTRIBUTE]: LOOK_VALUE } : {};
}
