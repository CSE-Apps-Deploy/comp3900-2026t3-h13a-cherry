'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  HomeIcon,
  MagnifyingGlassIcon,
  CalendarIcon,
  ChatBubbleLeftRightIcon,
  LifebuoyIcon,
  UserIcon,
  AcademicCapIcon,
  BanknotesIcon,
  ArrowRightStartOnRectangleIcon,
} from '@heroicons/react/24/outline';
import {
  HomeIcon as HomeIconSolid,
  MagnifyingGlassIcon as MagnifyingGlassIconSolid,
  CalendarIcon as CalendarIconSolid,
  ChatBubbleLeftRightIcon as ChatBubbleLeftRightIconSolid,
  LifebuoyIcon as LifebuoyIconSolid,
  UserIcon as UserIconSolid,
  AcademicCapIcon as AcademicCapIconSolid,
  BanknotesIcon as BanknotesIconSolid,
} from '@heroicons/react/24/solid';
import { messageApi } from '../../lib/api-entry';
import { useAuthStore, useMessageStore } from '../../lib/store';
import {
  getTutorAccessState,
  getTutorRedirectPath,
  TUTOR_REVIEW_PATH,
  TUTOR_VERIFICATION_PATH,
} from '../../lib/tutor-access';
import { getAdminNavItems } from '../../lib/admin-navigation';
import NotificationBox from '../../components/notificationBox';
import TimezoneConfirmBanner from '../../components/TimezoneConfirmBanner';
import { PaymentTestBanner } from '../../components/PaymentTestNotice';

const isGuestBrowsePath = (pathname = '') =>
  pathname === '/search' || pathname.startsWith('/tutors/');

const getLearnerNav = () => [
  { href: '/dashboard', label: 'Home', icon: HomeIcon, activeIcon: HomeIconSolid },
  {
    href: '/search',
    label: 'Search',
    icon: MagnifyingGlassIcon,
    activeIcon: MagnifyingGlassIconSolid,
  },
  { href: '/bookings', label: 'Bookings', icon: CalendarIcon, activeIcon: CalendarIconSolid },
  {
    href: '/subject-requests',
    label: 'Subject Board',
    mobileLabel: 'Subjects',
    icon: AcademicCapIcon,
    activeIcon: AcademicCapIconSolid,
  },
  {
    href: '/messages',
    label: 'Messages',
    icon: ChatBubbleLeftRightIcon,
    activeIcon: ChatBubbleLeftRightIconSolid,
  },
  {
    href: '/messages?support=1',
    label: 'Support',
    icon: LifebuoyIcon,
    activeIcon: LifebuoyIconSolid,
  },
  { href: '/profile', label: 'Profile', icon: UserIcon, activeIcon: UserIconSolid },
];

const getTutorNav = () => [
  { href: '/tutor/dashboard', label: 'Home', icon: HomeIcon, activeIcon: HomeIconSolid },
  { href: '/tutor/requests', label: 'Requests', icon: CalendarIcon, activeIcon: CalendarIconSolid },
  {
    href: '/subject-requests',
    label: 'Subject Board',
    mobileLabel: 'Subjects',
    icon: AcademicCapIcon,
    activeIcon: AcademicCapIconSolid,
  },
  {
    href: '/tutor/payouts',
    label: 'Earnings',
    icon: BanknotesIcon,
    activeIcon: BanknotesIconSolid,
  },
  {
    href: '/messages',
    label: 'Messages',
    icon: ChatBubbleLeftRightIcon,
    activeIcon: ChatBubbleLeftRightIconSolid,
  },
  {
    href: '/messages?support=1',
    label: 'Support',
    icon: LifebuoyIcon,
    activeIcon: LifebuoyIconSolid,
  },
  { href: '/tutor/profile', label: 'Profile', icon: UserIcon, activeIcon: UserIconSolid },
];

