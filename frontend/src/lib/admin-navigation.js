export const ADMIN_HOME_NAV_ITEM = {
  href: '/admin/dashboard',
  label: 'Home',
};

export const ADMIN_PAYOUTS_NAV_ITEM = {
  href: '/admin/payouts',
  label: 'Payouts',
};

export const getAdminNavItems = (role) =>
  role === 'ADMIN' || role === 'SYSTEM_ADMIN'
    ? [ADMIN_HOME_NAV_ITEM, ADMIN_PAYOUTS_NAV_ITEM]
    : [];
