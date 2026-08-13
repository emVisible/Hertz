import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { aiRegistryApi } from '../../api/ai'
import { Badge } from '../../components/ui'

/** AI 使用记录（v3.0 可读化）：把 caller/operation 的机器码映射成人类语言。 */

const CALLER_LABELS: Record<string, string> = {
  'engine:writer': 'trace.catOrchestration',
  'engine:director': 'trace.catDirector',
  'engine:editor': 'trace.catEditor',
  'engine:visual_director': 'trace.catVisual',
  'engine:distribution': 'trace.catDistribution',
  'engine:build_brief': 'trace.catBrief',
  'pipeline:score': 'trace.catPipeScore',
  'pipeline:script': 'trace.catPipeScript',
  'pipeline:title': 'trace.catPipeTitle',
  'ai:chat': 'trace.catDialogue',
  test: 'trace.catPing',
}

const OPERATION_LABELS: Record<string, string> = {
  chat: 'trace.catDialogue',
  stream_chat: 'trace.catStream',
  score: 'trace.catScore',
  script: 'trace.catScript',
  title: 'trace.catTitle',
  generate_image: 'trace.catImage',
  synthesize: 'trace.catTTS',
}

/** 时间格式化：HH:MM:SS */
function timeOf(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

export function TracePanel() {
  const { t } = useTranslation()
  const [limit, setLimit] = useState(20)
  const { data: calls = [] } = useQuery({
    queryKey: ['ai-trace', limit],
    queryFn: () => aiRegistryApi.trace(undefined, limit),
  })

  if (calls.length === 0) {
    return <p className="py-3 text-center text-xs text-text-disabled">{t('settings.aiTraceEmpty')}</p>
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="divide-y divide-border border border-border">
        {calls.map((c) => (
          <li key={c.id} className="flex items-center gap-2 px-3 py-2 text-xs">
            <span className="w-14 shrink-0 text-text-disabled">{timeOf(c.created_at)}</span>
            <Badge tone={c.status === 'ok' ? 'success' : 'error'}>
              {c.status === 'ok' ? '✓' : '✗'}
            </Badge>
            <span className="w-24 shrink-0 truncate text-text-secondary" title={c.caller}>
              {t(CALLER_LABELS[c.caller] ?? c.caller)}
            </span>
            <span className="shrink-0 text-text-disabled">
              {t(OPERATION_LABELS[c.operation] ?? c.operation)}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-primary" title={c.model_key}>
              {c.model_key}
            </span>
            <span className="shrink-0 text-text-disabled">{c.duration_ms}ms</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-text-disabled">{t('settings.aiTraceHint')}</p>
        <button
          type="button"
          onClick={() => setLimit((l) => (l === 20 ? 100 : 20))}
          className="text-xs text-text-secondary transition-colors hover:text-primary"
        >
          {limit === 20 ? t('settings.aiTraceMore') : t('settings.aiTraceLess')}
        </button>
      </div>
    </div>
  )
}
