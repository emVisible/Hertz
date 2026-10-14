/** MD Studio 右栏：平台 → 主题 → 微调 → 平台专有 → 导出（设计 §5 右栏）。
 *
 * 主题与微调即「我的主题」（§4）：overrides 随稿入库。导出动作本身在
 * MdStudioPage 编排（要拿 draft 全文重建渲染态 DOM），这里只发意图。
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getTheme, listThemes, XHS_MAX_PAGES, type ThemeOverrides } from '@hertz/mdcore'

import type { LayoutPlatform } from '../../api'
import { Button, Icon, Input, Select, TabBar, useToast } from '../../components/ui'
import type { XhsRenderInfo } from './CanvasPanel'
import { ThemeDesigner } from './themeDesigner/ThemeDesigner'
import { hydrateCustomThemes } from './themeDesigner/customThemes'

export type ExportAction = 'copy-wechat' | 'copy-zhihu' | 'copy-caption' | 'zip' | 'longimage'

const FONT_SIZES = ['14px', '15px', '16px', '17px', '18px']
const LINE_HEIGHTS = ['1.5', '1.6', '1.75', '1.9', '2.0']

/** 主题自带的值必须出现在选项里：否则 Select 显示的是「离它最近的那档」，
 *  等于谎报当前行距（墨滴 1.8 会被显示成 1.5，小红书主题 30px 会被显示成 18px）。 */
function optionsWith(values: string[], current: string): Array<{ value: string; label: string }> {
  const all = values.includes(current) ? values : [...values, current]
  return [...all]
    .sort((a, b) => parseFloat(a) - parseFloat(b))
    .map((v) => ({ value: v, label: v }))
}
/** 二维码 dataURL 直接进 cover JSON，200KB 是「够放一张二维码、又不撑爆行」的上限 */
const QR_MAX_BYTES = 200 * 1024
/** 色盘预设（§4 doocs/md 式一键换色：选中即 overrides.color，整套由主色派生） */
const PALETTE = ['#c24d2c', '#0f766e', '#2f4b7c', '#7c3aed', '#b91c1c', '#d4a24c', '#0891b2', '#334155']

interface InspectorPanelProps {
  platform: LayoutPlatform
  themeId: string
  overrides: ThemeOverrides
  footer: string
  qr: string | null
  xhsInfo: XhsRenderInfo
  exporting: ExportAction | null
  onPlatformChange: (p: LayoutPlatform) => void
  onThemeChange: (id: string) => void
  onOverridesChange: (o: ThemeOverrides) => void
  onFooterChange: (f: string) => void
  onQrChange: (qr: string | null) => void
  onExport: (action: ExportAction) => void
}

