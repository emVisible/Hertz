/**
 * Design tokens — the single visual source (AXIOM §27).
 * Components reference tokens; they never invent raw values.
 * Tailwind utilities (bg-primary, text-text-secondary...) map to the
 * same CSS variables declared in styles/global.css.
 */
export const tokens = {
  color: {
    bg: 'var(--hz-bg)',
    surface1: 'var(--hz-surface-1)',
    surface2: 'var(--hz-surface-2)',
    textPrimary: 'var(--hz-text-primary)',
    textSecondary: 'var(--hz-text-secondary)',
    textDisabled: 'var(--hz-text-disabled)',
    primary: 'var(--hz-primary)',
    primaryHover: 'var(--hz-primary-hover)',
    border: 'var(--hz-border)',
    success: 'var(--hz-success)',
    warning: 'var(--hz-warning)',
    error: 'var(--hz-error)',
    chalk: 'var(--hz-chalk)',
  },
  spacing: {
    xs: '4px',
    sm: '8px',
    md: '16px',
    lg: '24px',
    xl: '32px',
  },
  radius: {
    sm: '4px',
    md: '8px',
    lg: '12px',
    full: '9999px',
  },
  motion: {
    fast: '150ms',
    normal: '300ms',
    slow: '500ms',
  },
} as const
