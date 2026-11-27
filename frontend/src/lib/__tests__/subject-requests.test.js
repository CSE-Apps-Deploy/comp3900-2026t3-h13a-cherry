import { describe, expect, test } from 'vitest';

import {
  getInitialSubjectRequestStatus,
  getSubjectRequestStatusClass,
  getSubjectRequestTabs,
  validateSubjectRequestForm,
} from '../subject-requests';

describe('subject request helpers', () => {
  test('provides the correct learner and tutor status tabs', () => {
    expect(getSubjectRequestTabs('LEARNER').map((tab) => tab.value)).toEqual([
      '',
      'OPEN',
      'ACCEPTED',
      'CANCELLED',
    ]);
    expect(getSubjectRequestTabs('TUTOR').map((tab) => tab.value)).toEqual([
      'OPEN',
      'ACCEPTED',
    ]);
    expect(getInitialSubjectRequestStatus('', 'TUTOR')).toBe('OPEN');
    expect(getInitialSubjectRequestStatus('cancelled', 'TUTOR')).toBe('OPEN');
    expect(getInitialSubjectRequestStatus('cancelled', 'LEARNER')).toBe('CANCELLED');
  });

  test('validates subject name, category, and description boundaries', () => {
    expect(
      validateSubjectRequestForm({ subjectName: 'R', category: 'Computing', description: 'Long enough.' })
    ).toContain('Subject name');
    expect(
      validateSubjectRequestForm({ subjectName: 'Rust', category: '', description: 'Long enough.' })
    ).toContain('category');
    expect(
      validateSubjectRequestForm({ subjectName: 'Rust', category: 'Computing', description: 'Short' })
    ).toContain('Description');
    expect(
      validateSubjectRequestForm({
        subjectName: 'Rust Programming',
        category: 'Computing',
        description: 'I want to understand ownership and async programming.',
      })
    ).toBeNull();
  });

  test('returns distinct visual classes for request statuses', () => {
    expect(getSubjectRequestStatusClass('OPEN')).toContain('amber');
    expect(getSubjectRequestStatusClass('ACCEPTED')).toContain('green');
    expect(getSubjectRequestStatusClass('CANCELLED')).toContain('gray');
  });
});
