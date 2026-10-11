import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'

import { api } from '../../api'
import { Badge, Button, Icon, Modal, useToast } from '../../components/ui'

interface PromptTemplateDTO {
  id: string
  key: string
  name: string
  category: string
  content: string
  version: number
  customized: boolean
  updated_at: string | null
}

const CATEGORY_LABELS: Record<string, string> = {
  agent: 'Agent',
  brief: 'Brief',
  synthesis: 'Synthesis',
}

/** 提示词模板库（v2.4）：查看/编辑系统提示词，改后立即生效（下次运行）。 */
export function PromptsManager() {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { data: prompts = [] } = useQuery({
    queryKey: ['ai-prompts'],
    queryFn: () => api.get<PromptTemplateDTO[]>('/api/ai/prompts'),
  })
  const [editing, setEditing] = useState<PromptTemplateDTO | null>(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  function open(p: PromptTemplateDTO) {
    setEditing(p)
    setDraft(p.content)
  }

  async function save() {
    if (!editing) return
    setSaving(true)
    try {
      await api.put(`/api/ai/prompts/${editing.key}`, { content: draft })
      await queryClient.invalidateQueries({ queryKey: ['ai-prompts'] })
      toast(t('settings.saved'), 'success')
      setEditing(null)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  async function reset() {
    if (!editing) return
    setSaving(true)
    try {
      const updated = await api.post<PromptTemplateDTO>(`/api/ai/prompts/${editing.key}/reset`)
      await queryClient.invalidateQueries({ queryKey: ['ai-prompts'] })
      setEditing(updated)
      setDraft(updated.content)
      toast(t('settings.aiPromptReset'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs leading-relaxed text-text-disabled">{t('settings.aiPromptsHint')}</p>
      <ul className="divide-y divide-border border border-border">
        {prompts.map((p) => (
          <li key={p.key}>
            <button
              type="button"
              onClick={() => open(p)}
              className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2/40"
            >
              <div className="mt-0.5 shrink-0">
                <Badge tone="neutral">
                  {CATEGORY_LABELS[p.category] ?? p.category}
                </Badge>
              </div>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-medium text-text-primary">{p.name}</span>
                  <span className="font-mono text-[10px] text-text-disabled">{p.key}</span>
                  {p.customized && <Badge tone="warning">v{p.version}</Badge>}
                </span>
                {/* 内容摘要：让用户不点开就知道模板写了什么 */}
                {p.content && (
                  <span className="mt-0.5 block line-clamp-2 text-xs leading-relaxed text-text-secondary">
                    {p.content}
                  </span>
                )}
              </span>
              <Icon name="edit" size={13} className="mt-0.5 shrink-0 text-text-disabled" />
            </button>
          </li>
        ))}
      </ul>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing ? `${editing.name} · ${editing.key}` : ''}
        width={720}
      >
        {editing && (
          <div className="flex flex-col gap-3">
            {/* 源码 / 渲染预览 双栏（与其他编辑器一致） */}
            <div className="grid min-h-0 grid-cols-1 md:grid-cols-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                rows={16}
                className="min-h-0 w-full resize-none border border-border bg-surface-2/60 p-3 font-mono text-xs leading-relaxed text-text-primary outline-none placeholder:text-text-disabled focus:border-primary"
              />
              <div className="min-h-0 max-h-[24rem] overflow-y-auto border border-l-0 border-border p-3">
                <div className="md-body">
                  <ReactMarkdown>{draft}</ReactMarkdown>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void reset()}
                loading={saving}
                icon={<Icon name="refresh" size={13} />}
              >
                {t('settings.aiPromptReset')}
              </Button>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setEditing(null)}>{t('common.cancel')}</Button>
                <Button
                  onClick={() => void save()}
                  loading={saving}
                  disabled={!draft.trim()}
                  icon={<Icon name="check" size={14} />}
                >
                  {t('common.save')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
