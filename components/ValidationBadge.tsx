import type { ValidationStatus } from '@/lib/types';

interface ValidationBadgeProps {
  status: ValidationStatus | 'pending' | 'error';
}

const statusConfig = {
  matched: {
    label: 'Matched',
    className: 'bg-green-100 text-green-800 border-green-300',
  },
  mismatched: {
    label: 'Mismatched',
    className: 'bg-yellow-100 text-yellow-800 border-yellow-300',
  },
  unknown: {
    label: 'Unknown',
    className: 'bg-gray-100 text-gray-800 border-gray-300',
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
