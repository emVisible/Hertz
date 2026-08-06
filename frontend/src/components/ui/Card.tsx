import type { HTMLAttributes, ReactNode } from 'react'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  padded?: boolean
}

export function Card({ children, padded = true, className = '', ...rest }: CardProps) {
  return (
    <div
      className={` border border-border bg-surface-1 shadow-sm ${padded ? 'p-4' : ''} ${className}`}
      {...rest}
    >
      {children}
    </div>
  )
}
