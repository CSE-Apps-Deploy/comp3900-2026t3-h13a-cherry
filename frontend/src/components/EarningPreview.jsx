import { BanknotesIcon } from '@heroicons/react/24/outline';
import { formatCurrency } from '../lib/formatters';
import { cn } from '../lib/utils';

export default function EarningPreview({ preview, title = 'Your expected earnings', className }) {
  if (!preview) return null;

  if (preview.isTrialLesson) {
    return (
      <div
        className={cn(
          'rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700',
          className
        )}
      >
        <p className="font-semibold">Free trial</p>
        <p className="mt-0.5">{preview.message || 'No commission or payout applies.'}</p>
      </div>
    );
  }

  const currency = preview.currency || 'AUD';

  return (
    <div
      className={cn(
        'rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-violet-950',
        className
      )}
    >
      <div className="flex items-center gap-2">
        <BanknotesIcon className="h-4 w-4" aria-hidden="true" />
        <p className="text-sm font-semibold">{title}</p>
      </div>
      <p className="mt-1 text-sm">
        {formatCurrency(preview.grossAmount, currency)}
        {' − '}
        {formatCurrency(preview.commissionAmount, currency)}
        {` TutorConnect commission (${Number(preview.commissionPercent)}%)`}
        {' = '}
        <strong>{formatCurrency(preview.netAmount, currency)} to you</strong>
      </p>
      <p className="mt-2 text-xs">
        The learner pays the lesson total. TutorConnect deducts the commission shown above
        from that total; the remainder is your earning.
      </p>
    </div>
  );
}
