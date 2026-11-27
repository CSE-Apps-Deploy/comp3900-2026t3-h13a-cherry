// src/components/providers/Providers.jsx - App Providers
'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { useEffect, useState } from 'react';
import { useAuthStore, useMessageStore } from '../../lib/store';
import { getStoredUser, getStoredValue, STORAGE_KEYS } from '../../lib/auth-storage';

export default function Providers({ children }) {
  const userId = useAuthStore((state) => state.user?.id || 'guest');
  const [sessionChanged, setSessionChanged] = useState(null);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // 1 minute
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  useEffect(() => {
    let blocked = false;
    const unsubscribe = useAuthStore.subscribe((state, previous) => {
      if (state.user?.id !== previous.user?.id) {
        queryClient.clear();
        useMessageStore.getState().clearUnread();
      }
    });
    const syncSession = (event) => {
      if (blocked || (event?.type === 'storage' && event.key && !Object.values(STORAGE_KEYS).includes(event.key))) return;
      const storedUser = getStoredUser();
      if ((storedUser?.id || null) !== (useAuthStore.getState().user?.id || null)) {
        blocked = true;
        setSessionChanged(storedUser ? 'changed' : 'signed-out');
        useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, isLoading: false });
        return;
      }
      useAuthStore.setState({
        accessToken: getStoredValue(STORAGE_KEYS.ACCESS_TOKEN),
        refreshToken: getStoredValue(STORAGE_KEYS.REFRESH_TOKEN),
      });
    };
    window.addEventListener('storage', syncSession);
    window.addEventListener('focus', syncSession);
    window.addEventListener('pageshow', syncSession);
    return () => {
      unsubscribe();
      window.removeEventListener('storage', syncSession);
      window.removeEventListener('focus', syncSession);
      window.removeEventListener('pageshow', syncSession);
    };
  }, [queryClient]);

  return (
    <QueryClientProvider key={userId} client={queryClient}>
      {sessionChanged ? (
        <div role="alert" className="min-h-screen flex items-center justify-center px-6 bg-gray-50">
          <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6">
            <h1 className="text-xl font-semibold text-gray-900">
              {sessionChanged === 'signed-out' ? 'You signed out in another tab' : 'Account changed in another tab'}
            </h1>
            <p className="mt-3 text-sm text-gray-600">Sign in again before continuing in this tab.</p>
            <a href="/login" className="btn-primary mt-5 inline-flex">Sign in</a>
          </div>
        </div>
      ) : children}
      {process.env.NODE_ENV === 'development' && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  );
}
