/**
 * MD Studio 主题设计器（Phase 3）。
 *
 * 形态是右栏的一个"抽屉"：点「主题设计器」展开，覆盖右栏其余部分——设计器需要
 * 纵向空间（10 个分区 35 个变量），和导出按钮挤在一屏里两边都看不清。
 *
 * 两条交互约定：
 * 1. **改动即预览**：控件写的是当前稿的 `overrides`，画布 150ms debounce 重排。
 *    设计器的价值就在"边调边看"，所以没有"应用"按钮。
 * 2. **派生项不是普通色板**：accentInk/soft/rule/hl 默认跟着主色算，界面标
 *    「跟随主色」并给一个"固定"入口；固定之后才变成可改的色板 + "还原"。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getTheme, resolveTokens, themeToCss, type Theme, type ThemeOverrides } from '@hertz/mdcore'

import { Button, Icon, Input, useToast } from '../../../components/ui'
import {
  customThemes,
  deleteCustomTheme,
  exportThemes,
  importThemes,
  saveCustomTheme,
} from './customThemes'
import { ENUM_LABELS, TOKEN_SECTIONS, type TokenDescriptor } from './schema'

interface ThemeDesignerProps {
  themeId: string
  overrides: ThemeOverrides
  onOverridesChange: (next: ThemeOverrides) => void
  onThemeChange: (id: string) => void
  onClose: () => void
}

function TokenRow({
  descriptor,
  value,
  isOverridden,
  onChange,
  onReset,
}: {
  descriptor: TokenDescriptor
  value: string
  isOverridden: boolean
  onChange: (next: string) => void
  onReset: () => void
}) {
  const { t } = useTranslation()
  const derivedActive = Boolean(descriptor.derived) && !isOverridden
  const id = `token-${descriptor.key}`

  /**
   * 文本控件保留一份草稿：值来自 `resolveTokens`，**清空会立刻被缺省值弹回来**
   * （fontSize 清成空 → resolveTokens 兜底 16px → 刚清掉就又显示 16px，用户没法
   * 正常地选中重打）。草稿只在非空时才提交，界面因此可以停在"空着等你输入"。
   */
  const [draft, setDraft] = useState<string | null>(null)
  useEffect(() => {
    setDraft(null)
  }, [value])

  return (
    <div className="flex items-start gap-2 border-t border-border/60 py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <label htmlFor={id} className="truncate text-xs font-medium text-text-primary">
            {descriptor.label}
          </label>
          <code className="shrink-0 text-[10px] text-text-disabled">{descriptor.key}</code>
          {derivedActive && (
            <span className="shrink-0 rounded border border-border bg-surface-2 px-1 text-[10px] text-text-secondary">
              {t('mdstudio.designer.followColor')}
            </span>
          )}
          {descriptor.derived && isOverridden && (
            <button
              type="button"
              onClick={onReset}
              className="shrink-0 rounded border border-border bg-surface-2 px-1 text-[10px] text-text-secondary transition-colors hover:border-primary hover:text-primary"
              title={t('mdstudio.designer.undoFix')}
              aria-label={t('mdstudio.designer.undoFix')}
            >
              {t('mdstudio.designer.fixed')}
            </button>
          )}
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-text-secondary">{descriptor.hint}</p>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {/* 派生项在"跟随主色"状态下是只读的：色板 + 固定按钮。
            只挂一个徽标却仍能改是最坏的一种——用户改完换个主色才发现被冲掉了。 */}
        {descriptor.control === 'color' && derivedActive && (
          <>
            <span
              aria-hidden
              className="h-5 w-5 rounded border border-black/10"
              style={{ backgroundColor: /^#[0-9a-f]{6}$/i.test(value) ? value : 'transparent' }}
            />
            <span className="w-14 truncate font-mono text-[10px] text-text-secondary">{value}</span>
            <button
              type="button"
              onClick={() => onChange(value)}
              title={t('mdstudio.designer.pinIt')}
              className="rounded border border-border px-1 text-[10px] text-text-secondary transition-colors hover:border-primary hover:text-primary"
            >
              {t('mdstudio.designer.pin')}
            </button>
          </>
        )}
        {descriptor.control === 'color' && !derivedActive && (
          <>
            <input
              id={id}
              type="color"
              aria-label={descriptor.label}
              value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
              onChange={(e) => onChange(e.target.value)}
              className="h-7 w-9 cursor-pointer rounded border border-border bg-surface-2 p-0.5"
            />
            <span className="w-16 truncate font-mono text-[10px] text-text-secondary">{value}</span>
          </>
        )}
        {descriptor.control === 'text' && (
          <input
            id={id}
            type="text"
            value={draft ?? value}
            onChange={(e) => {
              setDraft(e.target.value)
              if (e.target.value.trim() !== '') onChange(e.target.value)
            }}
            onBlur={() => setDraft(null)}
            className="h-7 w-24 rounded border border-border bg-surface-2 px-1.5 font-mono text-[11px] text-text-primary outline-none transition-colors focus:border-primary"
          />
        )}
        {descriptor.control === 'select' && descriptor.options && (
          <select
            id={id}
            aria-label={descriptor.label}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="h-7 max-w-40 rounded border border-border bg-surface-2 px-1 text-[11px] text-text-primary outline-none focus:border-primary"
          >
            {descriptor.options.map((opt) => (
              <option key={opt || 'inherit'} value={opt}>
                {opt === '' ? t('mdstudio.designer.sameAsBody') : (ENUM_LABELS[opt] ?? opt)}
              </option>
            ))}
            {!descriptor.options.includes(value) && (
              // 主题自带的值不在候选里时补一条，否则 Select 会显示成"离它最近的那档"（谎报当前值）
              <option value={value}>{value.length > 22 ? `${value.slice(0, 22)}…` : value}</option>
            )}
          </select>
        )}
        {!descriptor.derived && isOverridden && (
          <button
            type="button"
            onClick={onReset}
            title={t('mdstudio.designer.reset')}
            aria-label={t('mdstudio.designer.reset')}
            className="flex h-6 w-6 items-center justify-center rounded border border-border text-text-secondary transition-colors hover:border-primary hover:text-primary"
          >
            <Icon name="close" size={10} />
          </button>
        )}
      </div>
    </div>
  )
}

