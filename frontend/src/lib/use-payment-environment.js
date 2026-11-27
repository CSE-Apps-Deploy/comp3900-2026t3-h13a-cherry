'use client';

import { useQuery } from '@tanstack/react-query';
import { paymentApi } from './api-entry';
import { useAuthStore } from './store';

export function usePaymentEnvironment() {
  const userId = useAuthStore((state) => state.user?.id);
  const query = useQuery({
    queryKey: ['paymentEnvironment', userId],
    queryFn: () => paymentApi.getConfig(),
    enabled: Boolean(userId),
    staleTime: 30_000,
  });
  return { ...query, environment: query.data?.data?.data || null };
}
