import { describe, expect, test } from 'vitest';

import {
  ADMIN_HOME_NAV_ITEM,
  ADMIN_PAYOUTS_NAV_ITEM,
  getAdminNavItems,
} from '../admin-navigation';

describe('admin navigation', () => {
  test('links Home to the admin dashboard', () => {
    expect(ADMIN_HOME_NAV_ITEM).toEqual({
      href: '/admin/dashboard',
      label: 'Home',
    });
  });

  test.each(['ADMIN', 'SYSTEM_ADMIN'])('enables admin navigation for %s', (role) => {
    expect(getAdminNavItems(role)).toEqual([ADMIN_HOME_NAV_ITEM, ADMIN_PAYOUTS_NAV_ITEM]);
  });

  test.each(['LEARNER', 'TUTOR', undefined])('does not enable admin navigation for %s', (role) => {
    expect(getAdminNavItems(role)).toEqual([]);
  });
});
