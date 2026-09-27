/** 逐拍精修：改旁白（单拍重 TTS）/ 换 kind / 上下重排 / 换音色 / 换主题。 */

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { monolineApi, type OutlineEntry } from '../../api'
import { Button, Card, Select, useToast } from '../../components/ui'
import { MODES } from './modes'

const KIND_OPTIONS = Object.keys(MODES)

export function BeatsEditor({ jobId, onChanged }: { jobId: string; onChanged: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [rows, setRows] = useState<OutlineEntry[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const { data: voicesData } = useQuery({ queryKey: ['monoline-voices'], queryFn: monolineApi.voices })
  const { data: themesData } = useQuery({ queryKey: ['monoline-themes'], queryFn: monolineApi.themes })

  const load = async () => {
    try {
      const v = await monolineApi.getOutline(jobId)
      setRows(v.entries)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error')
    }
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  const run = async (key: string, fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(key)
    try {
      await fn()
      if (okMsg) toast(okMsg, 'success')
      await load()
      onChanged()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  const move = (i: number, d: -1 | 1) => {
    const order = rows.map((_, k) => k)
    const j = i + d
    if (j < 0 || j >= order.length) return
    ;[order[i], order[j]] = [order[j], order[i]]
    // 交换后 order[p] 即新位置 p 上的 OLD 下标，正是后端要的形状
    run(`move-${i}`, () => monolineApi.reorder(jobId, order))
  }

  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-text-secondary">{t('monoline.beatsEdit')}</span>
        <span className="ml-auto flex gap-2">
          <Select
            value=""
            onChange={(e) => {
              if (e.target.value) run('voice', () => monolineApi.revoice(jobId, e.target.value), t('monoline.revoiced'))
            }}
            options={[
              { value: '', label: t('monoline.changeVoice') },
              ...(voicesData?.voices ?? []).map((v) => ({ value: v.id, label: `${v.label} · ${v.id}` })),
            ]}
            className="w-44"
          />
          <Select
            value=""
            onChange={(e) => {
              if (e.target.value) run('theme', () => monolineApi.patchConfig(jobId, { theme: e.target.value }))
            }}
            options={[
              { value: '', label: t('monoline.changeTheme') },
              ...(themesData?.themes ?? []).map((x) => ({ value: x.id, label: x.label || x.id })),
            ]}
            className="w-36"
          />
        </span>
      </div>
      <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
        {rows.map((r, i) => (
          <div key={i} className="flex flex-col gap-1 border-b border-border pb-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-text-disabled">#{i + 1}</span>
              <Select
                value={r.kind}
                onChange={(e) => run(`kind-${i}`, () => monolineApi.patchScene(jobId, i, { kind: e.target.value }))}
                options={KIND_OPTIONS.map((k) => ({ value: k, label: `${MODES[k].zh} · ${k}` }))}
                className="w-40"
              />
              <span className="ml-auto flex gap-1">
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => move(i, -1)}>↑</Button>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => move(i, 1)}>↓</Button>
              </span>
            </div>
            <div className="flex gap-1">
              <input
                value={r.text}
                onChange={(e) => setRows((rs) => rs.map((x, k) => (k === i ? { ...x, text: e.target.value } : x)))}
                className="min-w-0 flex-1 border border-border bg-surface-1 px-2 py-1 text-sm text-text-primary outline-none focus:border-primary"
              />
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() => run(`text-${i}`, () => monolineApi.patchSegment(jobId, i, r.text), t('monoline.resynthed'))}
              >
                {busy === `text-${i}` ? '…' : t('monoline.resynth')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                onClick={() =>
                  run(`suggest-${i}`, async () => {
                    const v = await monolineApi.suggest(jobId, i)
                    if (v.status === 'changed' && v.kind) {
                      const apply = window.confirm(t('monoline.suggestApply', { kind: v.kind }))
                      if (apply) await monolineApi.patchScene(jobId, i, { kind: v.kind, slots: v.slots ?? {} })
                    } else {
                      toast(
                        v.status === 'kept'
                          ? t('monoline.suggestKept')
                          : `${t('monoline.suggestNo')}${v.why?.[0] ?? v.error ?? ''}`,
                        v.status === 'kept' ? 'success' : 'error',
                      )
                    }
                  })}
              >
                {busy === `suggest-${i}` ? '…' : t('monoline.suggest')}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}
