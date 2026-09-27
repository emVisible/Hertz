/** 逐拍精修：改旁白（单拍重 TTS）/ 换 kind / 版式 / 图标 / 拖拽重排 / 挂图 / 换音色 / 换主题。 */

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

import { monolineApi, type OutlineEntry } from '../../api'
import { Button, Card, Icon, Modal, Select, useToast } from '../../components/ui'
import { MODES, VARIANTS } from './modes'

const KIND_OPTIONS = Object.keys(MODES)

function VoiceMiniSelect({ onVoice }: { onVoice: (voice: string) => void }) {
  const { t } = useTranslation()
  const { data } = useQuery({ queryKey: ['monoline-voices'], queryFn: monolineApi.voices })
  return (
    <Select
      value=""
      onChange={(e) => {
        if (e.target.value) onVoice(e.target.value)
        e.target.value = ''
      }}
      options={[
        { value: '', label: t('monoline.beatVoice') },
        ...(data?.voices ?? []).map((v) => ({ value: v.id, label: v.label })),
      ]}
      className="w-28"
    />
  )
}

type Row = OutlineEntry & { uid: number; old: number }

function SortableBeatRow({
  row,
  index,
  busy,
  focusRef,
  onText,
  onResynth,
  onKind,
  onVoice,
  onVariant,
  onIcon,
  onSlots,
  onMergeUp,
  onAttach,
  onClearImage,
  fileUrl,
}: {
  row: Row
  index: number
  busy: string | null
  focusRef: (i: number, el: HTMLInputElement | null) => void
  onText: (text: string) => void
  onResynth: () => void
  onKind: (kind: string) => void
  onVariant: (variant: string) => void
  onVoice: (voice: string) => void
  onIcon: () => void
  onSlots: (slots: string) => void
  onMergeUp: () => void
  onAttach: (f: File) => void
  onClearImage: () => void
  fileUrl: (rel: string) => string
}) {
  const { t } = useTranslation()
  const [slotsText, setSlotsText] = useState('')
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.uid,
  })
  const slots = (row as unknown as { slots?: Record<string, unknown> }).slots ?? {}
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
        <VoiceMiniSelect onVoice={onVoice} />
        <Select
          value={String(slots.variant ?? '')}
          onChange={(e) => onVariant(e.target.value)}
          options={[
            { value: '', label: t('monoline.variantAuto') },
            ...VARIANTS.map((v) => ({ value: v.id, label: v.zh })),
          ]}
          className="w-24"
        />
        <button
          type="button"
          onClick={onIcon}
          title={t('monoline.pickIcon')}
          className="border border-border px-2 py-1 text-xs text-text-secondary hover:bg-surface-2 hover:text-text-primary"
        >
          {typeof slots.icon === 'string' && slots.icon ? `◈ ${slots.icon}` : t('monoline.pickIcon')}
        </button>
        {row.section && <span className="text-xs text-text-secondary">{row.section}</span>}
        <span className="ml-auto font-mono text-[11px] text-text-disabled">{row.seconds}s</span>
      </div>
      <div className="flex gap-1">
        <input
          ref={(el) => focusRef(index, el)}
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
        {index > 0 && (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={onMergeUp}>
            {t('monoline.mergeUp')}
          </Button>
        )}
        {row.image && (
          <>
            <img src={fileUrl(row.image)} alt="" className="h-7 w-7 shrink-0 border border-border object-cover" />
            <Button size="sm" variant="ghost" onClick={onClearImage}>
              {t('monoline.clearImage')}
            </Button>
          </>
        )}
      </div>
      <details className="text-xs" onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open) setSlotsText(JSON.stringify(slots, null, 1))
      }}>
        <summary className="cursor-pointer text-text-disabled hover:text-text-secondary">
          {t('monoline.slotsJson')}
        </summary>
        <textarea
          rows={3}
          value={slotsText}
          onChange={(e) => setSlotsText(e.target.value)}
          spellCheck={false}
          className="mt-1 w-full border border-border bg-surface-1 p-1 font-mono text-[11px] text-text-primary outline-none focus:border-primary"
        />
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => onSlots(slotsText)}>
          {t('monoline.slotsApply')}
        </Button>
      </details>
    </div>
  )
}

function IconPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean
  onClose: () => void
  onPick: (name: string) => void
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const { data } = useQuery({
    queryKey: ['monoline-icons'],
    queryFn: monolineApi.icons,
    enabled: open,
  })
  const icons = data?.icons ?? []
  const s = q.trim().toLowerCase()
  const shown = (s ? icons.filter((x) => x.name.includes(s)) : icons).slice(0, 120)
  return (
    <Modal open={open} title={t('monoline.pickIcon')} onClose={onClose} width={560}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('monoline.iconSearch')}
        autoFocus
        className="mb-2 w-full border border-border bg-surface-1 px-2 py-1 text-sm text-text-primary outline-none focus:border-primary"
      />
      <div className="grid max-h-80 grid-cols-6 gap-1 overflow-y-auto">
        {shown.map((x) => (
          <button
            key={x.name}
            type="button"
            title={x.name}
            onClick={() => {
              onPick(x.name)
              onClose()
            }}
            className="flex flex-col items-center gap-0.5 border border-border p-1.5 text-text-secondary hover:border-primary hover:text-text-primary"
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{
              __html: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${x.body}</svg><span style="font-size:9px">${x.name}</span>`,
            }}
          />
        ))}
      </div>
    </Modal>
  )
}

export function BeatsEditor({ jobId, onChanged }: { jobId: string; onChanged: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [auditionVoice, setAuditionVoice] = useState('')
  const [iconFor, setIconFor] = useState<number | null>(null)
  const uidRef = useRef(0)
  const inputRefs = useRef<Array<HTMLInputElement | null>>([])
  const { data: voicesData } = useQuery({ queryKey: ['monoline-voices'], queryFn: monolineApi.voices })
  const { data: themesData } = useQuery({ queryKey: ['monoline-themes'], queryFn: monolineApi.themes })

  const load = async () => {
    try {
      const v = await monolineApi.getOutline(jobId)
      setRows(v.entries.map((e, i) => ({ ...e, uid: uidRef.current++, old: i })))
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error')
    }
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  // j/k 焦点上下拍，1-9 跳拍（输入框聚焦时不劫持）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'j' || e.key === 'k') {
        const cur = inputRefs.current.findIndex((el) => el === document.activeElement)
        const next = e.key === 'j' ? cur + 1 : cur - 1
        if (next >= 0 && next < inputRefs.current.length) {
          e.preventDefault()
          inputRefs.current[next]?.focus()
        }
      } else if (/^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1
        if (idx < inputRefs.current.length) {
          e.preventDefault()
          inputRefs.current[idx]?.focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
    const order = rows.map((r) => r.old)
    const from = rows.findIndex((r) => r.uid === active.id)
    const to = rows.findIndex((r) => r.uid === over.id)
    if (from < 0 || to < 0) return
    ;[order[from], order[to]] = [order[to], order[from]]
    run('reorder', () => monolineApi.reorder(jobId, order))
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

  const mergeUp = (uid: number) =>
    run(`merge-${uid}`, async () => {
      const idx = rows.findIndex((r) => r.uid === uid)
      if (idx <= 0) return
      const merged = rows.map((r) => ({
        text: r.text,
        kind: r.kind,
        image: r.image,
        images: r.images,
      }))
      merged[idx - 1] = {
        ...merged[idx - 1],
        text: `${merged[idx - 1].text}${merged[idx].text}`,
      }
      merged.splice(idx, 1)
      await monolineApi.applyOutline(jobId, merged)
    }, t('monoline.mergedOk'))

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
                focusRef={(idx, el) => {
                  inputRefs.current[idx] = el
                }}
                onText={(text) => setRows((rs) => rs.map((x) => (x.uid === r.uid ? { ...x, text } : x)))}
                onResynth={() => run(`text-${r.uid}`, () => monolineApi.patchSegment(jobId, r.old, r.text), t('monoline.resynthed'))}
                onKind={(kind) => run(`kind-${r.uid}`, () => monolineApi.patchScene(jobId, r.old, { kind }))}
                onVoice={(voice) => run(`voice-${r.uid}`, () => monolineApi.revoiceBeat(jobId, r.old, voice), t('monoline.revoiced'))}
                onVariant={(variant) =>
                  run(`variant-${r.uid}`, () =>
                    monolineApi.patchScene(jobId, r.old, { slots: { variant: variant || null } }))}
                onIcon={() => setIconFor(r.uid)}
                onSlots={(raw) => {
                  let slots: Record<string, unknown>
                  try {
                    slots = JSON.parse(raw) as Record<string, unknown>
                  } catch {
                    toast(t('monoline.slotsBadJson'), 'error')
                    return Promise.resolve()
                  }
                  return run(`slots-${r.uid}`, () => monolineApi.patchScene(jobId, r.old, { slots }))
                }}
                onMergeUp={() => mergeUp(r.uid)}
                onAttach={(f) => attach(r.uid, f)}
                onClearImage={() => run(`img-${r.uid}`, () => monolineApi.patchScene(jobId, r.old, { kind: 'statement', slots: {} }))}
                fileUrl={(rel) => monolineApi.fileUrl(jobId, `composition/${rel}`)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <IconPicker
        open={iconFor !== null}
        onClose={() => setIconFor(null)}
        onPick={(name) => {
          const row = rows.find((r) => r.uid === iconFor)
          if (row) run(`icon-${row.uid}`, () => monolineApi.patchScene(jobId, row.old, { slots: { icon: name } }))
        }}
      />
    </Card>
  )
}
