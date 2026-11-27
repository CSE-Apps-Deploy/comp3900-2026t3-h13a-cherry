import { describe, test, expect } from 'vitest';
import { getSessionLinkState } from '../session-links';

const lesson = {
    status: 'ACCEPTED',
    policy: { joinEarlyMinutes: 15, missingLinkWarningHours: 24 },
    scheduledAt: '2026-10-12T10:00:00Z',
    duration: 60,
    meetingLink: 'https://meet.google.com/abc-defg-hij',
};
describe('LNK-01 meeting entry', () => {
    test('opens at the agreed 15-minute boundary and closes at lesson end', () => {
        expect(getSessionLinkState(lesson, new Date('2026-10-12T09:44:59Z')).canJoin).toBe(false);
        expect(getSessionLinkState(lesson, new Date('2026-10-12T09:45:00Z')).canJoin).toBe(true);
        expect(getSessionLinkState(lesson, new Date('2026-10-12T11:00:00Z')).canJoin).toBe(false);
    });
    test('warns when an accepted lesson starts within 24 hours without a link', () => {
        const noLink = { ...lesson, meetingLink: null };
        expect(
            getSessionLinkState(noLink, new Date('2026-10-11T09:59:59Z')).missingLinkWarning
        ).toBe(false);
        expect(
            getSessionLinkState(noLink, new Date('2026-10-11T10:00:00Z')).missingLinkWarning
        ).toBe(true);
    });
});

test('joining and missing-link boundaries follow the policy returned by the server', () => {
    const changed = { ...lesson, policy: { joinEarlyMinutes: 5, missingLinkWarningHours: 12 } };
    expect(getSessionLinkState(changed, new Date('2026-10-12T09:45:00Z')).canJoin).toBe(false);
    expect(getSessionLinkState(changed, new Date('2026-10-12T09:55:00Z')).canJoin).toBe(true);
    expect(
        getSessionLinkState({ ...changed, meetingLink: null }, new Date('2026-10-11T10:00:00Z'))
            .missingLinkWarning
    ).toBe(false);
    expect(
        getSessionLinkState({ ...changed, meetingLink: null }, new Date('2026-10-11T22:00:00Z'))
            .missingLinkWarning
    ).toBe(true);
});
