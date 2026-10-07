import { useTranslation } from '@integr8/i18n';
import { identity, openJobs, recentlyClosedJobs, searchLocal, sectionJobs } from '@integr8/offline';
import { spacing } from '@integr8/tokens';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { JobRow } from '~/components/job-row';
import { LocalGate } from '~/components/local-gate';
import { SyncBanner } from '~/components/sync-banner';
import { Today } from '~/components/today';
import {
  Body,
  Button,
  EmptyState,
  Field,
  Heading,
  Row,
  ScrollScreen,
  Section,
} from '~/components/ui';
import { useLocalQuery } from '~/local/react';

const SECTION_ORDER = ['overdue', 'today', 'upcoming', 'unscheduled'] as const;

/**
 * The engineer's day and jobs, from the phone.
 *
 * The day first (P14): clocked in or not, and the job to do next with its one
 * step forward. Then open jobs by when they are due, then what was closed in the last 30 days, and
 * a search over both and their customers. Every line of it is read from SQLite;
 * the banner says how current it is and never stands in front of it.
 */
export default function HomeScreen() {
  return (
    <LocalGate>
      <Jobs />
    </LocalGate>
  );
}

function Jobs() {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const searching = text.trim() !== '';

  const me = useLocalQuery('identity', ['meta'], identity);
  const open = useLocalQuery('open', ['work_orders', 'sites'], openJobs);
  const closed = useLocalQuery('closed', ['work_orders', 'sites'], (sql) =>
    recentlyClosedJobs(sql),
  );
  const results = useLocalQuery(`search:${text}`, ['work_orders', 'customers', 'sites'], (sql) =>
    searchLocal(sql, text),
  );

  const person = me.status === 'ready' ? me.data : undefined;
  const sections = sectionJobs(open.status === 'ready' ? open.data : [], new Date());

  return (
    <ScrollScreen>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[3] }}>
        <View style={{ flex: 1, gap: spacing[1] }}>
          {person === undefined || person.company.name === '' ? null : (
            <Body muted>{person.company.name}</Body>
          )}
          <Heading>{t('mobile.jobs.title')}</Heading>
          {person === undefined ? null : <Body muted>{person.displayName}</Body>}
        </View>
        <Button
          label={t('mobile.jobs.settings')}
          variant="secondary"
          onPress={() => router.push('/settings')}
        />
      </View>

      <SyncBanner />

      {searching || open.status !== 'ready' ? null : <Today open={open.data} />}

      <Field
        label={t('mobile.jobs.searchLabel')}
        placeholder={t('mobile.jobs.searchPlaceholder')}
        value={text}
        onChangeText={setText}
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="while-editing"
      />

      {searching ? (
        results.status !== 'ready' ? null : results.data.workOrders.length === 0 &&
          results.data.customers.length === 0 ? (
          <Body muted>{t('mobile.jobs.noResults', { text: text.trim() })}</Body>
        ) : (
          <>
            {results.data.workOrders.length === 0 ? null : (
              <Section title={t('mobile.jobs.jobs')}>
                {results.data.workOrders.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </Section>
            )}
            {results.data.customers.length === 0 ? null : (
              <Section title={t('mobile.jobs.customers')}>
                {results.data.customers.map((customer) => (
                  <Row
                    key={customer.id}
                    title={customer.name}
                    lines={[customer.accountNumber ?? '', customer.addressText]}
                    onPress={() =>
                      router.push({ pathname: '/customers/[id]', params: { id: customer.id } })
                    }
                  />
                ))}
              </Section>
            )}
          </>
        )
      ) : open.status !== 'ready' || closed.status !== 'ready' ? null : open.data.length === 0 &&
        closed.data.length === 0 ? (
        <EmptyState title={t('mobile.jobs.empty')} body="" />
      ) : (
        <>
          {SECTION_ORDER.map((section) =>
            sections[section].length === 0 ? null : (
              <Section key={section} title={t(`mobile.jobs.${section}`)}>
                {sections[section].map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </Section>
            ),
          )}
          {closed.data.length === 0 ? null : (
            <Section title={t('mobile.jobs.recentlyClosed')}>
              {closed.data.map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </Section>
          )}
        </>
      )}
    </ScrollScreen>
  );
}
