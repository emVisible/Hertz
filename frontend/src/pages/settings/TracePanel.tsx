import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { aiRegistryApi } from '../../api/ai'
import { Badge } from '../../components/ui'

/** AI 使用记录（v3.0 可读化）：把 caller/operation 的机器码映射成人类语言。 */

const CALLER_LABELS: Record<string, string> = {
  'engine:writer': '编排·内容创作',
  'engine:director': '编排·创意定调',
  'engine:editor': '编排·质量审校',
  'engine:visual_director': '编排·视觉设计',
  'engine:distribution': '编排·分发策略',
  'engine:build_brief': '编排·创意策略',
  'pipeline:score': '流水线·评分',
  'pipeline:script': '流水线·脚本',
  'pipeline:title': '流水线·标题',
  'ai:chat': '对话',
  test: '连通性测试',
}

const OPERATION_LABELS: Record<string, string> = {
  chat: '对话',
  stream_chat: '流式对话',
  score: '评分',
  script: '脚本',
  title: '标题',
  generate_image: '出图',
  synthesize: '语音合成',
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
              {CALLER_LABELS[c.caller] ?? c.caller}
            </span>
            <span className="shrink-0 text-text-disabled">
              {OPERATION_LABELS[c.operation] ?? c.operation}
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
