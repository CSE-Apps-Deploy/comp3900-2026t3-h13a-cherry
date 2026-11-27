import { getCancellationPolicyCopy } from '../lib/cancellation-policy';
import { cn } from '../lib/utils';

export default function CancellationPolicySummary({
  policy,
  title = 'Cancellation policy',
  className,
  compact = false,
}) {
  const copy = getCancellationPolicyCopy(policy);

  return (
    <div
      className={cn(
        'min-w-0 rounded-2xl border border-amber-200 bg-amber-50/70 text-amber-950',
        compact ? 'p-3' : 'p-4',
        className
      )}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">{title}</p>
      <div className="mt-2 space-y-1 text-sm leading-6 whitespace-normal break-words">
        <p>{copy.cutoffText}</p>
        <p>{copy.lateRefundText}</p>
      </div>
    </div>
  );
}
