import { useTranslation } from '@integr8/i18n';
import { addressText, customer } from '@integr8/offline';
import { spacing } from '@integr8/tokens';
import { router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { JobRow } from '~/components/job-row';
import { LocalGate } from '~/components/local-gate';
import {
  Body,
  Button,
  EmptyState,
  Heading,
  NotReadyScreen,
  Row,
  ScrollScreen,
  Section,
} from '~/components/ui';
import { useLocalQuery } from '~/local/react';

/** A customer, as far as this phone knows them: contacts, sites, and the jobs downloaded for them. */
export default function CustomerScreen() {
  return (
    <LocalGate>
      <Customer />
    </LocalGate>
  );
}

function Customer() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const state = useLocalQuery(`customer:${id}`, ['customers', 'sites', 'work_orders'], (sql) =>
    customer(sql, id),
  );

  if (state.status !== 'ready') {
    return <NotReadyScreen failed={state.status === 'error'} />;
  }
  if (state.data === undefined) {
    return (
      <ScrollScreen>
        <Button label={t('mobile.back')} variant="secondary" onPress={() => router.back()} />
        <EmptyState title={t('mobile.customer.notOnPhone')} body="" />
      </ScrollScreen>
    );
  }

  const { customer: body, contacts, sites, jobs } = state.data;

  return (
    <ScrollScreen>
      <View style={{ alignItems: 'flex-start' }}>
        <Button label={t('mobile.back')} variant="secondary" onPress={() => router.back()} />
      </View>

      <View style={{ gap: spacing[1] }}>
        <Heading>{body.name}</Heading>
        {body.accountNumber === null ? null : (
          <Body muted>{t('mobile.customer.account', { number: body.accountNumber })}</Body>
        )}
        <Body muted>{t(`operations.customers.status.${body.status}`)}</Body>
        {body.phone === null ? null : <Body>{body.phone}</Body>}
        {body.email === null ? null : <Body>{body.email}</Body>}
        <Body>{addressText(body.address)}</Body>
      </View>

      {contacts.length === 0 ? null : (
        <Section title={t('mobile.customer.contacts')}>
          {contacts.map((contact) => (
            <Row
              key={contact.id}
              title={contact.name}
              lines={[contact.jobTitle ?? '', contact.phone ?? '', contact.email ?? '']}
              tag={
                contact.isPrimary
                  ? { label: t('mobile.customer.primary'), tone: 'muted' }
                  : undefined
              }
            />
          ))}
        </Section>
      )}

      {sites.length === 0 ? null : (
        <Section title={t('mobile.customer.sites')}>
          {sites.map((site) => (
            <Row
              key={site.id}
              title={site.name}
              lines={[site.addressText]}
              tag={
                site.hazards
                  ? { label: `⚠ ${t('mobile.jobs.hazards')}`, tone: 'danger' }
                  : undefined
              }
              onPress={() => router.push({ pathname: '/sites/[id]', params: { id: site.id } })}
            />
          ))}
        </Section>
      )}

      {jobs.length === 0 ? null : (
        <Section title={t('mobile.customer.jobs')}>
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </Section>
      )}
    </ScrollScreen>
  );
}
