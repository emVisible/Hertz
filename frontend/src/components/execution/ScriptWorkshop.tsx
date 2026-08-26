/** 脚本工坊（v0.24 MVP）：语音草稿 → 本地转写 → 逐句编辑 → 入库。
 *
 * 流程：录音/上传 → POST /studio/transcribe → 可编辑文本 → POST /studio/draft-item
 * 产出 text_only 条目走标准流水线（评分→制作→审核）。
 */

import { useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '../../api'
import { Badge, Button, Icon, Input, useToast } from '../../components/ui'

interface Segment {
  start: number
  end: number
  text: string
}

export function ScriptWorkshop() {
  const { t } = useTranslation()
  const toast = useToast()
  const qc = useQueryClient()

  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [segments, setSegments] = useState<Segment[]>([])
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  // ---- 录音控制 ----
  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      chunksRef.current = []
      rec.ondataavailable = (e) => chunksRef.current.push(e.data)
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        void uploadAndTranscribe(blob, 'voice-memo.webm')
      }
      rec.start()
      mediaRecorderRef.current = rec
      setRecording(true)
    } catch {
      toast('麦克风权限被拒绝', 'error')
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop()
    setRecording(false)
  }

  // ---- 文件上传转写 ----
  async function uploadAndTranscribe(file: Blob | File, filename: string) {
    setTranscribing(true)
    try {
      const form = new FormData()
      form.append('file', file, filename)
      const resp = await fetch('/api/studio/transcribe', { method: 'POST', body: form })
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}))
        throw new Error(body.detail || `HTTP ${resp.status}`)
      }
      const data = await resp.json()
      setSegments(data.segments ?? [])
      if (!title && data.text) setTitle(data.text.slice(0, 30))
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setTranscribing(false)
    }
  }

  // ---- 编辑段落文本 ----
  function editSegment(idx: number, text: string) {
    setSegments((prev) => prev.map((s, i) => (i === idx ? { ...s, text } : s)))
  }
  function removeSegment(idx: number) {
    setSegments((prev) => prev.filter((_, i) => i !== idx))
  }

  // ---- 入库 ----
  async function saveAsItem() {
    const content = segments.map((s) => s.text).join('\n\n')
    if (!title.trim() || !content.trim()) {
      toast(t('workshop.titleContentRequired'), 'warning')
      return
    }
    setSaving(true)
    try {
      await api.post('/api/studio/draft-item', { title: title.trim(), content })
      toast(t('workshop.itemCreated'), 'success')
      setSegments([])
      setTitle('')
      await qc.invalidateQueries({ queryKey: ['pipeline-items'] })
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 操作栏 */}
      <div className="flex flex-wrap items-center gap-2">
        {!recording ? (
          <Button size="sm" onClick={() => void startRecording()} disabled={transcribing}>
            <Icon name="play" size={12} />
            {t('workshop.record')}
          </Button>
        ) : (
          <Button size="sm" variant="danger" onClick={stopRecording} className="animate-pulse">
            <Icon name="stop" size={12} />
            {t('workshop.stopRecording')}
          </Button>
        )}
        <label className="cursor-pointer">
          <input
            type="file"
            accept="audio/*,video/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void uploadAndTranscribe(f, f.name)
              e.target.value = ''
            }}
          />
          <span className="flex items-center gap-1.5 border border-border px-3 py-1.5 text-xs text-text-secondary transition-colors hover:border-primary hover:text-primary">
            <Icon name="upload" size={12} />
            {t('workshop.uploadAudio')}
          </span>
        </label>
        {transcribing && (
          <Badge tone="warning">{t('workshop.transcribing')}</Badge>
        )}
      </div>

      {/* 段落编辑器 */}
      {segments.length > 0 && (
        <>
          <Input label={t('workshop.title')} value={title} onChange={(e) => setTitle(e.target.value)} />
          <div className="flex flex-col gap-1.5">
            {segments.map((seg, idx) => (
              <div key={idx} className="group flex items-start gap-2 rounded border border-border bg-surface-1 p-2">
                <span className="w-10 shrink-0 pt-1 font-mono text-[10px] text-text-disabled">
                  {seg.start.toFixed(0)}s
                </span>
                <textarea
                  className="min-h-[36px] w-full resize-y rounded border border-border bg-surface-1 px-2 py-1 text-sm text-text-primary outline-none focus:border-primary"
                  value={seg.text}
                  onChange={(e) => editSegment(idx, e.target.value)}
                  rows={Math.max(1, Math.ceil(seg.text.length / 40))}
                />
                <button
                  type="button"
                  onClick={() => removeSegment(idx)}
                  className="p-0.5 text-text-disabled opacity-0 transition-opacity hover:text-error group-hover:opacity-100"
                  title={t('common.delete')}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSegments([])}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" loading={saving} onClick={() => void saveAsItem()}>
              <Icon name="check" size={12} />
              {t('workshop.createItem')}
            </Button>
          </div>
        </>
      )}

      {/* 空态 */}
      {segments.length === 0 && !recording && !transcribing && (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-text-disabled">
          {t('workshop.emptyHint')}
        </div>
      )}
    </div>
  )
}
