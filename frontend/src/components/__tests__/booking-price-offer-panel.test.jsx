import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import BookingPriceOfferPanel from '../BookingPriceOfferPanel';

const makeBooking = (overrides = {}) => ({
  id: 'booking-1',
  status: 'PENDING',
  version: 3,
  totalAmount: 100,
  currency: 'AUD',
  isTrialLesson: false,
  earningPreview: {
    currency: 'AUD',
    grossAmount: '100.00',
    commissionPercent: '15.00',
    commissionAmount: '15.00',
    netAmount: '85.00',
  },
  priceOffers: [],
  availableActions: {},
  ...overrides,
});

const makePendingOffer = (overrides = {}) => ({
  id: 'offer-1',
  bookingId: 'booking-1',
  originalTotal: 100,
  proposedTotal: 80,
  currency: 'AUD',
  reason: 'Loyalty discount',
  status: 'PENDING',
  createdAt: '2026-07-21T00:00:00.000Z',
  respondedAt: null,
  withdrawnAt: null,
  ...overrides,
});

describe('BookingPriceOfferPanel', () => {
  afterEach(cleanup);

  test('lets a tutor propose a positive, different price with an optional reason', () => {
    const onPropose = vi.fn();
    render(
      <BookingPriceOfferPanel
        booking={makeBooking({
          availableActions: { canProposePriceOffer: true },
        })}
        isTutor
        onPropose={onPropose}
      />
    );

    fireEvent.change(screen.getByLabelText('New lesson price (AUD)'), {
      target: { value: '82.50' },
    });
    fireEvent.change(screen.getByLabelText('Reason (optional)'), {
      target: { value: '  Loyalty discount  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send price offer' }));

    expect(onPropose).toHaveBeenCalledWith({
      proposedTotal: 82.5,
      reason: 'Loyalty discount',
    });
  });

  test('validates that the tutor changes the current price', () => {
    const onPropose = vi.fn();
    render(
      <BookingPriceOfferPanel
        booking={makeBooking({
          availableActions: { canProposePriceOffer: true },
        })}
        isTutor
        onPropose={onPropose}
      />
    );

    fireEvent.change(screen.getByLabelText('New lesson price (AUD)'), {
      target: { value: '100.00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send price offer' }));

    expect(screen.getByRole('alert').textContent).toMatch(/must be different/i);
    expect(onPropose).not.toHaveBeenCalled();
  });

  test('shows the 15 percent cut and expected net before a tutor reprices', () => {
    render(
      <BookingPriceOfferPanel
        booking={makeBooking({
          availableActions: { canProposePriceOffer: true },
        })}
        isTutor
      />
    );

    expect(screen.getByText('Current earnings')).toBeTruthy();
    expect(screen.getByText(/TutorConnect commission \(15%\)/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('New lesson price (AUD)'), {
      target: { value: '80.00' },
    });

    expect(screen.getByText('Earnings at this proposed price')).toBeTruthy();
    expect(screen.getByText(/to you/).textContent).toContain('$68.00');
  });

  test('lets the tutor propose another adjustment from the currently accepted price', () => {
    const onPropose = vi.fn();
    render(
      <BookingPriceOfferPanel
        booking={makeBooking({
          totalAmount: 80,
          priceOffers: [makePendingOffer({ status: 'ACCEPTED', proposedTotal: 80 })],
          availableActions: { canProposePriceOffer: true },
        })}
        isTutor
        onPropose={onPropose}
      />
    );

    expect(screen.getByText('Current price: $80.00')).toBeTruthy();
    expect(screen.getByText('Current price')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('New lesson price (AUD)'), {
      target: { value: '80.00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send price offer' }));
    expect(screen.getByRole('alert').textContent).toMatch(/must be different/i);
    expect(onPropose).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('New lesson price (AUD)'), {
      target: { value: '90.00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send price offer' }));
    expect(onPropose).toHaveBeenCalledWith({ proposedTotal: 90 });
  });

  test('shows a lower offer exactly and lets the learner accept or reject it', () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    render(
      <BookingPriceOfferPanel
        booking={makeBooking({
          priceOffers: [makePendingOffer()],
          availableActions: { canRespondPriceOffer: true },
        })}
        isLearner
        seriesTotal={300}
        onAccept={onAccept}
        onReject={onReject}
      />
    );

    expect(screen.getByText('Current price')).toBeTruthy();
    expect(screen.getByText('$100.00')).toBeTruthy();
    expect(screen.getByText('Proposed price')).toBeTruthy();
    expect(screen.getByText('$80.00')).toBeTruthy();
    expect(screen.getByText('Decrease')).toBeTruthy();
    expect(screen.getByText('−$20.00')).toBeTruthy();
    expect(screen.getByText('Series total if accepted: $280.00')).toBeTruthy();
    expect(screen.getByText('Your response needed')).toBeTruthy();
    expect(screen.getByText(/loyalty discount/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Accept new price' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep current price' }));

    expect(onAccept).toHaveBeenCalledWith('offer-1');
    expect(onReject).toHaveBeenCalledWith('offer-1');
  });

  test('clearly labels a higher proposed price and its positive difference', () => {
    render(
      <BookingPriceOfferPanel
        booking={makeBooking({
          priceOffers: [makePendingOffer({ proposedTotal: 125, reason: null })],
          availableActions: { canRespondPriceOffer: true },
        })}
        isLearner
      />
    );

    expect(screen.getByText('$125.00')).toBeTruthy();
    expect(screen.getByText('Increase')).toBeTruthy();
    expect(screen.getByText('+$25.00')).toBeTruthy();
  });

  test('keeps the previous accepted price current while a replacement awaits a response', () => {
    render(
      <BookingPriceOfferPanel
        booking={makeBooking({
          totalAmount: 80,
          priceOffers: [
            makePendingOffer({
              id: 'offer-2',
              originalTotal: 80,
              proposedTotal: 90,
              createdAt: '2026-07-22T00:00:00.000Z',
            }),
            makePendingOffer({ status: 'ACCEPTED', proposedTotal: 80 }),
          ],
          availableActions: { canRespondPriceOffer: true },
        })}
        isLearner
      />
    );

    expect(screen.getByText('Your response needed')).toBeTruthy();
    expect(screen.getAllByText('Current price')).toHaveLength(2);
    expect(screen.queryByText('Previous price')).toBeNull();
  });

  test('labels an older agreement as superseded after a replacement is accepted', () => {
    render(
      <BookingPriceOfferPanel
        booking={makeBooking({
          totalAmount: 90,
          priceOffers: [
            makePendingOffer({
              id: 'offer-2',
              status: 'ACCEPTED',
              originalTotal: 80,
              proposedTotal: 90,
              createdAt: '2026-07-22T00:00:00.000Z',
            }),
            makePendingOffer({ status: 'SUPERSEDED', proposedTotal: 80 }),
          ],
        })}
        isLearner
      />
    );

    expect(screen.getByText('Current price')).toBeTruthy();
    expect(screen.getByText('Previous price')).toBeTruthy();
    expect(screen.getAllByText('Price before offer')).toHaveLength(2);
  });

  test('lets the tutor withdraw a pending offer', () => {
    const onWithdraw = vi.fn();
    render(
      <BookingPriceOfferPanel
        booking={makeBooking({
          priceOffers: [makePendingOffer()],
          availableActions: { canWithdrawPriceOffer: true },
        })}
        isTutor
        onWithdraw={onWithdraw}
      />
    );

    expect(screen.getByText('Waiting for learner')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw offer' }));
    expect(onWithdraw).toHaveBeenCalledWith('offer-1');
  });

  test('labels an accepted offer amount as the price before that offer', () => {
    render(
      <BookingPriceOfferPanel
        booking={makeBooking({
          totalAmount: 80,
          priceOffers: [makePendingOffer({ status: 'ACCEPTED' })],
        })}
        isLearner
      />
    );

    expect(screen.getByText('Price before offer')).toBeTruthy();
    expect(screen.getByText('Current price')).toBeTruthy();
  });

  test('does not render for trial lessons or ineligible bookings without offer history', () => {
    const { rerender } = render(
      <BookingPriceOfferPanel
        booking={makeBooking({
          isTrialLesson: true,
          availableActions: { canProposePriceOffer: true },
        })}
        isTutor
      />
    );

    expect(screen.queryByRole('region', { name: 'Lesson price adjustment' })).toBeNull();

    rerender(
      <BookingPriceOfferPanel
        booking={makeBooking({ status: 'ACCEPTED' })}
        isTutor
      />
    );

    expect(screen.queryByRole('region', { name: 'Lesson price adjustment' })).toBeNull();
  });
});
