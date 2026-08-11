import { useEffect } from 'react'
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { AppShell } from './components/AppShell'
import { ErrorBoundaryI18n as ErrorBoundary } from './components/ErrorBoundary'
import { ToastProvider, useToastStore } from './components/ui'
import './i18n'
import { applyTheme, useThemeStore } from './stores/theme'

// 全局错误反馈（AXIOM §22.2）：query 失败（无缓存数据）限频 toast 兜底。
// 业务操作全部走 async 函数 + try/catch（组件层 toast）——全项目无 useMutation，
// 因此不配置 MutationCache（v0.8 查漏补缺：原配置为死代码）。
const ERROR_TOAST_WINDOW_MS = 5000
const lastToasts = new Map<string, number>()

function reportError(error: unknown, label: string): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[Hertz] ${label} failed:`, error)
  const now = Date.now()
  const last = lastToasts.get(message)
  if (last !== undefined && now - last < ERROR_TOAST_WINDOW_MS) return
  lastToasts.set(message, now)
  if (lastToasts.size > 64) {
    const oldest = lastToasts.keys().next().value
    if (oldest !== undefined) lastToasts.delete(oldest)
  }
  useToastStore.getState().push(message, 'error')
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (!query.state.data) reportError(error, `query ${query.queryKey.join('.')}`)
    },
  }),
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
})

function Root() {
  const theme = useThemeStore((s) => s.theme)
  const { i18n } = useTranslation()

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  useEffect(() => {
    document.documentElement.lang = i18n.language
  }, [i18n.language])

  return <AppShell />
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <BrowserRouter>
            <Root />
          </BrowserRouter>
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
