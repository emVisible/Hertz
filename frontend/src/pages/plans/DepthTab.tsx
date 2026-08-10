import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'

import { depthsApi } from '../../api'
import { Badge, Button, Card, EmptyState, Icon, Input, useToast } from '../../components/ui'

/**
 * 深度库（v0.3.10）：输出深度档位——并列于 Buff 库/Debuff 库的可维护库。
 * 每档 = 名称 + 注入指令（MD 双栏编辑）。内置五档以代码为准（seed 同步），
 * 用户可增改自定义档位；「正常」档 effect 留空 = 不注入。
 */
export function DepthTab({
  selectedId,
  onSelect,
}: {
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { data: levels = [] } = useQuery({ queryKey: ['depths'], queryFn: depthsApi.list })

  const [name, setName] = useState('')
  const [effect, setEffect] = useState('')
  const [dirty, setDirty] = useState(false)

  const selected = levels.find((l) => l.id === selectedId) ?? null

  useEffect(() => {
    if (!selected) return
    setName(selected.name)
    setEffect(selected.effect)
    setDirty(false)
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (!selectedId) return
    try {
      const level = await depthsApi.update(selectedId, { name, effect })
      await queryClient.invalidateQueries({ queryKey: ['depths'] })
      onSelect(level.id)
      toast(t('buffs.saved'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function restoreDefaults() {
    if (!window.confirm(t('phases.confirmRestore'))) return
    try {
      await depthsApi.restoreDefaults()
      await queryClient.invalidateQueries({ queryKey: ['depths'] })
      onSelect(null)
      toast(t('phases.restoreDefault'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-3">
      {!selected ? (
        <EmptyState icon="wand" title={t('depths.select')} />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <Input
              label={t('buffs.name')}
              value={name}
              onChange={(e) => { setName(e.target.value); setDirty(true) }}
              className="w-48"
            />
            <Badge tone={selected.builtin ? 'neutral' : 'primary'}>{selected.key}</Badge>
            {selected.builtin && <Badge tone="neutral">{t('phases.builtin')}</Badge>}
            <Button onClick={save} disabled={!dirty}>
              <Icon name="check" size={14} />
              {t('buffs.save')}
            </Button>
          </div>

          <Card padded={false} className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <h2 className="text-sm font-semibold">{t('depths.effect')}</h2>
              <span className="flex items-center gap-3">
                <span className="flex items-center gap-1 text-xs text-text-secondary">
                  <Icon name="edit" size={12} aria-hidden />
                  {t('briefs.raw')}
                </span>
                <span className="flex items-center gap-1 text-xs text-text-secondary">
                  <Icon name="eye" size={12} aria-hidden />
                  {t('briefs.preview')}
                </span>
                <span className="text-xs text-text-disabled">{t('buffs.charCount', { count: effect.length })}</span>
              </span>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
              <textarea
                value={effect}
                onChange={(e) => { setEffect(e.target.value); setDirty(true) }}
                spellCheck={false}
                className="min-h-0 resize-none overflow-y-auto bg-transparent p-3 font-mono text-sm leading-relaxed text-text-primary outline-none placeholder:text-text-disabled"
                placeholder={t('depths.effectPlaceholder')}
              />
              <div className="min-h-0 overflow-y-auto border-t border-border p-3 md:border-l md:border-t-0">
                <div className="md-body">
                  <ReactMarkdown>{effect || t('depths.effectPlaceholder')}</ReactMarkdown>
                </div>
              </div>
            </div>
          </Card>

          <p className="text-[10px] font-semibold uppercase tracking-wide text-text-disabled">
            {t('depths.hint')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {levels.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => onSelect(l.id)}
                className={`border px-2 py-1 text-xs transition-colors ${
                  selectedId === l.id
                    ? 'border-primary bg-primary/10 text-text-primary'
                    : 'border-border text-text-secondary hover:border-primary hover:text-primary'
                }`}
              >
                {l.name}
              </button>
            ))}
          </div>
          <div>
            <Button size="sm" variant="secondary" onClick={() => void restoreDefaults()}>
              <Icon name="refresh" size={12} />
              {t('phases.restoreDefault')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
