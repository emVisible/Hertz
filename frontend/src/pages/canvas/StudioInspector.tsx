import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { studioApi } from '../../api'
import { Icon } from '../../components/ui'
import { useBoardStore } from '../../stores/board'

/**
 * Studio 子面板（HERTZ_RECONSTRUCTION §7.5）：可折叠侧栏，
 * 展示最近一次 Studio 运行的最终产物，一键注入画布成为卡片。
 */
export function StudioInspector({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const addCard = useBoardStore((s) => s.addCard)
  const queryClient = useQueryClient()

  const { data: runs = [] } = useQuery({
    queryKey: ['studio-runs'],
    queryFn: () => studioApi.runs(5),
    enabled: open,
  })
  const latest = runs[0]
  const [content, setContent] = useState('')
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!latest) return
    void studioApi
      .readFile(latest.id, 'final.md')
      .then(setContent)
      .catch(() => setContent(''))
  }, [latest?.id])

  if (!open) return null

  const chunks = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#{1,4}\s/.test(line) && !/^\s*[-*]\s*$/.test(line))

  function injectIntoBoard() {
    if (!latest) return
    const sections = expanded ? chunks : chunks.slice(0, 8)
    for (const chunk of sections) addCard(chunk)
    onClose()
    void queryClient.invalidateQueries({ queryKey: ['studio-runs'] })
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-border bg-surface-1/80 backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Icon name="studio" size={15} />
          {t('canvas.inspector.title')}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className=" p-1 text-text-secondary transition-colors hover:text-text-primary"
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!latest ? (
          <p className="text-xs text-text-disabled">{t('canvas.inspector.empty')}</p>
        ) : (
          <>
            <p className="mb-2 truncate text-xs font-medium text-text-secondary">
              {(latest.context.topic as string) ?? latest.id.slice(0, 8)}
            </p>
            <pre className="whitespace-pre-wrap  border border-border bg-surface-2/60 p-2.5 font-mono text-[11px] leading-relaxed text-text-primary">
              {content || t('canvas.inspector.empty')}
            </pre>
          </>
        )}
      </div>

      <div className="space-y-1 border-t border-border p-2">
        <label className="flex items-center gap-2 px-1 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={expanded}
            onChange={(e) => setExpanded(e.target.checked)}
            className="accent-primary"
          />
          {t('canvas.inspector.all')}（{chunks.length} 段）
        </label>
        <button
          type="button"
          onClick={injectIntoBoard}
          disabled={!latest || chunks.length === 0}
          className="w-full  bg-primary px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('canvas.inspector.inject')}
        </button>
      </div>
    </aside>
  )
}
