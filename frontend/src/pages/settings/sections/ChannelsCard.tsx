/** Settings 栏目管理卡（v0.22 栏目化内容工厂）：栏目 CRUD + 源池/音色/片头/包装配置。
 *  非破坏性：无栏目时系统行为与 v0.21 完全等价（后端空表自然短路）。 */

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '../../../api'
import { Badge, Button, Icon, Input, Select, useToast } from '../../../components/ui'
import { heading, sub } from './shared'

interface ChannelConfig {
  enabled?: boolean
  duration_s?: number
  subtitle?: string
}

export interface ChannelItem {
  public_id: string
  name: string
  enabled: boolean
  source_pool: string[]
  voice: string | null
  bili_tid: number | null
  desc_template: string | null
  tags: string[]
  title_style_prompt: string | null
  persona_prompt: string | null
  intro_config: ChannelConfig | null
}

interface Draft {
  public_id: string
  name: string
  enabled: boolean
  source_pool: string
  voice: string
  bili_tid: string
  desc_template: string
  tags: string
  title_style_prompt: string
  persona_prompt: string
  intro_enabled: boolean
  intro_duration_s: string
  intro_subtitle: string
}

function toDraft(c: ChannelItem): Draft {
  return {
    public_id: c.public_id,
    name: c.name,
    enabled: c.enabled,
    source_pool: (c.source_pool ?? []).join('\n'),
    voice: c.voice ?? '',
    bili_tid: c.bili_tid == null ? '' : String(c.bili_tid),
    desc_template: c.desc_template ?? '',
    tags: (c.tags ?? []).join(', '),
    title_style_prompt: c.title_style_prompt ?? '',
    persona_prompt: c.persona_prompt ?? '',
    intro_enabled: Boolean(c.intro_config?.enabled),
    intro_duration_s: String(c.intro_config?.duration_s ?? 3),
    intro_subtitle: c.intro_config?.subtitle ?? '',
  }
}

function emptyDraft(): Draft {
  return {
    public_id: '',
    name: '',
    enabled: true,
    source_pool: '',
    voice: '',
    bili_tid: '',
    desc_template: '',
    tags: '',
    title_style_prompt: '',
    persona_prompt: '',
    intro_enabled: false,
    intro_duration_s: '3',
    intro_subtitle: '',
  }
}

const textareaCls =
  'w-full rounded border border-border bg-surface-1 px-2 py-1.5 text-xs text-text-primary outline-none placeholder:text-text-disabled focus:border-primary'

const fieldLabel = 'mb-0.5 block text-[11px] font-medium text-text-secondary'

