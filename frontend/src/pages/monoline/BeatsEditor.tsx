/** 逐拍精修：改旁白（单拍重 TTS）/ 换 kind / 拖拽重排 / 挂图 / 换音色 / 换主题。 */

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import { monolineApi, type OutlineEntry } from '../../api'
import { Button, Card, Icon, Select, useToast } from '../../components/ui'
import { MODES } from './modes'

const KIND_OPTIONS = Object.keys(MODES)

type Row = OutlineEntry & { uid: number; old: number }

function SortableBeatRow({
  row,
  index,
  busy,
  onText,
  onResynth,
  onKind,
  onAttach,
  onClearImage,
  fileUrl,
}: {
  row: Row
  index: number
  busy: string | null
  onText: (text: string) => void
  onResynth: () => void
  onKind: (kind: string) => void
  onAttach: (f: File) => void
  onClearImage: () => void
  fileUrl: (rel: string) => string
}) {
  const { t } = useTranslation()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.uid,
  })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex flex-col gap-1 border-b border-border pb-2 ${isDragging ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={t('monoline.dragHint')}
          className="cursor-grab p-0.5 text-text-disabled hover:text-text-secondary active:cursor-grabbing"
        >
          <Icon name="grip" size={14} />
        </button>
        <span className="font-mono text-xs text-text-disabled">#{index + 1}</span>
        <Select
          value={row.kind}
          onChange={(e) => onKind(e.target.value)}
          options={KIND_OPTIONS.map((k) => ({ value: k, label: `${MODES[k].zh} · ${k}` }))}
          className="w-40"
        />
        {row.section && <span className="text-xs text-text-secondary">{row.section}</span>}
        <span className="ml-auto font-mono text-[11px] text-text-disabled">{row.seconds}s</span>
      </div>
      <div className="flex gap-1">
        <input
          value={row.text}
          onChange={(e) => onText(e.target.value)}
          className="min-w-0 flex-1 border border-border bg-surface-1 px-2 py-1 text-sm text-text-primary outline-none focus:border-primary"
        />
        <Button size="sm" disabled={busy !== null} onClick={onResynth}>
          {busy ? '…' : t('monoline.resynth')}
        </Button>
        <label className="flex h-7 cursor-pointer items-center px-2 text-xs text-text-secondary hover:bg-surface-2 hover:text-text-primary">
          {row.image ? '🖼' : t('monoline.attachImage')}
          <input
            type="file"
            accept=".png,.jpg,.jpeg,.webp,.gif"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) onAttach(f)
            }}
          />
        </label>
        {row.image && (
          <>
            <img src={fileUrl(row.image)} alt="" className="h-7 w-7 shrink-0 border border-border object-cover" />
            <Button size="sm" variant="ghost" onClick={onClearImage}>
              {t('monoline.clearImage')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

export function BeatsEditor({ jobId, onChanged }: { jobId: string; onChanged: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [auditionVoice, setAuditionVoice] = useState('')
  const uidRef = useRef(0)
  const { data: voicesData } = useQuery({ queryKey: ['monoline-voices'], queryFn: monolineApi.voices })
  const { data: themesData } = useQuery({ queryKey: ['monoline-themes'], queryFn: monolineApi.themes })

  const load = async () => {
    try {
      const v = await monolineApi.getOutline(jobId)
      setRows(
        v.entries.map((e, i) => ({ ...e, uid: uidRef.current++, old: i })),
      )
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

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = rows.findIndex((r) => r.uid === active.id)
    const to = rows.findIndex((r) => r.uid === over.id)
    if (from < 0 || to < 0) return
    const moved = arrayMove(rows, from, to)
    // order[p] 为新位置 p 上的 OLD 下标（后端形状）
    run('reorder', () => monolineApi.reorder(jobId, moved.map((r) => r.old)))
  }

  const attach = (uid: number, f: File) =>
    run(`img-${uid}`, async () => {
      const { rel } = await monolineApi.uploadAsset(jobId, f)
      const row = rows.find((r) => r.uid === uid)
      if (!row) return
      await monolineApi.patchScene(jobId, row.old, {
        kind: 'image',
        slots: { image: rel, verbatim: true },
      })
    }, t('monoline.attachedOk'))

  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs text-text-secondary">{t('monoline.beatsEdit')}</span>
        <span className="ml-auto flex flex-wrap gap-2">
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
            value={auditionVoice}
            onChange={(e) => setAuditionVoice(e.target.value)}
            options={[
              { value: '', label: t('monoline.auditionPick') },
              ...(voicesData?.voices ?? []).map((v) => ({ value: v.id, label: v.label })),
            ]}
            className="w-36"
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
      {auditionVoice && (
        <div className="mb-2">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio controls src={monolineApi.sampleUrl(auditionVoice)} className="w-full" />
        </div>
      )}
      <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={rows.map((r) => r.uid)} strategy={verticalListSortingStrategy}>
          <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
            {rows.map((r, i) => (
              <SortableBeatRow
                key={r.uid}
                row={r}
                index={i}
                busy={busy}
                onText={(text) => setRows((rs) => rs.map((x) => (x.uid === r.uid ? { ...x, text } : x)))}
                onResynth={() => run(`text-${r.uid}`, () => monolineApi.patchSegment(jobId, r.old, r.text), t('monoline.resynthed'))}
                onKind={(kind) => run(`kind-${r.uid}`, () => monolineApi.patchScene(jobId, r.old, { kind }))}
                onAttach={(f) => attach(r.uid, f)}
                onClearImage={() => run(`img-${r.uid}`, () => monolineApi.patchScene(jobId, r.old, { kind: 'statement', slots: {} }))}
                fileUrl={(rel) => monolineApi.fileUrl(jobId, `composition/${rel}`)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </Card>
  )
}
