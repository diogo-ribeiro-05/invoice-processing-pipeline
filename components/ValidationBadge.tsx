import type { ValidationStatus } from '@/lib/types';

interface ValidationBadgeProps {
  status: ValidationStatus | 'pending' | 'error';
}

const statusConfig = {
  matched: {
    label: 'Matched',
    className: 'bg-green-100 text-green-800 border-green-300',
  },
  flagged: {
    label: 'Flagged Issues',
    className: 'bg-red-100 text-red-800 border-red-300',
  },
  pending: {
    label: 'Pending',
    className: 'bg-blue-100 text-blue-800 border-blue-300',
  },
  error: {
    label: 'Error',
    className: 'bg-red-100 text-red-800 border-red-300',
  },
};

export default function ValidationBadge({ status }: ValidationBadgeProps) {
  const config = statusConfig[status];

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${config.className}`}
    >
      {config.label}
    </span>
  );
}
