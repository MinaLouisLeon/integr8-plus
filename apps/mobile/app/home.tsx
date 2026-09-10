import { ApiRequestError } from '@integr8/api-client';
import { useTranslation } from '@integr8/i18n';
import { spacing } from '@integr8/tokens';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { View } from 'react-native';
import { Body, Button, ErrorState, Heading, LoadingState, Screen } from '~/components/ui';
import { session } from '~/lib/session';

/**
 * The home screen.
 *
 * Shows who is signed in and which company they are in — P05's first exit
 * criterion, and the proof that the whole chain works on a phone: SecureStore,
 * refresh, the generated client, the tenant-scoped API, translated copy and a
 * mirrored layout.
 */
export default function HomeScreen() {
  const { t } = useTranslation();

  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const { data } = await session().client.GET('/v1/me');
      return data;
    },
  });

  if (me.isPending) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  if (me.isError) {
    return (
      <Screen>
        <ErrorState
          requestId={me.error instanceof ApiRequestError ? me.error.requestId : undefined}
          onRetry={() => void me.refetch()}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Heading>{t('workspace.signedInAs', { name: me.data?.displayName ?? '' })}</Heading>

      <View style={{ gap: spacing[2] }}>
        <Body muted>{t('workspace.company')}</Body>
        <Body>{me.data?.tenantId}</Body>
        <Body muted>{t('auth.email')}</Body>
        <Body>{me.data?.email}</Body>
      </View>

      <Button
        label={t('common.signOut')}
        variant="secondary"
        onPress={() => {
          void (async () => {
            await session().signOut();
            router.replace('/sign-in');
          })();
        }}
      />
    </Screen>
  );
}
