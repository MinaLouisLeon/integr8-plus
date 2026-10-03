import { useTranslation } from '@integr8/i18n';
import { spacing } from '@integr8/tokens';
import * as LocalAuthentication from 'expo-local-authentication';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { session } from '~/lib/session';
import { Body, Button, Heading, useTheme } from './ui';

/**
 * The app lock (P14): a phone left in a van shows nobody the customers' codes
 * and addresses.
 *
 * The app locks when it starts and when it comes back after five minutes away,
 * and opens with the phone's own biometrics — or, failing those, the phone's
 * passcode, so a cut finger or gloves never lock an engineer out of their day.
 * A phone with no screen lock at all cannot be locked this way; the settings
 * screen says so.
 *
 * The lock covers the screens rather than replacing them: what was open stays
 * open underneath, a half-filled form included, and is exactly where it was
 * once unlocked.
 */

export const LOCK_AFTER_MS = 5 * 60_000;

/** Whether the phone has anything to unlock with: a passcode, a PIN, a pattern, biometrics. */
export async function canLock(): Promise<boolean> {
  try {
    return (
      (await LocalAuthentication.getEnrolledLevelAsync()) !== LocalAuthentication.SecurityLevel.NONE
    );
  } catch {
    return false;
  }
}

export function AppLock({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const [locked, setLocked] = useState(true);
  const [checking, setChecking] = useState(true);
  const [failed, setFailed] = useState(false);
  const leftAt = useRef<number | undefined>(undefined);
  const prompting = useRef(false);

  const unlock = useCallback(async () => {
    if (prompting.current) {
      return;
    }
    prompting.current = true;
    try {
      // Not signed in, or nothing to unlock with: nothing to protect, or no way to.
      if (!(await session().isSignedIn()) || !(await canLock())) {
        setLocked(false);
        return;
      }
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: t('mobile.lock.prompt'),
        cancelLabel: t('common.cancel'),
        disableDeviceFallback: false,
      });
      setFailed(!result.success);
      setLocked(!result.success);
    } finally {
      prompting.current = false;
      setChecking(false);
    }
  }, [t]);

  useEffect(() => {
    void unlock();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        leftAt.current = Date.now();
      } else if (state === 'active' && leftAt.current !== undefined) {
        const away = Date.now() - leftAt.current;
        leftAt.current = undefined;
        if (away >= LOCK_AFTER_MS) {
          setLocked(true);
          void unlock();
        }
      }
    });
    return () => subscription.remove();
  }, [unlock]);

  return (
    <View style={styles.fill}>
      {children}
      {locked ? (
        <View
          style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: theme.background }]}
          accessibilityViewIsModal
        >
          {checking ? null : (
            <>
              <Heading>{t('mobile.lock.title')}</Heading>
              {failed ? <Body muted>{t('mobile.lock.failed')}</Body> : null}
              <Button label={t('mobile.lock.unlock')} onPress={() => void unlock()} />
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  cover: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing[4],
    paddingHorizontal: spacing[6],
  },
});
