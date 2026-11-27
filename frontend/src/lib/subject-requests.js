export const LEARNER_SUBJECT_REQUEST_TABS = [
  { value: '', label: 'All' },
  { value: 'OPEN', label: 'Open' },
  { value: 'ACCEPTED', label: 'Accepted' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export const TUTOR_SUBJECT_REQUEST_TABS = [
  { value: 'OPEN', label: 'Open' },
  { value: 'ACCEPTED', label: 'Accepted by me' },
];

export const getSubjectRequestTabs = (role) =>
  role === 'TUTOR' ? TUTOR_SUBJECT_REQUEST_TABS : LEARNER_SUBJECT_REQUEST_TABS;

export const getInitialSubjectRequestStatus = (value, role) => {
  const tabs = getSubjectRequestTabs(role);
  const normalized = String(value || '').toUpperCase();
  return tabs.some((tab) => tab.value === normalized) ? normalized : role === 'TUTOR' ? 'OPEN' : '';
};

export const validateSubjectRequestForm = ({ subjectName, category, description }) => {
  const name = String(subjectName || '').trim();
  const selectedCategory = String(category || '').trim();
  const details = String(description || '').trim();

  if (name.length < 2 || name.length > 100) {
    return 'Subject name must be between 2 and 100 characters';
  }
  if (!selectedCategory) return 'Select a subject category';
  if (details.length < 10 || details.length > 1000) {
    return 'Description must be between 10 and 1000 characters';
  }

  return null;
};

export const getSubjectRequestStatusClass = (status) => {
  switch (status) {
    case 'ACCEPTED':
      return 'border-green-200 bg-green-50 text-green-700';
    case 'CANCELLED':
      return 'border-gray-200 bg-gray-100 text-gray-600';
    default:
      return 'border-amber-200 bg-amber-50 text-amber-700';
  }
};