export function ChannelsCard() {
  const { t } = useTranslation()
  const toast = useToast()
  const [editingKey, setEditingKey] = useState<string | null>(null) // null=列表态，''=新建
  const [draft, setDraft] = useState<Draft>(emptyDraft())
  const [busy, setBusy] = useState(false)

  const { data: channels = [], refetch } = useQuery({
    queryKey: ['channels'],
    queryFn: () => api.get<ChannelItem[]>('/api/channels'),
  })
  const { data: voices = [] } = useQuery({
    queryKey: ['channel-voices'],
    queryFn: () =>
      api.get<Array<{ id: string; gender: string; accent: string; style: string }>>(
        '/api/channels/voices',
      ),
  })

  function d<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  function openCreate() {
    setDraft(emptyDraft())
    setEditingKey('')
  }
  function openEdit(c: ChannelItem) {
    setDraft(toDraft(c))
    setEditingKey(c.public_id)
  }

  async function save() {
    if (!draft.name.trim()) {
      toast(t('settings.channelNameRequired'), 'warning')
      return
    }
    setBusy(true)
    try {
      const body = {
        public_id: draft.public_id.trim() || undefined,
        name: draft.name.trim(),
        enabled: draft.enabled,
        source_pool: draft.source_pool
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        voice: draft.voice || null,
        bili_tid: draft.bili_tid ? Number(draft.bili_tid) : null,
        desc_template: draft.desc_template || null,
        tags: draft.tags.split(',').map((s) => s.trim()).filter(Boolean),
        title_style_prompt: draft.title_style_prompt || null,
        persona_prompt: draft.persona_prompt || null,
        intro_config: draft.intro_enabled
          ? {
              enabled: true,
              duration_s: Number(draft.intro_duration_s) || 3,
              subtitle: draft.intro_subtitle,
            }
          : { enabled: false },
      }
      if (editingKey === '') {
        await api.post('/api/channels', body)
      } else {
        await api.put(`/api/channels/${editingKey}`, body)
      }
      toast(t('settings.channelSaved'), 'success')
      setEditingKey(null)
      await refetch()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function remove(c: ChannelItem) {
    if (!window.confirm(t('settings.channelDeleteConfirm', { name: c.name }))) return
    try {
      await api.delete(`/api/channels/${c.public_id}`)
      toast(t('settings.channelDeleted'), 'success')
      setEditingKey(null)
      await refetch()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <section className="border border-border bg-surface-1/60 p-4">
      <h2 className={heading}>
        <Icon name="layers" size={15} />
        {t('settings.channels.title')}
      </h2>
      <p className={sub}>{t('settings.channels.hint')}</p>

      <div className="flex justify-end">
        <Button size="sm" onClick={openCreate} disabled={editingKey !== null}>
          <Icon name="plus" size={12} />
          {t('settings.channels.new')}
        </Button>
      </div>

      {channels.length === 0 && editingKey === null && (
        <p className="mt-1 text-xs text-text-disabled">{t('settings.channels.empty')}</p>
      )}

      {/* 列表 */}
      {editingKey === null && channels.length > 0 && (
        <ul className="mt-2 divide-y divide-border/60">
          {channels.map((c) => (
            <li key={c.public_id} className="flex items-center gap-2 py-2 text-xs">
              <Badge tone={c.enabled ? 'success' : 'neutral'}>
                {c.enabled ? t('settings.channels.on') : t('settings.channels.off')}
              </Badge>
              <span className="font-medium text-text-primary">{c.name}</span>
              <code className="text-text-disabled">{c.public_id}</code>
              {(c.source_pool?.length ?? 0) > 0 && (
                <span className="text-text-secondary">
                  {t('settings.channels.sourcesCount', { n: c.source_pool.length })}
                </span>
              )}
              {c.voice && <Badge tone="primary">{c.voice}</Badge>}
              {c.intro_config?.enabled && (
                <Badge tone="warning">{t('settings.channels.introOn')}</Badge>
              )}
              <span className="ml-auto flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => openEdit(c)}>
                  {t('settings.channels.edit')}
                </Button>
                <Button size="sm" variant="danger" onClick={() => void remove(c)}>
                  {t('settings.channels.delete')}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* 编辑器 */}
      {editingKey !== null && (
        <div className="mt-3 flex flex-col gap-3 rounded border border-border p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={fieldLabel}>{t('settings.channels.name')}</label>
              <Input value={draft.name} onChange={(e) => d('name', e.target.value)} />
            </div>
            <div>
              <label className={fieldLabel}>
                {t('settings.channels.key')}
                {editingKey !== '' && ' 🔒'}
              </label>
              <Input
                value={draft.public_id}
                disabled={editingKey !== ''}
                onChange={(e) => d('public_id', e.target.value.toLowerCase())}
                placeholder="my-channel"
              />
            </div>
            <Select
              label={t('settings.channels.voice')}
              value={draft.voice}
              onChange={(e) => d('voice', e.target.value)}
              options={[
                { value: '', label: t('settings.channels.voiceAuto') },
                ...voices.map((v) => ({
                  value: v.id,
                  label: `${v.id}（${v.gender === 'male' ? '男' : '女'}/${v.accent}）`,
                })),
              ]}
            />
            <Input
              label={t('settings.channels.biliTid')}
              type="number"
              value={draft.bili_tid}
              onChange={(e) => d('bili_tid', e.target.value)}
              placeholder="17"
            />
          </div>

          <div>
            <label className={fieldLabel}>{t('settings.channels.sourcePool')}</label>
            <textarea
              className={textareaCls}
              rows={3}
              value={draft.source_pool}
              onChange={(e) => d('source_pool', e.target.value)}
              placeholder={'ai-story/情感夜话\nreddit/shortblessed\nrss/tech'}
            />
            <p className="mt-0.5 text-[10px] text-text-disabled">
              {t('settings.channels.sourcePoolHint')}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={fieldLabel}>{t('settings.channels.tags')}</label>
              <Input
                value={draft.tags}
                onChange={(e) => d('tags', e.target.value)}
                placeholder="情感, 故事, 治愈"
              />
            </div>
            <Input
              label={t('settings.channels.descTemplate')}
              value={draft.desc_template}
              onChange={(e) => d('desc_template', e.target.value)}
              placeholder={'{title}｜{channel}'}
            />
          </div>
          <p className="-mt-2 text-[10px] text-text-disabled">
            {t('settings.channels.descTemplateHint')}
          </p>

          <div>
            <label className={fieldLabel}>{t('settings.channels.titleStyle')}</label>
            <textarea
              className={textareaCls}
              rows={2}
              value={draft.title_style_prompt}
              onChange={(e) => d('title_style_prompt', e.target.value)}
            />
          </div>

          <div>
            <label className={fieldLabel}>{t('settings.channels.persona')}</label>
            <textarea
              className={textareaCls}
              rows={3}
              value={draft.persona_prompt}
              onChange={(e) => d('persona_prompt', e.target.value)}
            />
          </div>

          {/* 片头 */}
          <div className="rounded border border-border/60 p-2.5">
            <label className="flex items-center gap-2 text-xs text-text-primary">
              <input
                type="checkbox"
                checked={draft.intro_enabled}
                onChange={(e) => d('intro_enabled', e.target.checked)}
              />
              {t('settings.channels.introTitle')}
            </label>
            {draft.intro_enabled && (
              <div className="mt-2 grid gap-3 sm:grid-cols-[120px_1fr]">
                <Input
                  label={t('settings.channels.introDuration')}
                  type="number"
                  min={1}
                  max={10}
                  value={draft.intro_duration_s}
                  onChange={(e) => d('intro_duration_s', e.target.value)}
                />
                <Input
                  label={t('settings.channels.introSubtitle')}
                  value={draft.intro_subtitle}
                  onChange={(e) => d('intro_subtitle', e.target.value)}
                  placeholder={'每晚一个真实的故事'}
                />
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-text-primary">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => d('enabled', e.target.checked)}
              />
              {t('settings.channels.enabled')}
            </label>
            <span className="ml-auto flex items-center gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setEditingKey(null)}>
                {t('settings.channels.cancel')}
              </Button>
              <Button size="sm" onClick={() => void save()} disabled={busy}>
                <Icon name="check" size={12} />
                {t('settings.channels.save')}
              </Button>
            </span>
          </div>
        </div>
      )}
    </section>
  )
}
