/** 大纲审阅：合并/拆分/删除/重排/改写/pin 类型 → 落盘 → 运行。 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { monolineApi, type OutlineEntry, type OutlineView } from '../../api'
import { Button, Card, EmptyState, Select, Spinner, useToast } from '../../components/ui'
import { MODES } from './modes'

const KIND_OPTIONS = Object.keys(MODES)

export function OutlineTab({ jobId, onPickJob }: { jobId: string | null; onPickJob: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [view, setView] = useState<OutlineView | null>(null)
  const [rows, setRows] = useState<OutlineEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    if (!jobId) return
    setView(null)
    monolineApi
      .getOutline(jobId)
      .then((v) => {
        setView(v)
        setRows(v.entries)
      })
      .catch((e) => toast(e instanceof Error ? e.message : String(e), 'error'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  if (!jobId) {
    return <EmptyState title={t('monoline.noJob')} description={t('monoline.noJobHint')} action={<Button onClick={onPickJob}>{t('monoline.tabJobs')}</Button>} />
  }
  if (!view) return <Spinner />

  const setRow = (i: number, patch: Partial<OutlineEntry>) =>
    setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)))
  const move = (i: number, d: -1 | 1) =>
    setRows((rs) => {
      const j = i + d
      if (j < 0 || j >= rs.length) return rs
      const next = rs.slice()
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  const split = (i: number) => {
    const text = rows[i].text
    if (text.length < 2) return
    const mid = Math.floor(text.length / 2)
    setRows((rs) => {
      const next = rs.slice()
      next.splice(i, 1, { ...rs[i], text: text.slice(0, mid) }, { ...rs[i], text: text.slice(mid) })
      return next
    })
  }
  const apply = async () => {
    setBusy(true)
    try {
      const v = await monolineApi.applyOutline(
        jobId,
        rows.map((r) => ({ text: r.text, kind: r.kind, image: r.image, images: r.images })),
      )
      setView(v)
      setRows(v.entries)
      toast(t('monoline.applied', { beats: v.beats }), 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const run = async (force: boolean) => {
    setRunning(true)
    try {
      await monolineApi.run(jobId, force)
      toast(t('monoline.runQueued'), 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-2">
      <div className="flex items-center gap-3 text-xs text-text-secondary">
        <span>{t('monoline.beats', { n: view.beats })}</span>
        <span>{t('monoline.estSeconds', { n: view.est_seconds })}</span>
        {view.sections.length > 0 && <span>{view.sections.join(' / ')}</span>}
      </div>
      {rows.map((r, i) => (
        <Card key={i} className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-text-disabled">#{i + 1}</span>
            <Select
              value={r.kind}
              onChange={(e) => setRow(i, { kind: e.target.value })}
              options={KIND_OPTIONS.map((k) => ({ value: k, label: `${MODES[k].zh} · ${k}` }))}
              className="w-44"
            />
            {r.section && <span className="text-xs text-text-secondary">{r.section}</span>}
            <span className="ml-auto font-mono text-[11px] text-text-disabled">{r.seconds}s</span>
          </div>
          <textarea
            rows={2}
            value={r.text}
            onChange={(e) => setRow(i, { text: e.target.value })}
            className="w-full border border-border bg-surface-1 p-2 text-sm text-text-primary outline-none focus:border-primary"
          />
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => move(i, -1)}>↑</Button>
            <Button size="sm" variant="ghost" onClick={() => move(i, 1)}>↓</Button>
            <Button size="sm" variant="ghost" onClick={() => split(i)}>{t('monoline.split')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))}>
              {t('common.delete')}
            </Button>
            <label className="flex h-7 cursor-pointer items-center gap-1.5 px-3 text-xs text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary">
              {r.image ? `🖼 ${r.image.slice(7, 15)}…` : t('monoline.attachImage')}
              <input
                type="file"
                accept=".png,.jpg,.jpeg,.webp,.gif"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (!f || !jobId) return
                  try {
                    const { rel } = await monolineApi.uploadAsset(jobId, f)
                    setRow(i, { image: rel, images: [rel], kind: 'image' })
                    toast(t('monoline.attached', { rel }), 'success')
                  } catch (err) {
                    toast(err instanceof Error ? err.message : String(err), 'error')
                  }
                }}
              />
            </label>
            {r.image && (
              <Button size="sm" variant="ghost" onClick={() => setRow(i, { image: '', images: [] })}>
                {t('monoline.clearImage')}
              </Button>
            )}
          </div>
        </Card>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={apply} disabled={busy}>{t('monoline.apply')}</Button>
        <Button variant="secondary" onClick={() => run(false)} disabled={running}>{t('monoline.run')}</Button>
        <Button variant="secondary" onClick={() => run(true)} disabled={running}>{t('monoline.runForce')}</Button>
        <Button
          variant="ghost"
          onClick={async () => {
            try {
              await monolineApi.cancel(jobId)
              toast(t('monoline.cancelled'), 'success')
            } catch (e) {
              toast(e instanceof Error ? e.message : String(e), 'error')
            }
          }}
        >
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}