export function ThemeDesigner({ themeId, overrides, onOverridesChange, onThemeChange, onClose }: ThemeDesignerProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const [name, setName] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const theme = useMemo<Theme | null>(() => {
    try {
      return getTheme(themeId)
    } catch {
      return null
    }
  }, [themeId])

  const resolved = useMemo(() => (theme ? resolveTokens(theme, overrides) : null), [theme, overrides])
  const mine = customThemes()

  if (!theme || !resolved) {
    return (
      <div className="p-3 text-xs text-text-secondary">
        {t('mdstudio.designer.loadFailed')}
        <Button size="sm" variant="secondary" onClick={onClose} className="ml-2">
          {t('mdstudio.designer.back')}
        </Button>
      </div>
    )
  }

  const set = (key: string, value: string) => onOverridesChange({ ...overrides, [key]: value })
  const reset = (key: string) => {
    const next = { ...overrides }
    delete next[key as keyof ThemeOverrides]
    onOverridesChange(next)
  }

  const saveAs = () => {
    const entry = saveCustomTheme({
      id: name.trim() || `${theme.name}`,
      name: name.trim() || theme.name,
      platform: theme.platform,
      tokens: { ...theme.tokens, ...overrides },
    })
    setName('')
    onThemeChange(entry.id)
    toast(t('mdstudio.designer.saved', { name: entry.name }), 'success')
  }

  const onImport = async (file: File) => {
    try {
      const count = importThemes(await file.text())
      toast(t('mdstudio.designer.imported', { count }), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="mdstudio-designer">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="wand" size={14} className="text-primary" />
        <h2 className="flex-1 text-sm font-semibold text-text-primary">{t('mdstudio.designer.title')}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('mdstudio.designer.back')}
          className="flex h-6 w-6 items-center justify-center rounded text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
        >
          <Icon name="close" size={12} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {/* 我的主题 */}
        <section className="py-3">
          <h3 className="mb-2 text-xs font-semibold text-text-secondary">{t('mdstudio.designer.mine')}</h3>
          {mine.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-text-secondary">{t('mdstudio.designer.mineEmpty')}</p>
          ) : (
            <div className="flex flex-col gap-1">
              {mine.map((m) => (
                <div
                  key={m.id}
                  className={`flex items-center gap-2 rounded-md border px-2 py-1.5 ${
                    m.id === themeId ? 'border-primary/50 bg-primary/10' : 'border-border bg-surface-1'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onThemeChange(m.id)}
                    className="flex-1 truncate text-left text-xs text-text-primary hover:text-primary"
                  >
                    {m.name}
                  </button>
                  <button
                    type="button"
                    aria-label={`${t('mdstudio.designer.delete')} ${m.name}`}
                    onClick={() => deleteCustomTheme(m.id)}
                    className="flex h-5 w-5 items-center justify-center rounded text-text-secondary transition-colors hover:text-error"
                  >
                    <Icon name="trash" size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 另存为 */}
        <section className="flex flex-col gap-1.5 border-t border-border/60 py-3">
          <Input
            label={t('mdstudio.designer.saveAs')}
            value={name}
            placeholder={theme.name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" icon={<Icon name="check" size={12} />} onClick={saveAs}>
              {t('mdstudio.designer.save')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<Icon name="copy" size={12} />}
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(exportThemes(mine.length ? undefined : []))
                  .then(() => toast(t('mdstudio.designer.exported'), 'success'))
                  .catch(() => toast(t('mdstudio.designer.exportFailed'), 'error'))
              }}
            >
              {t('mdstudio.designer.export')}
            </Button>
            {/* 导出 CSS（P2-2）：分享形态——别人拿着这份 CSS + mdcore 结构
                就能在自己的预览器里复现同一套排版，不必装工坊。走剪贴板是因为
                CSS 是文本，用户通常直接存成文件贴进项目。 */}
            <Button
              size="sm"
              variant="secondary"
              icon={<Icon name="copy" size={12} />}
              data-testid="mdstudio-designer-export-css"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(themeToCss(themeId, overrides))
                  .then(() => toast(t('mdstudio.designer.exportCssDone'), 'success'))
                  .catch(() => toast(t('mdstudio.designer.exportFailed'), 'error'))
              }}
            >
              {t('mdstudio.designer.exportCss')}
            </Button>
            <Button size="sm" variant="secondary" icon={<Icon name="upload" size={12} />} onClick={() => fileRef.current?.click()}>
              {t('mdstudio.designer.import')}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              className="hidden"
              data-testid="mdstudio-designer-import"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void onImport(file)
                e.target.value = ''
              }}
            />
          </div>
        </section>

        {/* 变量清单 */}
        {TOKEN_SECTIONS.map((section) => (
          <section key={section.id} className="border-t border-border/60 py-3" data-testid={`designer-section-${section.id}`}>
            <h3 className="text-xs font-semibold text-text-primary">{section.label}</h3>
            <p className="mb-1 mt-0.5 text-[11px] text-text-secondary">{section.hint}</p>
            {section.tokens.map((descriptor) => (
              <TokenRow
                key={descriptor.key}
                descriptor={descriptor}
                value={String(resolved[descriptor.key] ?? '')}
                isOverridden={descriptor.key in overrides}
                onChange={(next) => set(descriptor.key, next)}
                onReset={() => reset(descriptor.key)}
              />
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}
