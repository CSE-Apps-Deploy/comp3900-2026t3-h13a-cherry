const ADMIN_ROLES = new Set(['ADMIN', 'SYSTEM_ADMIN']);

const REQUESTER_BADGES = {
  LEARNER: {
    label: 'Learner',
    className: 'bg-blue-50 text-blue-700',
  },
  TUTOR: {
    label: 'Tutor',
    className: 'bg-emerald-50 text-emerald-700',
  },
};

const ADMIN_SUPPORT_BADGE = {
  label: 'Admin support',
  className: 'bg-blue-50 text-blue-700',
};

const UNKNOWN_REQUESTER_BADGE = {
  label: 'Support requester',
  className: 'bg-gray-100 text-gray-600',
};

export const getSupportChatBadge = ({ viewerRole, requesterRole } = {}) => {
  if (!ADMIN_ROLES.has(viewerRole)) return ADMIN_SUPPORT_BADGE;
  return REQUESTER_BADGES[requesterRole] || UNKNOWN_REQUESTER_BADGE;
};
