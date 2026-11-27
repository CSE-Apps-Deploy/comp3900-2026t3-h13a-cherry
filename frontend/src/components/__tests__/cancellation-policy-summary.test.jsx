import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import CancellationPolicySummary from '../CancellationPolicySummary';

describe('CancellationPolicySummary', () => {
  afterEach(cleanup);

  test('shows the full cutoff and refund conditions without truncation classes', () => {
    const { container } = render(
      <CancellationPolicySummary policy={{ cutoffHours: 48, lateRefundPercent: 50 }} />
    );

    expect(
      screen.getByText('Cancel at least 48 hours before the lesson for a full refund.')
    ).toBeTruthy();
    expect(screen.getByText('Later cancellations receive a 50% refund.')).toBeTruthy();
    expect(container.innerHTML).not.toContain('truncate');
    expect(container.innerHTML).not.toContain('line-clamp');
  });
});
