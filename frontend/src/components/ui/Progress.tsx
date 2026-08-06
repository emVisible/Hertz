export interface ProgressProps {
  /** 0..100, or null/undefined for indeterminate */
  value?: number
  className?: string
}

export function Progress({ value, className = '' }: ProgressProps) {
  const determinate = value !== undefined && value !== null
  return (
    <div
      role="progressbar"
      aria-valuenow={determinate ? Math.round(value) : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      className={`h-1.5 w-full overflow-hidden  bg-surface-2 ${className}`}
    >
      {determinate ? (
        <div
          className="h-full  bg-primary transition-[width] duration-300"
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      ) : (
        <div className="h-full w-1/3 animate-[hz-indeterminate_1s_ease-in-out_infinite]  bg-primary" />
      )}
      <style>{`@keyframes hz-indeterminate { from { transform: translateX(-100%); } to { transform: translateX(400%); } }`}</style>
    </div>
  )
}
