import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'

import { rolesApi } from '../../api'
import { Badge, Button, Card, EmptyState, Icon, Input, useToast } from '../../components/ui'

/**
 * 角色库编辑器（v4.1）：角色 = 纯 MD 内容实体。
 * 与策略一致：名称/扮演名 + Markdown 双栏（源码 / 渲染预览）。
 * 执行配置（方法/风格/模型/超时）由工序库与编排层负责，不在此处。
 * 受控组件：selectedId/onSelect 由 PlansPage 左侧列表驱动。
 */
export function RolesTab({
  selectedId,
  onSelect,
}: {
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { data: roles = [] } = useQuery({ queryKey: ['roles'], queryFn: rolesApi.list })

  const [name, setName] = useState('')
  const [roleName, setRoleName] = useState('')
  const [desc, setDesc] = useState('')
  const [dirty, setDirty] = useState(false)

  const selected = roles.find((r) => r.id === selectedId) ?? null

  useEffect(() => {
    if (!selected) return
    setName(selected.name)
    setRoleName(selected.role_name)
    setDesc(selected.description)
    setDirty(false)
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (!selectedId) return
    try {
      const role = await rolesApi.update(selectedId, { name, role_name: roleName, description: desc })
      await queryClient.invalidateQueries({ queryKey: ['roles'] })
      onSelect(role.id)
      toast(t('roles.saved'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-3">
      {!selected ? (
        <EmptyState icon="plans" title={t('roles.select')} />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <Input
              label={t('roles.name')}
              value={name}
              onChange={(e) => { setName(e.target.value); setDirty(true) }}
              className="w-56"
            />
            <Input
              label={t('roles.roleName')}
              value={roleName}
              onChange={(e) => { setRoleName(e.target.value); setDirty(true) }}
              placeholder={t('roles.roleNameHint')}
              className="w-56"
            />
            <Badge tone="neutral">{selected.key}</Badge>
            <Button onClick={save} disabled={!dirty}>
              <Icon name="check" size={14} />
              {t('roles.save')}
            </Button>
          </div>

          <Card padded={false} className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <h2 className="text-sm font-semibold">{t('roles.description')}</h2>
              <span className="flex items-center gap-3">
                <span className="flex items-center gap-1 text-xs text-text-secondary">
                  <Icon name="edit" size={12} aria-hidden />
                  {t('briefs.raw')}
                </span>
                <span className="flex items-center gap-1 text-xs text-text-secondary">
                  <Icon name="eye" size={12} aria-hidden />
                  {t('briefs.preview')}
                </span>
                <span className="text-xs text-text-disabled">
                  {t('roles.charCount', { count: desc.length })}
                </span>
              </span>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
              <textarea
                value={desc}
                onChange={(e) => { setDesc(e.target.value); setDirty(true) }}
                spellCheck={false}
                className="min-h-0 resize-none overflow-y-auto bg-transparent p-3 font-mono text-sm leading-relaxed text-text-primary outline-none placeholder:text-text-disabled"
                placeholder={t('roles.descPlaceholder')}
              />
              <div className="min-h-0 overflow-y-auto border-t border-border p-3 md:border-l md:border-t-0">
                <div className="md-body">
                  <ReactMarkdown>{desc || t('roles.descPlaceholder')}</ReactMarkdown>
                </div>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
