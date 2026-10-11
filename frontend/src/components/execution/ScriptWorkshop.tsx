/** 脚本工坊（v0.24 MVP）：语音草稿 → 本地转写 → 逐句打磨 → 入库。
 *
 * 流程：录音/上传/粘贴 → POST /studio/transcribe → 可编辑文本 → POST /studio/draft-item
 * 产出 text_only 条目走标准流水线（评分→制作→审核）。
 *
 * v0.24 新增：TTS 逐句试听 / 拖拽排序 / 字数+朗读时长 / 总时长预估 / 纯文本输入 / 草稿暂存
 */

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '../../api'
import { aiRegistryApi } from '../../api/ai'
import { Badge, Button, Icon, Input, useToast } from '../../components/ui'

interface Segment {
  start: number
  end: number
  text: string
}

const DRAFT_KEY = 'hertz-workshop-draft'
const CHARS_PER_MIN = 250 // 中文朗读速度
const WORDS_PER_MIN = 150 // 英文朗读速度

/** 估算单段朗读时长（秒）。自动检测中文/英文。 */
function estimateReadingTime(text: string): number {
  const hasCJK = /\p{Script=Han}/u.test(text)
  if (hasCJK) {
    return (text.length / CHARS_PER_MIN) * 60
  }
  const words = text.trim().split(/\s+/).length
  return (words / WORDS_PER_MIN) * 60
}

/** 简单中/英文分句。按标点切分，保留标点。 */
function splitIntoSegments(text: string): Segment[] {
  const sentences = text
    .split(/(?<=[。！？.!?\n])\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
  let offset = 0
  return sentences.map((s) => {
    const readingTime = estimateReadingTime(s)
    const seg: Segment = { start: offset, end: offset + readingTime, text: s }
    offset += readingTime
    return seg
  })
}

function loadDraft(): { segments: Segment[]; title: string } | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    return JSON.parse(raw) as { segments: Segment[]; title: string }
  } catch {
    return null
  }
}

