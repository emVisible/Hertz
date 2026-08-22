import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '../../api'
import { Badge, Button, Icon, Input, QueryErrorState } from '../../components/ui'

interface GlossaryTerm {
  id: string
  source_term: string
  target_term: string
  domain: string
  enabled: boolean
}

/** 翻译术语表管理（v0.15）：CRUD + AI 辅助生成候选（勾选入库）。 */
export function GlossaryManager() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [query, setQuery] = useState('')
  const [draftSource, setDraftSource] = useState('')
  const [draftTarget, setDraftTarget] = useState('')
  const [sampleText, setSampleText] = useState('')
  const [candidates, setCandidates] = useState<GlossaryTerm[]>([])
  const [suggesting, setSuggesting] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['glossary', query],
    queryFn: () =>
      api.get<{ terms: GlossaryTerm[] }>(
        `/api/glossary?limit=500${query ? `&query=${encodeURIComponent(query)}` : ''}`,
      ),
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['glossary'] })

  async function add() {
    if (!draftSource.trim() || !draftTarget.trim()) return
    await api.post('/api/glossary', {
      source_term: draftSource.trim(),
      target_term: draftTarget.trim(),
    })
    setDraftSource('')
    setDraftTarget('')
    invalidate()
  }

  async function suggest() {
    if (!sampleText.trim()) return
    setSuggesting(true)
    try {
      const res = await api.post<{ candidates: GlossaryTerm[] }>('/api/glossary/suggest', {
        text: sampleText,
      })
      // 已存在的术语不再重复推荐（source 幂等，重复添加只会更新）
      const existing = new Set((data?.terms ?? []).map((x) => x.source_term))
      setCandidates(res.candidates.filter((c) => !existing.has(c.source_term)))
    } finally {
      setSuggesting(false)
    }
  }

  async function addCandidate(c: GlossaryTerm) {
    await api.post('/api/glossary', c)
    setCandidates((prev) => prev.filter((x) => x.source_term !== c.source_term))
    invalidate()
  }

  async function toggle(term: GlossaryTerm) {
    await api.put(`/api/glossary/${term.id}`, { enabled: !term.enabled })
    invalidate()
  }

  async function remove(term: GlossaryTerm) {
    await api.delete(`/api/glossary/${term.id}`)
    invalidate()
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-text-secondary">{t('settings.glossaryHint')}</p>

      {/* AI 辅助生成：粘贴样例文本 → 候选术语 */}
      <details className="rounded-md border border-border/60 p-2">
        <summary className="cursor-pointer select-none text-[11px] text-text-secondary hover:text-text-primary">
          {t('settings.glossarySuggest')}
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          <textarea
            value={sampleText}
            onChange={(e) => setSampleText(e.target.value)}
            rows={3}
            placeholder={t('settings.glossarySamplePlaceholder')}
            className="w-full resize-y border border-border bg-surface-1 px-2 py-1 font-mono text-xs text-text-primary outline-none placeholder:text-text-disabled focus:border-primary"
          />
          <Button size="sm" variant="secondary" className="self-end" loading={suggesting} disabled={!sampleText.trim()} onClick={() => void suggest()}>
            <Icon name="wand" size={12} />
            {t('settings.glossaryExtract')}
          </Button>
          {candidates.length > 0 && (
            <ul className="space-y-1">
              {candidates.map((c) => (
                <li key={c.source_term} className="flex items-center gap-2 border border-border/50 px-2 py-1 text-xs">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-mono text-text-secondary">{c.source_term}</span>
                    {' → '}
                    <span className="text-text-primary">{c.target_term}</span>
                  </span>
                  <Button size="sm" onClick={() => void addCandidate(c)}>
                    {t('common.add')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>

      {/* 手动新增 */}
      <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
        <Input label={t('settings.glossarySource')} value={draftSource} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraftSource(e.target.value)} />
        <Input label={t('settings.glossaryTarget')} value={draftTarget} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraftTarget(e.target.value)} />
        <Button size="sm" disabled={!draftSource.trim() || !draftTarget.trim()} onClick={() => void add()}>
          {t('common.add')}
        </Button>
      </div>

      {/* 列表 */}
      {error ? (
        <QueryErrorState message={error instanceof Error ? error.message : String(error)} />
      ) : isLoading ? (
        <p className="py-4 text-center text-xs text-text-disabled">{t('common.loading')}</p>
      ) : (data?.terms.length ?? 0) === 0 ? (
        <p className="py-4 text-center text-xs text-text-disabled">{t('settings.glossaryEmpty')}</p>
      ) : (
        <>
          <input
            type="search"
            value={query}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
            placeholder={t('settings.glossarySearch')}
            className="h-7 rounded-sm border border-border bg-surface-1 px-2 text-xs outline-none focus:border-primary"
          />
          <ul className="max-h-72 overflow-y-auto">
            {(data?.terms ?? []).map((term) => (
              <li key={term.id} className="flex items-center gap-2 border-b border-border/40 py-1.5 last:border-0">
                <button
                  type="button"
                  onClick={() => void toggle(term)}
                  title={t('settings.glossaryToggle')}
                  className={`h-4 w-8 shrink-0 rounded-full transition-colors ${term.enabled ? 'bg-success/70' : 'bg-surface-2'}`}
                >
                  <span
                    className={`block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${term.enabled ? 'translate-x-4' : 'translate-x-0.5'}`}
                  />
                </button>
                <span className="min-w-0 flex-1 truncate text-xs">
                  <span className="font-mono text-text-secondary">{term.source_term}</span>
                  {' → '}
                  <span className="font-medium text-text-primary">{term.target_term}</span>
                </span>
                {term.domain && <Badge tone="neutral">{t(`settings.glossaryDomain.${term.domain}`, { defaultValue: term.domain })}</Badge>}
                <Button size="sm" variant="ghost" onClick={() => void remove(term)} title={t('common.delete')}>
                  <Icon name="trash" size={12} />
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
