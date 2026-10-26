import { useTranslation } from '@integr8/i18n';
import { myQualifications, type WorkOrderDetail } from '@integr8/offline';
import { spacing } from '@integr8/tokens';
import { View } from 'react-native';
import { type RequirementStanding, requirementStanding } from '~/lib/qualifications';
import { useLocalQuery } from '~/local/react';
import { Badge, Body, Section } from './ui';

const TONE: Record<RequirementStanding, 'danger' | 'accent' | 'muted'> = {
  held: 'muted',
  expiring: 'accent',
  expired: 'danger',
  not_held: 'danger',
};

/**
 * What the job needs (P26), each beside whether the engineer holds it as the
 * phone last heard. Shown so they can raise a lapsed certificate before they
 * set off; the office decides who goes.
 */
export function JobQualifications({ detail }: { detail: WorkOrderDetail }) {
  const { t } = useTranslation();
  const mine = useLocalQuery('my-qualifications', ['meta'], myQualifications);
  // A job kept from before P26 says nothing about what it needs.
  const required = (detail as Partial<WorkOrderDetail>).requiredQualifications ?? [];
  if (required.length === 0) {
    return null;
  }
  const records = mine.status === 'ready' ? mine.data.items : [];

  return (
    <Section title={t('mobile.job.qualifications')}>
      {required.map((requirement) => {
        const standing = requirementStanding(requirement.qualificationTypeId, records);
        return (
          <View
            key={requirement.qualificationTypeId}
            style={{ flexDirection: 'row', alignItems: 'center', gap: spacing[2] }}
          >
            <View style={{ flex: 1 }}>
              <Body>{requirement.name}</Body>
            </View>
            <Badge
              label={t(`mobile.job.qualificationStanding.${standing}`)}
              tone={TONE[standing]}
            />
          </View>
        );
      })}
    </Section>
  );
}
