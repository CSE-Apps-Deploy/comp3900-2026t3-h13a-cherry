import { describe, expect, test } from 'vitest';

import { getSupportChatBadge } from '../support-chat-badges';

describe('support chat badges', () => {
  test('identifies tutor and learner requests for admins with different colors', () => {
    const tutorBadge = getSupportChatBadge({ viewerRole: 'ADMIN', requesterRole: 'TUTOR' });
    const learnerBadge = getSupportChatBadge({ viewerRole: 'ADMIN', requesterRole: 'LEARNER' });

    expect(tutorBadge).toEqual({
      label: 'Tutor',
      className: 'bg-emerald-50 text-emerald-700',
    });
    expect(learnerBadge).toEqual({
      label: 'Learner',
      className: 'bg-blue-50 text-blue-700',
    });
    expect(tutorBadge.className).not.toBe(learnerBadge.className);
  });

  test('supports system admins and uses a neutral fallback for an unknown requester', () => {
    expect(
      getSupportChatBadge({ viewerRole: 'SYSTEM_ADMIN', requesterRole: 'TUTOR' }).label
    ).toBe('Tutor');
    expect(getSupportChatBadge({ viewerRole: 'ADMIN' })).toEqual({
      label: 'Support requester',
      className: 'bg-gray-100 text-gray-600',
    });
  });

  test.each(['LEARNER', 'TUTOR'])('keeps the existing label for %s users', (viewerRole) => {
    expect(getSupportChatBadge({ viewerRole, requesterRole: viewerRole })).toEqual({
      label: 'Admin support',
      className: 'bg-blue-50 text-blue-700',
    });
  });
});
