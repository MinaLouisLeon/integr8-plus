import { describe, expect, it } from 'vitest';
import { accessChanges, accessDraft } from './access-edit';

const current = {
  gateCode: '4471#',
  parking: 'Visitor bays at the rear',
  askFor: null,
  hazards: 'Asbestos in the plant room',
  notes: null,
};

describe('correcting access notes', () => {
  it('starts from what the phone has, none as empty', () => {
    expect(accessDraft(current)).toEqual({
      gateCode: '4471#',
      parking: 'Visitor bays at the rear',
      askFor: '',
      hazards: 'Asbestos in the plant room',
      notes: '',
    });
  });

  it('sends only what changed, trimmed', () => {
    const draft = { ...accessDraft(current), gateCode: ' 9090# ', askFor: 'Pat' };
    expect(accessChanges(current, draft)).toEqual({ gateCode: '9090#', askFor: 'Pat' });
  });

  it('sends an emptied field as none, and nothing when only spaces were added', () => {
    const draft = {
      ...accessDraft(current),
      parking: '   ',
      hazards: 'Asbestos in the plant room ',
    };
    expect(accessChanges(current, draft)).toEqual({ parking: null });
    expect(accessChanges(current, accessDraft(current))).toEqual({});
  });
});
