import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { api } from '../api'
import { plansApi } from '../api/orchestration'
import type { LibraryEntry } from '../api/library'
import { Icon } from './ui'
import { useExecutionStore } from '../stores/execution'
import { useBoardStore } from '../stores/board'

interface CommandItem {
  id: string
  group: string
  label: string
  hint?: string
  icon?: 'studio' | 'plans' | 'config' | 'canvas' | 'console' | 'box' | 'search' | 'play'
  run: () => void
}

const SETTINGS_SECTIONS = [
  { id: 'general', labelKey: 'settings.general' },
  { id: 'ai', labelKey: 'settings.ai' },
  { id: 'prompts', labelKey: 'settings.prompts' },
  { id: 'trace', labelKey: 'settings.usage' },
  { id: 'pipeline', labelKey: 'settings.pipeline' },
] as const

/**
 * ⌘K 全局命令面板（v0.2.3，参考 Eagle 快速搜索/Notion）：
 * 素材全局搜索 + 计划/设置导航 + 快捷动作。↑↓ 选择、Enter 执行、Esc 关闭。
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<CommandItem[]>([])
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seqRef = useRef(0)

  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  // 素材搜索：防抖 200ms + 序号守卫（慢的旧响应不覆盖新结果，§7.2/§20.3）
  useEffect(() => {
    if (!open) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const q = query.trim()
    if (q.length < 2) {
      setItems([])
      return
    }
    const seq = ++seqRef.current
    debounceRef.current = setTimeout(() => {
      void api
        .get<{ entries: LibraryEntry[] }>(`/api/library/search?q=${encodeURIComponent(q)}&limit=8`)
        .then(({ entries }) => {
          if (seq !== seqRef.current) return
          setItems(
            entries.map((e) => ({
              id: `asset:${e.path}`,
              group: t('command.assets'),
              label: e.name,
              hint: e.tags?.length ? e.tags.slice(0, 3).join(', ') : e.kind,
              icon: 'box' as const,
              run: () => navigate(`/assets?path=${encodeURIComponent(e.path)}`),
            })),
          )
        })
        .catch(() => {
          if (seq === seqRef.current) setItems([])
        })
    }, 200)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, open, t, navigate])

  // 计划列表（react-query 单一数据源，§35 数据驱动）
  const { data: plans = [] } = useQuery({ queryKey: ['plans'], queryFn: plansApi.list })

  // 静态项：计划 / 设置 / 快捷动作（无查询时也展示，命令面板可发现性）
  const staticItems: CommandItem[] = useMemo(() => {
    const out: CommandItem[] = []
    const q = query.trim().toLowerCase()
    const match = (s: string) => !q || s.toLowerCase().includes(q)
    if (match(t('command.plan'))) {
      out.push({
        id: 'action:studio',
        group: t('command.actions'),
        label: t('command.runStudio'),
        hint: t('command.runStudioHint'),
        icon: 'studio',
        run: () => {
          navigate('/execution?mode=studio')
          onClose()
        },
      })
      out.push({
        id: 'action:pipeline',
        group: t('command.actions'),
        label: t('command.runPipeline'),
        hint: t('command.runPipelineHint'),
        icon: 'console',
        run: () => {
          navigate('/execution?mode=pipeline')
          onClose()
        },
      })
      out.push({
        id: 'action:monoline',
        group: t('command.actions'),
        label: t('command.openMonoline'),
        hint: t('command.openMonolineHint'),
        icon: 'play',
        run: () => {
          navigate('/monoline')
          onClose()
        },
      })
      out.push({
        id: 'action:board',
        group: t('command.actions'),
        label: t('command.newBoard'),
        hint: t('command.newBoardHint'),
        icon: 'canvas',
        run: () => {
          useBoardStore.getState().addBoard()
          navigate('/canvas')
          onClose()
        },
      })
    }
    for (const p of plans) {
      if (!match(p.name)) continue
      out.push({
        id: `plan:${p.id}`,
        group: t('command.plans'),
        label: p.name,
        icon: 'plans',
        run: () => {
          useExecutionStore.getState().setStudio({ planId: p.id })
          navigate('/execution?mode=studio')
          onClose()
        },
      })
    }
    for (const s of SETTINGS_SECTIONS) {
      if (!match(t(s.labelKey))) continue
      out.push({
        id: `settings:${s.id}`,
        group: t('command.settings'),
        label: t(s.labelKey),
        icon: 'config',
        run: () => {
          navigate(`/config?section=${s.id}`)
          onClose()
        },
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, t, navigate, onClose, plans])

  const groups = useMemo(() => {
    const merged = [...items, ...staticItems]
    const map = new Map<string, CommandItem[]>()
    for (const item of merged) {
      const list = map.get(item.group) ?? []
      if (list.length === 0) map.set(item.group, list)
      list.push(item)
    }
    return [...map.entries()]
  }, [items, staticItems])

  useEffect(() => {
    setCursor(0)
  }, [query])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const flat = groups.flatMap(([, list]) => list)

  function runAt(index: number) {
    const item = flat[index]
    if (item) item.run()
  }

  if (!open) return null

  return (
    <div
      className="hz-overlay-in fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-lg rounded-lg border border-border bg-surface-1 shadow-lg">
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Icon name="search" size={15} className="shrink-0 text-text-disabled" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('command.placeholder')}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCursor((c) => Math.min(c + 1, Math.max(flat.length - 1, 0)))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCursor((c) => Math.max(c - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                runAt(cursor)
              }
            }}
            placeholder={t('command.placeholder')}
            className="h-11 w-full bg-transparent text-sm text-text-primary outline-none placeholder:text-text-disabled"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-1.5">
          {groups.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-text-disabled">{t('command.empty')}</p>
          )}
          {groups.map(([group, list]) => (
            <div key={group} className="mb-1">
              <p className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-text-disabled">
                {group}
              </p>
              {list.map((item) => {
                const index = flat.indexOf(item)
                const active = index === cursor
                return (
                  <button
                    key={item.id}
                    type="button"
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => item.run()}
                    className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm transition-colors ${
                      active ? 'bg-primary/15 text-text-primary' : 'text-text-secondary'
                    }`}
                  >
                    {item.icon && <Icon name={item.icon} size={14} className="shrink-0 text-text-disabled" />}
                    <span className="min-w-0 truncate">{item.label}</span>
                    {item.hint && <span className="ml-auto shrink-0 truncate text-[10px] text-text-disabled">{item.hint}</span>}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
