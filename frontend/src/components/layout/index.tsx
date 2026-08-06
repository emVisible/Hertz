import { Fragment, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'

import { Icon, type IconName } from '../ui'

/** macOS-style traffic-light window controls (Electron frameless window). */
export function WindowControls() {
  const electron = window.electron
  if (!electron) return null
  const controls: { id: string; label: string; onClick: () => void; color: string }[] = [
    { id: 'close', label: 'Close', onClick: () => electron.close(), color: '#ff5f57' },
    { id: 'plus', label: 'Minimize', onClick: () => electron.minimize(), color: '#febc2e' },
    {
      id: 'check',
      label: 'Maximize',
      onClick: () => electron.toggleMaximize(),
      color: '#28c840',
    },
  ]
  return (
    <div className="flex items-center gap-2" aria-label="Window controls">
      {controls.map((c) => (
        <button
          key={c.id}
          type="button"
          aria-label={c.label}
          onClick={c.onClick}
          className="h-3 w-3  border border-black/10 transition-transform hover:scale-110"
          style={{ background: c.color }}
        />
      ))}
    </div>
  )
}

export interface NavItem {
  to: string
  icon: IconName
  label: ReactNode
  /** 功能分组：同组相邻渲染，组间插入分隔线（不按 Windows 平铺堆叠）。 */
  group?: 'create' | 'produce' | 'assets' | 'system'
}

export interface SidebarProps {
  items: NavItem[]
  footer?: ReactNode
}

export function Sidebar({ items, footer }: SidebarProps) {
  return (
    <aside className="flex w-16 shrink-0 flex-col items-center border-r border-border bg-surface-1 py-3">
      <nav className="flex flex-1 flex-col items-center gap-1 overflow-y-auto" aria-label="Primary">
        {items.map((item, i) => (
          <Fragment key={item.to}>
            {i > 0 && items[i - 1].group !== item.group && <div className="my-1 h-px w-8 bg-border" />}
            <NavLinkButton item={item} />
          </Fragment>
        ))}
      </nav>
      {footer}
    </aside>
  )
}

function NavLinkButton({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.to}
      title={typeof item.label === 'string' ? item.label : undefined}
      className={({ isActive }) =>
        `flex h-10 w-10 items-center justify-center  transition-colors duration-150 ${
          isActive
            ? 'bg-primary/15 text-primary'
            : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
        }`
      }
    >
      <Icon name={item.icon} size={18} />
    </NavLink>
  )
}

/** Brand name shown at the bottom of the sidebar (AXIOM: brand in one place). */
export function BrandName() {
  return (
    <span className="select-none pb-1 text-[10px] font-semibold tracking-widest text-text-disabled">
      Hertz
    </span>
  )
}
