import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { aiRegistryApi } from '../../api/ai'
import { Badge, Button, Icon, Select, useToast } from '../../components/ui'

interface ModelOption {
  value: string
  label: string
  providerName: string
  modelKey: string
  capability: string
}

/**
 * 默认模型（使用层，v2.1/Cherryt('settings.rolesDefaultModel')）：
 * 服务层（Provider/模型库）配好后，这里只关心「哪个任务用哪个模型」。
 * - 主模型：编排创作/对话用（你常用那个）
 * - 快速模型：评分/标题/脚本（便宜快速的即可，可跟随主模型）
 * - 嵌入模型：知识库预留
 */
export function RolesManager() {
  const { t } = useTranslation()
  const toast = useToast()
  const { data: providers = [] } = useQuery({
    queryKey: ['ai-providers'],
    queryFn: aiRegistryApi.listProviders,
  })

  /** TTS 试听（v0.4 B2）：短句合成 → 播放（复用 /api/ai/tts/test）。 */
  async function previewTts(voice: string) {
    if (!voice) return
    try {
      const audio = await aiRegistryApi.ttsTest(t('settings.ttsPreviewText'), voice)
      const url = URL.createObjectURL(new Blob([audio], { type: 'audio/mpeg' }))
      const player = new Audio(url)
      player.onended = () => URL.revokeObjectURL(url)
      void player.play()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }
  const { data: models = [] } = useQuery({
    queryKey: ['ai-models'],
    queryFn: () => aiRegistryApi.listModels(),
  })
  const { data: saved } = useQuery({
    queryKey: ['ai-roles'],
    queryFn: () => aiRegistryApi.getRoles().then((r) => r.roles),
  })
  const [roles, setRoles] = useState<Record<string, string>>({})
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (saved) setRoles(saved)
  }, [saved])

  const enabledChat: ModelOption[] = []
  const enabledEmbedding: ModelOption[] = []
  const enabledTts: ModelOption[] = []
  for (const p of providers) {
    if (!p.enabled) continue
    for (const m of models.filter((x) => x.provider_id === p.id && x.enabled)) {
      const opt: ModelOption = {
        value: `${p.key}:${m.key}`,
        label: `${p.name} · ${m.key}`,
        providerName: p.name,
        modelKey: m.key,
        capability: m.capability,
      }
      if (m.capability === 'chat') enabledChat.push(opt)
      if (m.capability === 'embedding') enabledEmbedding.push(opt)
      if (m.capability === 'tts') enabledTts.push(opt)
    }
  }

  function chatOptions(withAuto = true) {
    const opts: { value: string; label: string }[] = []
    if (withAuto) opts.push({ value: '', label: t('settings.roleAuto') })
    return [...opts, ...enabledChat.map((m) => ({ value: m.value, label: m.label }))]
  }

  /** 当前生效解析：角色配置 → 回退链 → 首个可用。 */
  function effective(roleKey: string): ModelOption | null {
    const configured = roles[roleKey]
    const pool = [...enabledChat, ...enabledEmbedding, ...enabledTts]
    if (configured) {
      const hit = pool.find((m) => m.value === configured)
      if (hit) return hit
    }
    // 回退链：fast/embedding → main → 首个 chat；tts → 首个音色；main → 首个 chat
    if (roleKey === 'tts') return enabledTts[0] ?? null
    if (roleKey !== 'main' && roles.main) {
      const hit = enabledChat.find((m) => m.value === roles.main)
      if (hit) return hit
    }
    return enabledChat[0] ?? null
  }

  function labelFor(roleKey: string) {
    const eff = effective(roleKey)
    if (!eff) return t('settings.roleNone')
    return roles[roleKey]
      ? eff.label
      : `${eff.label} · ${t('settings.roleViaFallback')}`
  }

  async function save() {
    setSaving(true)
    try {
      await aiRegistryApi.saveRoles(roles)
      setDirty(false)
      toast(t('settings.saved'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 主模型：醒目卡片 */}
      <section className="border border-primary/30 bg-surface-1/60 p-4">
        <div className="mb-1 flex items-center gap-2">
          <Icon name="studio" size={15} className="text-primary" />
          <h2 className="text-sm font-semibold text-text-primary">{t('settings.roleMain')}</h2>
          <Badge tone="primary">{t('settings.rolePrimary')}</Badge>
        </div>
        <p className="mb-3 text-xs leading-relaxed text-text-disabled">{t('settings.roleMainHint')}</p>
        <Select
          value={roles.main ?? ''}
          onChange={(e) => {
            setRoles((prev) => ({ ...prev, main: e.target.value }))
            setDirty(true)
          }}
          options={chatOptions()}
          className="w-full max-w-lg"
        />
        <div className="mt-2 flex items-center gap-2 text-xs text-text-secondary">
          {t('settings.roleEffective')}：
          <span className="min-w-0 truncate font-mono text-text-primary" title={labelFor('main')}>
            {labelFor('main')}
          </span>
        </div>
      </section>

      {/* 其他角色 */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center">
          <div className="w-52 shrink-0">
            <p className="text-xs font-medium text-text-primary">{t('settings.roleFast')}</p>
            <p className="text-[10px] text-text-disabled">{t('settings.roleFastHint')}</p>
          </div>
          <Select
            value={roles.fast ?? ''}
            onChange={(e) => {
              setRoles((prev) => ({ ...prev, fast: e.target.value }))
              setDirty(true)
            }}
            options={chatOptions()}
            className="flex-1"
          />
          <span className="hidden w-52 shrink-0 truncate text-right font-mono text-[10px] text-text-disabled sm:inline" title={labelFor('fast')}>
            {labelFor('fast')}
          </span>
        </div>

        <div className="flex flex-col gap-1 sm:flex-row sm:items-center">
          <div className="w-52 shrink-0">
            <p className="text-xs font-medium text-text-primary">{t('settings.roleEmbedding')}</p>
            <p className="text-[10px] text-text-disabled">{t('settings.roleEmbeddingHint')}</p>
          </div>
          <Select
            value={roles.embedding ?? ''}
            onChange={(e) => {
              setRoles((prev) => ({ ...prev, embedding: e.target.value }))
              setDirty(true)
            }}
            options={[
              { value: '', label: t('settings.roleAuto') },
              ...enabledEmbedding.map((m) => ({ value: m.value, label: m.label })),
            ]}
            className="flex-1"
          />
          <span className="hidden w-52 shrink-0 truncate text-right font-mono text-[10px] text-text-disabled sm:inline" title={labelFor('embedding')}>
            {labelFor('embedding')}
          </span>
        </div>

        <div className="flex flex-col gap-1 sm:flex-row sm:items-center">
          <div className="w-52 shrink-0">
            <p className="text-xs font-medium text-text-primary">{t('settings.roleTts')}</p>
            <p className="text-[10px] text-text-disabled">{t('settings.roleTtsHint')}</p>
          </div>
          <Select
            value={roles.tts ?? ''}
            onChange={(e) => {
              setRoles((prev) => ({ ...prev, tts: e.target.value }))
              setDirty(true)
            }}
            options={[
              { value: '', label: t('settings.roleAuto') },
              ...enabledTts.map((m) => ({ value: m.value, label: m.label })),
            ]}
            className="flex-1"
          />
          {/* TTS 试听（v0.4 B2）：选音色即点即听 */}
          <button
            type="button"
            onClick={() => void previewTts(roles.tts)}
            disabled={!roles.tts}
            title={t('settings.ttsPreview')}
            className="flex h-8 w-8 shrink-0 items-center justify-center border border-border text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon name="play" size={13} />
          </button>
          <span className="hidden w-52 shrink-0 truncate text-right font-mono text-[10px] text-text-disabled sm:inline" title={labelFor('tts')}>
            {labelFor('tts')}
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-3">
        <p className="text-[10px] leading-relaxed text-text-disabled">{t('settings.roleFallbackHint')}</p>
        <Button size="sm" onClick={() => void save()} disabled={!dirty} loading={saving}>
          <Icon name="check" size={14} />
          {t('common.save')}
        </Button>
      </div>
    </div>
  )
}
