interface StatsCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: React.ReactNode;
  trend?: 'up' | 'down' | 'neutral';
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'gray';
  onClick?: () => void;
  isActive?: boolean;
}

const colorClasses = {
  blue: 'bg-blue-50 text-blue-700 border-blue-200',
  green: 'bg-green-50 text-green-700 border-green-200',
  yellow: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  red: 'bg-red-50 text-red-700 border-red-200',
  gray: 'bg-gray-50 text-gray-700 border-gray-200',
};

const activeColorClasses = {
  blue: 'bg-blue-100 text-blue-800 border-blue-400 ring-2 ring-blue-400',
  green: 'bg-green-100 text-green-800 border-green-400 ring-2 ring-green-400',
  yellow: 'bg-yellow-100 text-yellow-800 border-yellow-400 ring-2 ring-yellow-400',
  red: 'bg-red-100 text-red-800 border-red-400 ring-2 ring-red-400',
  gray: 'bg-gray-100 text-gray-800 border-gray-400 ring-2 ring-gray-400',
};

export default function StatsCard({
  title,
  value,
  subtitle,
  icon,
  color = 'blue',
  onClick,
  isActive = false,
}: StatsCardProps) {
  const baseClasses = onClick
    ? 'cursor-pointer transition-all duration-200 hover:scale-[1.02] hover:shadow-md'
    : '';

  return (
    <div
      onClick={onClick}
      className={`rounded-lg border p-6 ${isActive ? activeColorClasses[color] : colorClasses[color]} ${baseClasses}`}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium opacity-80">{title}</p>
          <p className="mt-2 text-3xl font-bold">{value}</p>
          {subtitle && (
            <p className="mt-1 text-sm opacity-70">{subtitle}</p>
          )}
        </div>
        {icon && (
          <div className="text-3xl opacity-50">
            {icon}
          </div>
        )}
        {onClick && (
          <div className="text-sm opacity-50">
            {isActive ? '✓' : 'Click to filter'}
          </div>
        )}
      </div>
    </div>
  );
}
