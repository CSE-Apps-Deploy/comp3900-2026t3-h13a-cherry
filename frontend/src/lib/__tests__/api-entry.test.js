import { describe, expect, test } from 'vitest';
import { bookingApi } from '../api-entry';

describe('booking API entry', () => {
  test('exposes the post-lesson participant actions used by the booking detail page', () => {
    expect(bookingApi.markNotCompleted).toBeTypeOf('function');
    expect(bookingApi.confirmCompletion).toBeTypeOf('function');
    expect(bookingApi.disputeCompletion).toBeTypeOf('function');
  });
});