export function InspectorPanel({
  platform,
  themeId,
  overrides,
  footer,
  qr,
  xhsInfo,
  exporting,
  onPlatformChange,
  onThemeChange,
  onOverridesChange,
  onFooterChange,
  onQrChange,
  onExport,
}: InspectorPanelProps) {
  const { t } = useTranslation()
  const toast = useToast()
  // 自建主题从 localStorage 灌进 mdcore 注册表：模块加载时做一次即可，
  // 正常路径是无副作用的（读不到存储就是零套）
  useState(() => {
    hydrateCustomThemes()
    return true
  })
  const [designing, setDesigning] = useState(false)
  const themes = listThemes().filter((th) => th.platform === platform)
  const currentTheme = (() => {
    try {
      return getTheme(themeId)
    } catch {
      return null
    }
  })()
  const color = overrides.color ?? currentTheme?.tokens.color ?? '#c24d2c'
  const fontSize = overrides.fontSize ?? currentTheme?.tokens.fontSize ?? '16px'
  const lineHeight = overrides.lineHeight ?? currentTheme?.tokens.lineHeight ?? '1.75'

  if (designing) {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="mdstudio-inspector">
        <ThemeDesigner
          themeId={themeId}
          overrides={overrides}
          onOverridesChange={onOverridesChange}
          onThemeChange={onThemeChange}
          onClose={() => setDesigning(false)}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="mdstudio-inspector">
      <div className="shrink-0 border-b border-border px-2 pt-1">
        <TabBar<LayoutPlatform>
          active={platform}
          onChange={onPlatformChange}
          items={[
            { id: 'wechat', label: t('mdstudio.platform.wechat') },
            { id: 'xhs', label: t('mdstudio.platform.xhs') },
            { id: 'zhihu', label: t('mdstudio.platform.zhihu') },
          ]}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {/* 主题选择：色块 + 名字 */}
        <h3 className="mb-2 text-xs font-semibold text-text-secondary">{t('mdstudio.inspector.theme')}</h3>
        <div className="grid grid-cols-1 gap-1.5">
          {themes.map((th) => {
            const active = th.id === themeId
            let swatch = '#999'
            try {
              swatch = getTheme(th.id).tokens.color
            } catch {
              /* 注册表与 listThemes 一致，正常不会进来 */
            }
            return (
              <button
                key={th.id}
                type="button"
                onClick={() => onThemeChange(th.id)}
                className={`flex items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-all duration-150 ${
                  active
                    ? 'border-primary/50 bg-primary/10 shadow-sm'
                    : 'border-border bg-surface-1 hover:border-text-disabled/50 hover:shadow-sm'
                }`}
              >
                <span
                  className="h-5 w-5 shrink-0 rounded-full border border-black/10"
                  style={{ backgroundColor: swatch }}
                />
                <span className={`flex-1 text-xs ${active ? 'font-medium text-text-primary' : 'text-text-primary'}`}>
                  {th.name}
                  {th.dark && (
                    <span className="ml-1.5 rounded border border-border bg-surface-2 px-1 text-[10px] text-text-secondary">
                      {t('mdstudio.theme.darkBadge')}
                    </span>
                  )}
                </span>
                {active && <Icon name="check" size={12} className="shrink-0 text-primary" />}
              </button>
            )
          })}
        </div>

        <Button
          size="sm"
          variant="secondary"
          icon={<Icon name="wand" size={12} />}
          className="mt-3 w-full"
          data-testid="mdstudio-open-designer"
          onClick={() => setDesigning(true)}
        >
          {t('mdstudio.designer.open')}
        </Button>

        {/* 微调：改动即 overrides 落稿，画布 150ms debounce 重排 */}
        <h3 className="mb-2 mt-5 text-xs font-semibold text-text-secondary">{t('mdstudio.inspector.tune')}</h3>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="mdstudio-color" className="text-xs font-medium text-text-secondary">
              {t('mdstudio.inspector.color')}
            </label>
            <div className="flex flex-wrap gap-1.5" data-testid="mdstudio-palette">
              {PALETTE.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  title={preset}
                  aria-label={t('mdstudio.inspector.palettePick', { color: preset })}
                  onClick={() => onOverridesChange({ ...overrides, color: preset })}
                  className={`h-6 w-6 rounded-full border transition-transform duration-150 hover:scale-110 ${
                    color.toLowerCase() === preset ? 'border-primary ring-1 ring-primary/40' : 'border-black/10'
                  }`}
                  style={{ backgroundColor: preset }}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                id="mdstudio-color"
                type="color"
                value={color}
                onChange={(e) => onOverridesChange({ ...overrides, color: e.target.value })}
                className="h-9 w-12 cursor-pointer rounded border border-border bg-surface-2 p-1"
              />
              <span className="font-mono text-xs text-text-secondary">{color}</span>
            </div>
          </div>
          <Select
            label={t('mdstudio.inspector.fontSize')}
            value={fontSize}
            options={optionsWith(FONT_SIZES, fontSize)}
            onChange={(e) => onOverridesChange({ ...overrides, fontSize: e.target.value })}
          />
          <Select
            label={t('mdstudio.inspector.lineHeight')}
            value={lineHeight}
            options={optionsWith(LINE_HEIGHTS, lineHeight)}
            onChange={(e) => onOverridesChange({ ...overrides, lineHeight: e.target.value })}
          />
        </div>

        {/* 平台专有：小红书分页状态 + 品牌署名 */}
        {platform === 'xhs' && (
          <div className="mt-5">
            <h3 className="mb-2 text-xs font-semibold text-text-secondary">{t('mdstudio.platform.xhs')}</h3>
            <p
              className={`mb-3 text-xs ${xhsInfo.overflow ? 'font-medium text-warning' : 'text-text-secondary'}`}
              data-testid="mdstudio-xhs-pages"
            >
              {t('mdstudio.inspector.pages', { count: xhsInfo.pageCount, max: XHS_MAX_PAGES })}
              {xhsInfo.overflow && ` · ${t('mdstudio.inspector.pageOverflow')}`}
            </p>
            <Input
              label={t('mdstudio.inspector.footer')}
              value={footer}
              placeholder={t('mdstudio.inspector.footerPlaceholder')}
              onChange={(e) => onFooterChange(e.target.value)}
            />
            {/* 品牌二维码位：读成 dataURL 存 cover.qr（导出时同源、无跨域，体积上限 200KB） */}
            <div className="mt-3 flex flex-col gap-1.5">
              <span className="text-xs font-medium text-text-secondary">{t('mdstudio.inspector.qr')}</span>
              <div className="flex items-center gap-2">
                {qr && (
                  <img
                    src={qr}
                    alt=""
                    className="h-10 w-10 shrink-0 rounded border border-border bg-white object-contain"
                    data-testid="mdstudio-qr-preview"
                  />
                )}
                <label className="flex h-8 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded border border-border bg-surface-2 text-xs text-text-secondary transition-colors hover:border-primary hover:text-primary">
                  <Icon name="upload" size={12} />
                  {qr ? t('mdstudio.inspector.qrReplace') : t('mdstudio.inspector.qrPick')}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    data-testid="mdstudio-qr-input"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (!file) return
                      if (file.size > QR_MAX_BYTES) {
                        toast(t('mdstudio.inspector.qrTooLarge'), 'error')
                        e.target.value = ''
                        return
                      }
                      const reader = new FileReader()
                      reader.onload = () => onQrChange(String(reader.result ?? ''))
                      reader.readAsDataURL(file)
                      e.target.value = ''
                    }}
                  />
                </label>
                {qr && (
                  <button
                    type="button"
                    onClick={() => onQrChange(null)}
                    className="flex h-8 w-8 items-center justify-center rounded border border-border text-text-secondary transition-colors hover:border-error hover:text-error"
                    title={t('mdstudio.inspector.qrRemove')}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 导出按钮组：随平台变；长图全平台通用 */}
        <h3 className="mb-2 mt-5 text-xs font-semibold text-text-secondary">{t('mdstudio.inspector.export')}</h3>
        <div className="flex flex-col gap-2">
          {platform === 'wechat' && (
            <Button
              size="sm"
              icon={<Icon name="copy" size={12} />}
              loading={exporting === 'copy-wechat'}
              disabled={exporting !== null}
              onClick={() => onExport('copy-wechat')}
            >
              {t('mdstudio.export.copyWechat')}
            </Button>
          )}
          {platform === 'zhihu' && (
            <Button
              size="sm"
              icon={<Icon name="copy" size={12} />}
              loading={exporting === 'copy-zhihu'}
              disabled={exporting !== null}
              onClick={() => onExport('copy-zhihu')}
            >
              {t('mdstudio.export.copyZhihu')}
            </Button>
          )}
          {platform === 'xhs' && (
            <>
              <Button
                size="sm"
                icon={<Icon name="downloads" size={12} />}
                loading={exporting === 'zip'}
                disabled={exporting !== null}
                onClick={() => onExport('zip')}
              >
                {t('mdstudio.export.zip')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon={<Icon name="copy" size={12} />}
                loading={exporting === 'copy-caption'}
                disabled={exporting !== null}
                onClick={() => onExport('copy-caption')}
              >
                {t('mdstudio.export.copyCaption')}
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="secondary"
            icon={<Icon name="downloads" size={12} />}
            loading={exporting === 'longimage'}
            disabled={exporting !== null}
            onClick={() => onExport('longimage')}
          >
            {t('mdstudio.export.longimage')}
          </Button>
        </div>
      </div>
    </div>
  )
}
