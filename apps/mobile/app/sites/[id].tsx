import { useTranslation } from '@integr8/i18n';
import { spacing } from '@integr8/tokens';
import { router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { AccessNotes } from '~/components/access-notes';
import { JobRow } from '~/components/job-row';
import { LocalGate } from '~/components/local-gate';
import { Body, Button, EmptyState, Heading, Row, ScrollScreen, Section } from '~/components/ui';
import { addressText } from '~/local/snapshot';
import { site } from '~/local/queries';
import { useLocalQuery } from '~/local/react';

/** A site, from the phone. Access notes first, as on a job. */
export default function SiteScreen() {
  return (
    <LocalGate>
      <Site />
    </LocalGate>
  );
}

function Site() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useLocalQuery(`site:${id}`, ['sites', 'customers', 'work_orders'], (sql) =>
    site(sql, id),
  );

  if (state.status !== 'ready') {
    return <ScrollScreen>{null}</ScrollScreen>;
  }
  if (state.data === undefined) {
    return (
      <ScrollScreen>
        <Button label={t('mobile.back')} variant="secondary" onPress={() => router.back()} />
        <EmptyState title={t('mobile.site.notOnPhone')} body="" />
      </ScrollScreen>
    );
  }

  const { site: body, customer, contact, jobs } = state.data;

  return (
    <ScrollScreen>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label={t('mobile.back')} variant="secondary" onPress={() => router.back()} />
      </View>

      <AccessNotes access={body.access} />

      <View style={{ gap: spacing[1] }}>
        <Heading>{body.name}</Heading>
        <Body>{addressText(body.address)}</Body>
      </View>

      <Section title={t('mobile.site.customer')}>
        <Row
          title={customer.name}
          onPress={() => router.push({ pathname: '/customers/[id]', params: { id: customer.id } })}
        />
      </Section>

      {contact === null ? null : (
        <Section title={t('mobile.site.contact')}>
          <Row
            title={contact.name}
            lines={[contact.jobTitle ?? '', contact.phone ?? '', contact.email ?? '']}
          />
        </Section>
      )}

      {jobs.length === 0 ? null : (
        <Section title={t('mobile.site.jobs')}>
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </Section>
      )}
    </ScrollScreen>
  );
}