const getAdminNav = (role) =>
  getAdminNavItems(role).map((item) => ({
    ...item,
    icon: item.href === '/admin/payouts' ? BanknotesIcon : HomeIcon,
    activeIcon: item.href === '/admin/payouts' ? BanknotesIconSolid : HomeIconSolid,
  }));

const pageTitles = {
  '/dashboard': 'Home',
  '/search': 'Search',
  '/bookings': 'Bookings',
  '/messages': 'Messages',
  '/profile': 'Profile',
  '/tutor/dashboard': 'Dashboard',
  '/tutor/requests': 'Requests',
  '/tutor/profile': 'Tutor Profile',
  '/tutor/payouts': 'Earnings & payouts',
  '/tutor/verification': 'Tutor Verification',
  '/tutor/review': 'Review Status',
  '/subject-requests': 'Subject Board',
  '/admin/payouts': 'Payouts',
};

export default function AppLayout({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const authLoading = useAuthStore((state) => state.isLoading);
  const user = useAuthStore((state) => state.user);
  const accessToken = useAuthStore((state) => state.accessToken);
  const initializeAuth = useAuthStore((state) => state.initializeAuth);
  const logout = useAuthStore((state) => state.logout);
  const unreadCount = useMessageStore((state) => state.unreadCount);
  const setUnreadCount = useMessageStore((state) => state.setUnreadCount);
  const [mounted, setMounted] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const currentUserId = user?.id || '';
  const tutorAccessState = getTutorAccessState(user);
  const tutorRedirectPath = getTutorRedirectPath(user);
  const isTutorRestricted = user?.role === 'TUTOR' && tutorAccessState !== 'ACTIVE';
  const isTutorVerificationPath = pathname === TUTOR_VERIFICATION_PATH;
  const isTutorReviewPath = pathname === TUTOR_REVIEW_PATH;

  useEffect(() => {
    setMounted(true);
  }, []);

  const isGuestPath = useMemo(() => isGuestBrowsePath(pathname || ''), [pathname]);

  useEffect(() => {
    if (!mounted) return;
    if (isGuestPath) return;
    if (accessToken) return;

    router.replace('/login');
  }, [mounted, isGuestPath, accessToken, router]);

  useEffect(() => {
    if (!mounted || !accessToken || user || isGuestPath) return;
    initializeAuth().catch(() => {});
  }, [mounted, accessToken, user, isGuestPath, initializeAuth]);

  useEffect(() => {
    if (!mounted || !accessToken || !user || isGuestPath) return;
    if (user.role !== 'TUTOR') return;

    if (tutorAccessState === 'ACTIVE') {
      if (isTutorVerificationPath || isTutorReviewPath) {
        router.replace('/tutor/dashboard');
      }
      return;
    }

    if (pathname !== tutorRedirectPath) {
      router.replace(tutorRedirectPath);
    }
  }, [
    mounted,
    accessToken,
    user,
    isGuestPath,
    tutorAccessState,
    tutorRedirectPath,
    isTutorVerificationPath,
    isTutorReviewPath,
    pathname,
    router,
  ]);

  useEffect(() => {
    if (!accessToken || !user || user.role === 'ADMIN') return;

    let cancelled = false;

    const loadUnread = async () => {
      try {
        const res = await messageApi.getUnreadCount();
        if (!cancelled) {
          setUnreadCount(res?.data?.data?.count || 0);
        }
      } catch {
        if (!cancelled) {
          setUnreadCount(0);
        }
      }
    };

    loadUnread();

    return () => {
      cancelled = true;
    };
  }, [accessToken, pathname, setUnreadCount, user]);

  if (!mounted) {
    return <div className="min-h-screen" />;
  }

  if (!accessToken && !isGuestPath) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-gray-500">
        Redirecting to login...
      </div>
    );
  }

  if (accessToken && !user && !isGuestPath) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-gray-500">
        {authLoading ? 'Loading account...' : 'Loading dashboard...'}
      </div>
    );
  }

  const navItems =
    user?.role === 'TUTOR'
      ? isTutorRestricted
        ? []
        : getTutorNav()
      : user?.role === 'LEARNER'
        ? getLearnerNav()
        : getAdminNav(user?.role);

  // Sprint 1: Calendar entry for learners and approved tutors.
  if (user?.role === 'LEARNER' || (user?.role === 'TUTOR' && !isTutorRestricted)) {
    const bookingIndex = navItems.findIndex((item) => ['/bookings', '/tutor/requests'].includes(item.href));
    navItems.splice(bookingIndex + 1, 0, { href: '/calendar', label: 'Calendar', icon: CalendarIcon, activeIcon: CalendarIconSolid });
  }
  pageTitles['/calendar'] = 'Calendar';

  const pageTitle =
    Object.entries(pageTitles).find(([key]) => pathname === key || pathname.startsWith(key + '/'))
      ?.[1] || 'TutorConnect';

  const handleLogout = async () => {
    if (isLoggingOut) return;

    setIsLoggingOut(true);
    try {
      await logout();
      router.replace('/login');
    } finally {
      setIsLoggingOut(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-30 border-b border-gray-200 bg-white">
        <div className="mx-auto flex min-h-14 w-full max-w-[1600px] items-center justify-between gap-3 px-4 py-2 sm:px-6 xl:px-8">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-gray-900">{pageTitle}</h1>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {navItems.length > 0 && (
              <nav className="hidden items-center gap-2 md:flex">
                {navItems.map((item) => {
                  const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
                  const Icon = isActive ? item.activeIcon : item.icon;

                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-label={item.label}
                      title={item.label}
                      className={`inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm transition-colors ${
                        isActive
                          ? 'bg-primary-50 font-semibold text-primary-700'
                          : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
                      }`}
                    >
                      <div className="relative">
                        <Icon className="h-4 w-4" />
                        {item.href === '/messages' && unreadCount > 0 && (
                          <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                            {unreadCount > 9 ? '9+' : unreadCount}
                          </span>
                        )}
                      </div>
                      <span className="hidden xl:inline">{item.label}</span>
                    </Link>
                  );
                })}
              </nav>
            )}
            <NotificationBox currentUserId={currentUserId} />
            {accessToken && user && (
              <button
                type="button"
                onClick={handleLogout}
                disabled={isLoggingOut}
                className="btn btn-sm shrink-0 rounded-full border border-red-500 bg-white text-red-600 hover:bg-red-50 active:bg-red-100 focus:ring-red-500"
              >
                <ArrowRightStartOnRectangleIcon className="h-4 w-4" aria-hidden="true" />
                {isLoggingOut ? 'Logging out...' : 'Log out'}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1600px] px-4 py-4 pb-24 sm:px-6 md:pb-8 xl:px-8">
        <TimezoneConfirmBanner />
        <PaymentTestBanner />
        {children}
      </main>

      {navItems.length > 0 && (
        <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-200 bg-white md:hidden">
          <div className="mx-auto flex h-16 w-full max-w-[1600px] items-center justify-around px-2 sm:px-4">
            {navItems.map((item) => {
              const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
              const Icon = isActive ? item.activeIcon : item.icon;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex flex-1 flex-col items-center justify-center gap-1 py-1"
                >
                  <div className="relative">
                    <Icon className={`h-5 w-5 ${isActive ? 'text-primary-600' : 'text-gray-400'}`} />
                    {item.href === '/messages' && unreadCount > 0 && (
                      <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
                        {unreadCount > 9 ? '9+' : unreadCount}
                      </span>
                    )}
                  </div>
                  <span
                    className={`text-[11px] ${isActive ? 'font-semibold text-primary-600' : 'text-gray-400'}`}
                  >
                    {item.mobileLabel || item.label}
                  </span>
                </Link>
              );
            })}
          </div>
        </nav>
      )}
    </div>
  );
}
