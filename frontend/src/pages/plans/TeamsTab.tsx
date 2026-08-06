import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'

import { crewsApi, rolesApi } from '../../api'
import { Badge, Button, Card, EmptyState, Icon, Input, useToast } from '../../components/ui'

/**
 * 团队（v4.1）：角色的集合。名称 + MD 描述（双栏预览）+ 从角色库选角色组成团队。
 * 成员卡片可展开预览角色的 MD 文档（与策略/角色库同一渲染器）。
 * 受控组件：selectedId/onSelect 由 PlansPage 左侧列表驱动。
 */
export function TeamsTab({
  selectedId,
  onSelect,
}: {
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { data: crews = [] } = useQuery({ queryKey: ['crews'], queryFn: crewsApi.list })
  const { data: roles = [] } = useQuery({ queryKey: ['roles'], queryFn: rolesApi.list })

  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [roleKeys, setRoleKeys] = useState<string[]>([])
  const [dirty, setDirty] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [expandedRole, setExpandedRole] = useState<string | null>(null)

  const selected = crews.find((c) => c.id === selectedId) ?? null

  useEffect(() => {
    if (!selected) {
      return
    }
    setName(selected.name)
    setDesc(selected.description ?? '')
    setRoleKeys(selected.role_keys ?? [])
    setExpandedRole(null)
    setDirty(false)
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (!selectedId) return
    try {
      const crew = await crewsApi.update(selectedId, { name, description: desc, role_keys: roleKeys })
      await queryClient.invalidateQueries({ queryKey: ['crews'] })
      onSelect(crew.id)
      toast(t('teams.saved'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** 一键添加角色库全部可用角色（新建团队快速组队）。 */
  function addAllRoles() {
    const available = roles.filter((r) => !roleKeys.includes(r.key)).map((r) => r.key)
    if (available.length === 0) return
    setRoleKeys((prev) => [...prev, ...available])
    setDirty(true)
  }

  function toggleRole(key: string) {
    setRoleKeys((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key)
      // 新增角色排到末尾
      return [...prev, key]
    })
    setDirty(true)
  }

  function moveRole(index: number, dir: -1 | 1) {
    setRoleKeys((prev) => {
      const next = [...prev]
      const target = index + dir
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
    setDirty(true)
  }

  const availableRoles = roles.filter((r) => !roleKeys.includes(r.key))

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-3">
      {!selected ? (
        <EmptyState icon="studio" title={t('teams.select')} />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <Input
              label={t('teams.name')}
              value={name}
              onChange={(e) => { setName(e.target.value); setDirty(true) }}
              className="w-64"
            />
            <Button onClick={save} disabled={!dirty}>
              <Icon name="check" size={14} />
              {t('teams.save')}
            </Button>
          </div>

            {/* MD 描述双栏 */}
            <Card padded={false} className="flex h-64 shrink-0 flex-col">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <h2 className="text-sm font-semibold">{t('teams.description')}</h2>
                <span className="text-xs text-text-disabled">{t('teams.mdHint')}</span>
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
                <textarea
                  value={desc}
                  onChange={(e) => { setDesc(e.target.value); setDirty(true) }}
                  spellCheck={false}
                  className="min-h-0 resize-none overflow-y-auto bg-transparent p-3 font-mono text-sm leading-relaxed text-text-primary outline-none placeholder:text-text-disabled"
                  placeholder="# 团队说明（Markdown）"
                />
                <div className="min-h-0 overflow-y-auto border-t border-border p-3 md:border-l md:border-t-0">
                  <div className="md-body">
                    <ReactMarkdown>{desc || t('teams.descPlaceholder')}</ReactMarkdown>
                  </div>
                </div>
              </div>
            </Card>

            {/* 成员（角色）管理 */}
            <Card padded={false} className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <h2 className="text-sm font-semibold">
                  {t('teams.members')}
                  <span className="ml-2 text-xs font-normal text-text-secondary">
                    {roleKeys.length} / {roles.length}
                  </span>
                </h2>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={addAllRoles}
                    className="flex items-center gap-1 text-xs text-text-secondary transition-colors hover:text-primary"
                  >
                    <Icon name="layers" size={12} />
                    {t('teams.addAll')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPickerOpen((v) => !v)}
                    className="flex items-center gap-1 text-xs text-text-secondary transition-colors hover:text-primary"
                  >
                    <Icon name="plus" size={12} />
                    {t('teams.addRole')}
                  </button>
                </div>
              </div>

              {pickerOpen && (
                <div className="border-b border-border px-3 py-2">
                  <p className="mb-1.5 text-[10px] text-text-disabled">{t('teams.pickerHint')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {availableRoles.length === 0 && (
                      <span className="text-xs text-text-disabled">{t('teams.noAvailableRoles')}</span>
                    )}
                    {availableRoles.map((role) => (
                      <button
                        key={role.id}
                        type="button"
                        onClick={() => toggleRole(role.key)}
                        className="border border-border px-2 py-1 text-xs text-text-secondary transition-colors hover:border-primary hover:text-primary"
                      >
                        {role.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 成员卡片列表：可滚动 + 间距 */}
              <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                {roleKeys.length === 0 && (
                  <li className="px-3 py-4 text-center text-xs text-text-disabled">{t('teams.noMembers')}</li>
                )}
                {roleKeys.map((key, index) => {
                  const role = roles.find((r) => r.key === key)
                  if (!role) return null
                  return (
                    <li key={key} className="flex items-start gap-3 border border-border bg-surface-1/60 p-3">
                      <div className="flex flex-col gap-1 pt-0.5">
                        <button
                          type="button"
                          onClick={() => moveRole(index, -1)}
                          disabled={index === 0}
                          className="text-text-disabled transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <Icon name="chevron-up" size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveRole(index, 1)}
                          disabled={index === roleKeys.length - 1}
                          className="text-text-disabled transition-colors hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          <Icon name="chevron-down" size={12} />
                        </button>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-text-primary">{role.name}</span>
                          <Badge tone="neutral">{role.role_name}</Badge>
                        </div>
                        {expandedRole === key ? (
                          <div className="md-body mt-2 border-t border-border pt-2">
                            <ReactMarkdown>
                              {role.description || t('roles.descPlaceholder')}
                            </ReactMarkdown>
                          </div>
                        ) : (
                          role.description && (
                            <p className="mt-1 line-clamp-1 text-xs leading-relaxed text-text-secondary">
                              {role.description.replace(/^#+\s*/gm, '').replace(/\n+/g, ' ').slice(0, 120)}
                            </p>
                          )
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setExpandedRole(expandedRole === key ? null : key)}
                          className="p-1 text-text-disabled transition-colors hover:text-text-primary"
                          title={expandedRole === key ? t('teams.collapse') : t('teams.preview')}
                        >
                          <Icon name={expandedRole === key ? 'chevron-up' : 'eye'} size={13} />
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleRole(key)}
                          className="p-1 text-text-disabled transition-colors hover:text-error"
                          title={t('teams.removeRole')}
                        >
                          <Icon name="close" size={13} />
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </Card>
          </>
        )}
    </div>
  )
}
