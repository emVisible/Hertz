import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { BrandName, Sidebar, WindowControls } from '../components/layout'
import type { NavItem } from '../components/layout'
import { Icon } from '../components/ui'
import { useThemeStore } from '../stores/theme'
import { PageTransition } from '../components/PageTransition'
import { AssetsPage } from '../pages/assets/AssetsPage'
import { PlansPage } from '../pages/plans/PlansPage'
import { ExecutionPage } from '../pages/execution/ExecutionPage'
import { CanvasPage } from '../pages/canvas/CanvasPage'
import { SettingsPage } from '../pages/settings/SettingsPage'

export function AppShell() {
  const { t } = useTranslation()
  const theme = useThemeStore((s) => s.theme)
  const toggleTheme = useThemeStore((s) => s.toggle)
  const location = useLocation()

  const navItems: NavItem[] = [
    // 创作
    { to: '/canvas', icon: 'canvas', label: t('nav.canvas'), group: 'create' },
    // 生产
    { to: '/execution', icon: 'console', label: t('nav.execution'), group: 'produce' },
    { to: '/plans', icon: 'plans', label: t('nav.plans'), group: 'produce' },
    // 素材（唯一出口：下载/资源/文档）
    { to: '/assets', icon: 'box', label: t('nav.assets'), group: 'assets' },
    // 系统
    { to: '/config', icon: 'config', label: t('nav.config'), group: 'system' },
  ]
  const currentLabel = navItems.find((item) => item.to === location.pathname)?.label ?? ''

  return (
    <div className="flex h-full">
      <Sidebar items={navItems} footer={<BrandName />} />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 全局窗口条：40px，红绿灯 + 标题 + 主题切换，中间区域可拖拽 */}
        <header
          className="flex h-10 shrink-0 items-center border-b border-border bg-surface-1"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <div className="flex items-center pl-3 pr-4" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <WindowControls />
          </div>
          <h1 className="text-sm font-medium text-text-secondary">{currentLabel}</h1>
          <div className="ml-auto flex items-center pr-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <button
              type="button"
              onClick={toggleTheme}
              title={t('theme.toggle')}
              aria-label={t('theme.toggle')}
              className="flex h-7 w-7 items-center justify-center text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
            </button>
          </div>
        </header>
        <main className="flex flex-1 flex-col overflow-hidden bg-bg">
          <PageTransition>
            <Routes>
              <Route path="/canvas" element={<CanvasPage />} />
              <Route path="/execution" element={<ExecutionPage />} />
              <Route path="/studio" element={<Navigate to="/execution?mode=studio" replace />} />
              <Route path="/console" element={<Navigate to="/execution?mode=pipeline" replace />} />
              <Route path="/plans" element={<PlansPage />} />
              <Route path="/assets" element={<AssetsPage />} />
              <Route path="/config" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/canvas" replace />} />
            </Routes>
          </PageTransition>
        </main>
      </div>
    </div>
  )
}