function saveDraft(segments: Segment[], title: string) {
  if (segments.length > 0) {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ segments, title }))
  } else {
    localStorage.removeItem(DRAFT_KEY)
  }
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
  const [inputMode, setInputMode] = useState<'audio' | 'text'>('audio')
  const [textInput, setTextInput] = useState('')
  const [playingIdx, setPlayingIdx] = useState<number | null>(null)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // ---- 恢复草稿 ----
  useEffect(() => {
    const draft = loadDraft()
    if (draft) {
      setSegments(draft.segments)
      setTitle(draft.title)
    }
  }, [])

  // ---- 自动保存草稿 ----
  useEffect(() => {
    saveDraft(segments, title)
  }, [segments, title])

  // ---- 清理音频 ----
  useEffect(() => {
    return () => {
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [])

  // ---- 派生统计 ----
  const totalChars = useMemo(
    () => segments.reduce((n, s) => n + s.text.length, 0),
    [segments],
  )
  const totalReadingSec = useMemo(
    () => segments.reduce((n, s) => n + estimateReadingTime(s.text), 0),
    [segments],
  )

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
      toast(t('workshop.micDenied', '麦克风权限被拒绝'), 'error')
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

  // ---- 纯文本输入 → 分句 ----
  function convertTextToSegments() {
    if (!textInput.trim()) return
    const segs = splitIntoSegments(textInput)
    setSegments(segs)
    if (!title) setTitle(textInput.trim().slice(0, 30))
    setTextInput('')
  }

  // ---- 段落编辑 ----
  function editSegment(idx: number, text: string) {
    setSegments((prev) => prev.map((s, i) => (i === idx ? { ...s, text } : s)))
  }
  function removeSegment(idx: number) {
    setSegments((prev) => prev.filter((_, i) => i !== idx))
  }

  // ---- 拖拽排序 ----
  function onDragStart(idx: number) {
    setDragIdx(idx)
  }
  function onDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault()
    if (dragIdx === null || dragIdx === idx) return
    setSegments((prev) => {
      const next = [...prev]
      const [moved] = next.splice(dragIdx, 1)
      next.splice(idx, 0, moved)
      return next
    })
    setDragIdx(idx)
  }
  function onDragEnd() {
    setDragIdx(null)
  }

  // ---- TTS 试听 ----
  async function previewSegment(idx: number) {
    const text = segments[idx]?.text
    if (!text) return
    // 停止当前播放
    audioRef.current?.pause()
    if (playingIdx === idx) {
      setPlayingIdx(null)
      return
    }
    setPlayingIdx(idx)
    try {
      const bytes = await aiRegistryApi.ttsTest(text, '')
      const blob = new Blob([bytes], { type: 'audio/mpeg' })
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => {
        setPlayingIdx(null)
        URL.revokeObjectURL(url)
      }
      audio.onerror = () => {
        setPlayingIdx(null)
        URL.revokeObjectURL(url)
      }
      await audio.play()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
      setPlayingIdx(null)
    }
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
      localStorage.removeItem(DRAFT_KEY)
      await qc.invalidateQueries({ queryKey: ['pipeline-items'] })
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  function formatTime(sec: number): string {
    const m = Math.floor(sec / 60)
    const s = Math.round(sec % 60)
    return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 模式切换 + 操作栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex border border-border">
          <button
            type="button"
            className={`px-3 py-1 text-xs transition-colors ${
              inputMode === 'audio'
                ? 'bg-primary text-white'
                : 'text-text-secondary hover:bg-surface-2'
            }`}
            onClick={() => setInputMode('audio')}
          >
            {t('workshop.modeAudio', '语音')}
          </button>
          <button
            type="button"
            className={`px-3 py-1 text-xs transition-colors ${
              inputMode === 'text'
                ? 'bg-primary text-white'
                : 'text-text-secondary hover:bg-surface-2'
            }`}
            onClick={() => setInputMode('text')}
          >
            {t('workshop.modeText', '文本')}
          </button>
        </div>

        {inputMode === 'audio' ? (
          <>
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
            {transcribing && <Badge tone="warning">{t('workshop.transcribing')}</Badge>}
          </>
        ) : (
          <>
            <textarea
              className="min-h-[80px] w-full resize-y rounded border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary outline-none focus:border-primary"
              placeholder={t('workshop.textPlaceholder', '在此粘贴或输入文本，按标点自动分句…')}
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
            />
            <Button size="sm" onClick={convertTextToSegments} disabled={!textInput.trim()}>
              <Icon name="check" size={12} />
              {t('workshop.convertText', '分句')}
            </Button>
          </>
        )}
      </div>

      {/* 段落编辑器 */}
      {segments.length > 0 && (
        <>
          <Input label={t('workshop.title')} value={title} onChange={(e) => setTitle(e.target.value)} />

          {/* 统计栏 */}
          <div className="flex items-center gap-4 text-xs text-text-secondary">
            <span>{t('workshop.segmentCount', { n: segments.length })}</span>
            <span>{t('workshop.charCount', { n: totalChars })}</span>
            <span>{t('workshop.readingTime', { t: formatTime(totalReadingSec) })}</span>
          </div>

          <div className="flex flex-col gap-1.5">
            {segments.map((seg, idx) => {
              const readSec = estimateReadingTime(seg.text)
              return (
                <div
                  key={idx}
                  draggable
                  onDragStart={() => onDragStart(idx)}
                  onDragOver={(e) => void onDragOver(e, idx)}
                  onDragEnd={onDragEnd}
                  className={`group flex items-start gap-2 rounded border bg-surface-1 p-2 transition-colors ${
                    dragIdx === idx
                      ? 'border-primary opacity-50'
                      : 'border-border'
                  }`}
                >
                  {/* 拖拽手柄 */}
                  <span className="cursor-grab pt-1 text-text-disabled active:cursor-grabbing">
                    <Icon name="grip" size={12} />
                  </span>
                  <span className="w-10 shrink-0 pt-1 font-mono text-[10px] text-text-disabled">
                    {idx + 1}
                  </span>
                  <div className="flex flex-1 flex-col gap-1">
                    <textarea
                      className="min-h-[36px] w-full resize-y rounded border border-border bg-surface-1 px-2 py-1 text-sm text-text-primary outline-none focus:border-primary"
                      value={seg.text}
                      onChange={(e) => editSegment(idx, e.target.value)}
                      rows={Math.max(1, Math.ceil(seg.text.length / 40))}
                    />
                    <div className="flex items-center gap-3 text-[10px] text-text-disabled">
                      <span>{seg.text.length} {t('workshop.chars', '字')}</span>
                      <span>~{formatTime(readSec)}</span>
                    </div>
                  </div>
                  {/* TTS 试听 */}
                  <button
                    type="button"
                    onClick={() => void previewSegment(idx)}
                    className={`p-0.5 transition-opacity ${
                      playingIdx === idx
                        ? 'text-primary animate-pulse'
                        : 'text-text-disabled opacity-0 group-hover:opacity-100 hover:text-primary'
                    }`}
                    title={t('workshop.preview', '试听')}
                  >
                    <Icon name={playingIdx === idx ? 'stop' : 'play'} size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeSegment(idx)}
                    className="p-0.5 text-text-disabled opacity-0 transition-opacity hover:text-error group-hover:opacity-100"
                    title={t('common.delete')}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              )
            })}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setSegments([]); setTitle(''); localStorage.removeItem(DRAFT_KEY) }}>
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              loading={saving}
              onClick={() => void saveAsItem()}
              icon={<Icon name="check" size={12} />}
            >
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
