import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import {
  aiRegistryApi,
  type AIProviderDTO,
  type AIModelDTO,
  type ProviderTemplate,
} from '../../api/ai'
import { Badge, Button, Icon, Input, Modal, Select, Spinner, useToast } from '../../components/ui'

/** Provider 新建/编辑弹窗。 */
function ProviderModal({
  open,
  onClose,
  templates,
  editing,
}: {
  open: boolean
  onClose: () => void
  templates: ProviderTemplate[]
  editing: AIProviderDTO | null
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [template, setTemplate] = useState('custom')
  const [baseUrl, setBaseUrl] = useState('')
  const [keys, setKeys] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(editing?.name ?? '')
    setTemplate(editing?.template ?? 'custom')
    setBaseUrl(editing?.base_url ?? '')
    setKeys('')
  }, [open, editing])

  const selected = templates.find((tp) => tp.key === template)
  // comfyui/edge_tts 是系统连接器（自动种子，无 key）——不参与新建/不显示 key 输入
  const isSystemConnector = (editing?.protocol ?? selected?.protocol ?? '') !== 'openai_compat'

  async function save() {
    setSaving(true)
    try {
      const apiKeys = keys
        .split(/[,，\n]/)
        .map((k) => k.trim())
        .filter(Boolean)
      if (editing) {
        await aiRegistryApi.updateProvider(editing.id, {
          name,
          base_url: baseUrl.trim(),
          ...(apiKeys.length > 0 && !isSystemConnector ? { api_keys: apiKeys } : {}),
        })
      } else {
        await aiRegistryApi.createProvider({
          name,
          template,
          base_url: baseUrl.trim(),
          api_keys: apiKeys,
        })
      }
      await queryClient.invalidateQueries({ queryKey: ['ai-providers'] })
      await queryClient.invalidateQueries({ queryKey: ['ai-models'] })
      toast(t('settings.saved'), 'success')
      onClose()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={editing ? t('settings.aiProviderEdit') : t('settings.aiProviderNew')}>
      <div className="flex flex-col gap-3">
        <Select
          label={t('settings.aiTemplate')}
          value={template}
          onChange={(e) => {
            setTemplate(e.target.value)
            const tp = templates.find((x) => x.key === e.target.value)
            if (tp && !editing) setBaseUrl(tp.base_url)
          }}
          disabled={!!editing}
          options={[
            { value: 'custom', label: t('settings.aiTemplateCustom') },
            ...templates
              .filter((tp) => tp.key !== 'comfyui' && tp.key !== 'edge_tts')
              .map((tp) => ({ value: tp.key, label: tp.name })),
          ]}
        />
        <Input label={t('settings.aiProviderName')} value={name} onChange={(e) => setName(e.target.value)} />
        <Input label={t('settings.baseUrl')} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={selected?.base_url} />
        {!isSystemConnector && (
          <Input
            label={editing ? t('settings.aiKeysReplace') : t('settings.aiKeys')}
            type="password"
            value={keys}
            onChange={(e) => setKeys(e.target.value)}
            placeholder={editing && !editing.keys_set ? t('settings.aiKeysEmpty') : t('settings.aiKeysHint')}
          />
        )}
        {editing && !isSystemConnector && (
          <p className="text-xs text-text-disabled">
            {editing.keys_set
              ? t('settings.aiKeysCurrent', { count: editing.keys_count })
              : t('settings.aiKeysNone')}
          </p>
        )}
        {!editing && selected && (
          <p className="text-xs leading-relaxed text-text-disabled">
            {selected.desc}
            {selected.protocol === 'openai_compat'
              ? ` · ${t('settings.aiModelsFetchHint')}`
              : ` · ${t('settings.aiModelsSeed', { count: selected.models.length })}`}
          </p>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button onClick={() => void save()} loading={saving} disabled={!name.trim()}>
            <Icon name="check" size={14} />
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** 模型管理（Provider 下辖模型库）。 */
function ModelsPanel({ provider, models }: { provider: AIProviderDTO; models: AIModelDTO[] }) {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [capability, setCapability] = useState('chat')
  const [fetching, setFetching] = useState(false)
  const [testModel, setTestModel] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  async function fetchRemote() {
    setFetching(true)
    setTestResult(null)
    try {
      await aiRegistryApi.fetchModels(provider.id)
      await queryClient.invalidateQueries({ queryKey: ['ai-models'] })
      await queryClient.invalidateQueries({ queryKey: ['ai-providers'] })
      toast(t('settings.aiModelsFetched'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setFetching(false)
    }
  }

  async function test(m: AIModelDTO) {
    setTestModel(m.key)
    setTestResult(null)
    try {
      const r = await aiRegistryApi.testProvider(provider.id, m.key)
      setTestResult({ ok: r.ok, text: r.ok ? `${m.key} → "${r.reply}"` : `${m.key}: ${r.detail ?? ''}` })
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setTestModel('')
    }
  }

  async function add() {
    try {
      await aiRegistryApi.addModel({ provider_id: provider.id, key: newKey.trim(), capability })
      await queryClient.invalidateQueries({ queryKey: ['ai-models'] })
      setNewKey('')
      setShowAdd(false)
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  async function toggle(m: AIModelDTO) {
    await aiRegistryApi.updateModel(m.id, { enabled: !m.enabled })
    await queryClient.invalidateQueries({ queryKey: ['ai-models'] })
  }

  async function remove(m: AIModelDTO) {
    await aiRegistryApi.removeModel(m.id)
    await queryClient.invalidateQueries({ queryKey: ['ai-models'] })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 text-xs font-medium text-text-secondary">
          {t('settings.aiModels', { count: models.length })}
          <span className="ml-2 truncate font-normal text-text-disabled">
            {provider.last_fetch_at
              ? t('settings.aiFetchAt', { time: new Date(provider.last_fetch_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
              : t('settings.aiFetchNever')}
          </span>
        </p>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="ghost" onClick={() => void fetchRemote()} loading={fetching}>
            <Icon name="refresh" size={12} />
            {t('settings.aiFetchModels')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowAdd((v) => !v)}>
            <Icon name="plus" size={12} />
            {t('settings.aiAddModel')}
          </Button>
        </div>
      </div>
      {showAdd && (
        <div className="flex items-end gap-2">
          <Input label={t('settings.aiModelKey')} value={newKey} onChange={(e) => setNewKey(e.target.value)} className="flex-1" />
          <Select
            label={t('settings.aiCapability')}
            value={capability}
            onChange={(e) => setCapability(e.target.value)}
            options={[
              { value: 'chat', label: 'chat' },
              { value: 'embedding', label: 'embedding' },
              { value: 'image', label: 'image' },
              { value: 'tts', label: 'tts' },
            ]}
          />
          <Button onClick={() => void add()} disabled={!newKey.trim()}>{t('common.save')}</Button>
        </div>
      )}
      <ul className="grid gap-2 xl:grid-cols-2">
        {models.length === 0 && (
          <li className="col-span-full px-3 py-3 text-center text-xs text-text-disabled">{t('settings.aiNoModels')}</li>
        )}
        {models.map((m) => (
          <li key={m.id} className="flex items-center gap-2 border border-border px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-primary" title={m.key}>{m.key}</span>
            <Badge tone={m.capability === 'chat' ? 'primary' : 'neutral'}>{m.capability}</Badge>
            <button type="button" onClick={() => void toggle(m)} className="text-text-disabled transition-colors hover:text-text-primary" title={m.enabled ? t('settings.aiDisable') : t('settings.aiEnable')}>
              <Icon name={m.enabled ? 'eye' : 'eye-off'} size={14} />
            </button>
            <button type="button" onClick={() => void test(m)} disabled={!!testModel} className="text-text-secondary transition-colors hover:text-primary">
              <Icon name="send" size={14} />
            </button>
            <button type="button" onClick={() => void remove(m)} className="text-text-disabled transition-colors hover:text-error">
              <Icon name="trash" size={14} />
            </button>
          </li>
        ))}
      </ul>
      {testResult && (
        <p className={`text-xs ${testResult.ok ? 'text-success' : 'text-error'}`}>
          {testResult.ok ? `✓ ${testResult.text}` : `✗ ${testResult.text}`}
        </p>
      )}
    </div>
  )
}

/** Provider 列表 + 模型管理 + 新建/编辑（AI 底座 v2.0）。 */
export function ProviderManager() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: templates = [] } = useQuery({
    queryKey: ['ai-templates'],
    queryFn: () => aiRegistryApi.templates().then((r) => r.templates),
  })
  const { data: providers = [] } = useQuery({
    queryKey: ['ai-providers'],
    queryFn: aiRegistryApi.listProviders,
  })
  const { data: models = [] } = useQuery({
    queryKey: ['ai-models'],
    queryFn: () => aiRegistryApi.listModels(),
  })
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<AIProviderDTO | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  function openNew() {
    setEditing(null)
    setModalOpen(true)
  }

  function openEdit(p: AIProviderDTO) {
    setEditing(p)
    setModalOpen(true)
  }

  async function toggleProvider(p: AIProviderDTO) {
    await aiRegistryApi.updateProvider(p.id, { enabled: !p.enabled })
    await queryClient.invalidateQueries({ queryKey: ['ai-providers'] })
  }

  async function removeProvider(p: AIProviderDTO) {
    await aiRegistryApi.removeProvider(p.id)
    await queryClient.invalidateQueries({ queryKey: ['ai-providers'] })
    await queryClient.invalidateQueries({ queryKey: ['ai-models'] })
  }

  if (providers.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <Spinner />
        <p className="text-xs text-text-disabled">{t('settings.aiProvidersLoading')}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs leading-relaxed text-text-disabled">{t('settings.aiProvidersHint')}</p>
        <Button size="sm" onClick={openNew}>
          <Icon name="plus" size={14} />
          {t('settings.aiProviderNew')}
        </Button>
      </div>
      <ul className="flex flex-col gap-2">
        {providers.map((p) => {
          const pModels = models.filter((m) => m.provider_id === p.id)
          const isOpen = expanded === p.id
          const caps = [...new Set(pModels.map((m) => m.capability))]
          const capBadge = caps.includes('image')
            ? t('settings.aiCapImage')
            : caps.includes('tts')
              ? t('settings.aiCapTts')
              : caps.includes('embedding')
                ? 'embedding'
                : t('settings.aiCapChat')
          return (
            <li key={p.id} className="border border-border bg-surface-1/60">
              <div className="flex items-center gap-2 px-3 py-2.5">
                <button type="button" onClick={() => setExpanded(isOpen ? null : p.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} className="shrink-0 text-text-disabled" />
                  <span className="truncate text-sm font-medium text-text-primary">{p.name}</span>
                  <Badge tone={capBadge === t('settings.aiCapImage') || capBadge === t('settings.aiCapTts') ? 'neutral' : 'primary'}>{capBadge}</Badge>
                  <Badge tone={p.enabled ? 'success' : 'neutral'}>{p.enabled ? t('settings.aiOn') : t('settings.aiOff')}</Badge>
                  <span className="hidden truncate font-mono text-[10px] text-text-disabled sm:inline">{p.base_url}</span>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <button type="button" onClick={() => void toggleProvider(p)} className="p-1 text-text-disabled transition-colors hover:text-text-primary" title={p.enabled ? t('settings.aiDisable') : t('settings.aiEnable')}>
                    <Icon name={p.enabled ? 'eye' : 'eye-off'} size={13} />
                  </button>
                  <button type="button" onClick={() => openEdit(p)} className="p-1 text-text-disabled transition-colors hover:text-text-primary">
                    <Icon name="edit" size={13} />
                  </button>
                  <button type="button" onClick={() => void removeProvider(p)} className="p-1 text-text-disabled transition-colors hover:text-error">
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              </div>
              {isOpen && (
                <div className="border-t border-border px-3 py-3">
                  <ModelsPanel provider={p} models={pModels} />
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <ProviderModal open={modalOpen} onClose={() => setModalOpen(false)} templates={templates} editing={editing} />
    </div>
  )
}
