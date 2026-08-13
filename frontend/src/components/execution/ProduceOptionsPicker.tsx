import { useTranslation } from 'react-i18next'

import type { ProduceModule, ProduceOptions } from '../../api/pipeline'

/** 生产方式模块（v0.3.3，预处理人工选择，单一真相源）：
 *  直发（互斥）/ 配音 / 字幕 / 翻译（仅字幕翻译，自动附带字幕）/ 静音 */
export const PRODUCE_MODULES: Array<{ id: ProduceModule }> = [
  { id: 'passthrough' },
  { id: 'voice' },
  { id: 'subtitle' },
  { id: 'translate' },
  { id: 'mute' },
]

/** 空选项（默认 = 翻译+字幕：原视频翻译成中文字幕，不配音） */
export const DEFAULT_PRODUCE_OPTIONS: ProduceOptions = {
  passthrough: false,
  voice: false,
  subtitle: true,
  translate: true,
  mute: false,
}

export function normalizeOptions(raw: Partial<ProduceOptions> | null | undefined): ProduceOptions {
  const opts = { ...DEFAULT_PRODUCE_OPTIONS, ...(raw ?? {}) } as ProduceOptions
  // 互斥：直发清除其他加工模块；翻译自动附带字幕
  if (opts.passthrough) {
    opts.voice = opts.subtitle = opts.translate = opts.mute = false
  } else if (opts.translate) {
    opts.subtitle = true
  }
  return opts
}

/** 生产方式模块多选 chips（直发互斥高亮、翻译自动勾字幕）。 */
export function ProduceOptionsPicker({
  value,
  onChange,
  compact = false,
}: {
  value: ProduceOptions
  onChange: (next: ProduceOptions) => void
  compact?: boolean
}) {
  const { t } = useTranslation()

  function toggle(module: ProduceModule) {
    const next = { ...value }
    if (module === 'passthrough') {
      // 直发互斥：选中清除其他，取消则恢复默认组合
      if (next.passthrough) {
        return { ...DEFAULT_PRODUCE_OPTIONS }
      }
      next.passthrough = true
      next.voice = next.subtitle = next.translate = next.mute = false
      return next
    }
    if (module === 'translate') {
      // 翻译 = 仅字幕翻译：自动附带字幕
      next.translate = !next.translate
      if (next.translate) next.subtitle = true
      return next
    }
    next[module] = !next[module]
    return next
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {PRODUCE_MODULES.map((m) => {
        const active = value[m.id]
        const disabled = m.id === 'subtitle' && value.translate // 翻译已含字幕
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => {
              const next = toggle(m.id)
              if (next !== value) onChange(next)
            }}
            disabled={disabled}
            title={t(`console.produce.${m.id}Hint`)}
            className={`${compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs'} border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              m.id === 'passthrough'
                ? active
                  ? 'border-warning/60 bg-warning/15 text-warning'
                  : 'border-border text-text-secondary hover:border-warning/40 hover:text-warning'
                : active
                  ? 'border-primary/50 bg-primary/15 text-primary'
                  : 'border-border text-text-secondary hover:border-text-disabled/50 hover:text-text-primary'
            }`}
          >
            {t(`console.produce.${m.id}`)}
          </button>
        )
      })}
    </div>
  )
}
