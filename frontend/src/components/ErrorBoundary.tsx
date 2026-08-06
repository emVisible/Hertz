import { Component, type ErrorInfo, type ReactNode } from 'react'
import { withTranslation, type WithTranslation } from 'react-i18next'

import { copyToClipboard } from '../utils/copy'

interface ErrorBoundaryProps {
  children: ReactNode
  onReset?: () => void
}

interface ErrorBoundaryState {
  error: Error | null
  copied: boolean
}

/** 零依赖错误边界：UI 崩溃不白屏，展示恢复入口（AXIOM §22.2 优雅降级）。 */
class ErrorBoundary extends Component<ErrorBoundaryProps & WithTranslation, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, copied: false }

  static getDerivedStateFromError(error: Error): Pick<ErrorBoundaryState, 'error'> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[Hertz] render error:', error, info.componentStack)
  }

  private reset = () => {
    this.setState({ error: null, copied: false })
    this.props.onReset?.()
  }

  render(): ReactNode {
    const { t } = this.props
    if (this.state.error) {
      const copyText = [
        this.state.error.message,
        '---',
        this.state.error.stack,
      ].filter(Boolean).join('\n')
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg p-6 text-center">
          <p className="text-2xl">💥</p>
          <h2 className="text-base font-semibold text-text-primary">{t('error.title')}</h2>
          <p className="max-w-md break-all text-sm text-text-secondary">
            {this.state.error.message || t('error.unexpected')}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void copyToClipboard(copyText).then((ok) => this.setState({ copied: ok }))
                setTimeout(() => this.setState({ copied: false }), 1200)
              }}
              className="border border-border px-4 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:border-primary hover:text-primary"
            >
              {this.state.copied ? t('common.copied') : t('common.copy')}
            </button>
            <button
              type="button"
              onClick={this.reset}
              className="bg-primary px-4 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
            >
              {t('error.reload')}
            </button>
            <button
              type="button"
              onClick={() => {
                this.setState({ error: null, copied: false })
                if (window.history.length > 1) {
                  window.history.back()
                } else {
                  window.location.href = '/'
                }
              }}
              className="border border-border px-4 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:border-primary hover:text-primary"
            >
              {t('error.back')}
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export const ErrorBoundaryI18n = withTranslation()(ErrorBoundary)

