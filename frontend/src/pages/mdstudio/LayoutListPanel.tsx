/** MD Studio 左栏：排版稿列表 + 导入（设计 §5 左栏）。
 *
 * 列表/新建/切换/删除（Modal 确认）；导入四路：docs 空间、Studio 产物 run、
 * 粘贴新建、本地 .md 上传——全部走「新建一份带内容的稿」，导入面板只负责取文本。
 */

import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { docsApi, type LayoutSummary } from '../../api'
import { Button, EmptyState, Icon, Input, Menu, Modal, Spinner, useToast } from '../../components/ui'

interface LayoutListPanelProps {
  layouts: LayoutSummary[] | undefined
  loading: boolean
  selectedId: string | null
  onSelect: (id: string) => void
  onCreate: (init?: { title?: string; source_md?: string; source_ref?: string | null }) => void
  onImportDocs: (path: string) => void
  onImportStudio: (run: string) => void
  onDelete: (id: string) => void
}

export function LayoutListPanel({
  layouts,
  loading,
  selectedId,
  onSelect,
  onCreate,
  onImportDocs,
  onImportStudio,
  onDelete,
}: LayoutListPanelProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const [deleteTarget, setDeleteTarget] = useState<LayoutSummary | null>(null)
  const [docsOpen, setDocsOpen] = useState(false)
  const [studioOpen, setStudioOpen] = useState(false)
  const [studioRun, setStudioRun] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  // docs 空间文件清单：仅在导入弹窗打开时拉取（低频动作，不常驻轮询）
  const docsQuery = useQuery({
    queryKey: ['docs-list'],
    queryFn: docsApi.list,
    enabled: docsOpen,
  })

  const pasteCreate = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) {
        toast(t('mdstudio.import.pasteEmpty'), 'warning')
        return
      }
      onCreate({ source_md: text })
    } catch {
      // 剪贴板权限被拒：退化为空白新稿，用户手动粘贴进编辑器
      toast(t('mdstudio.import.pasteDenied'), 'warning')
      onCreate()
    }
  }

  const uploadLocal = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      onCreate({ title: file.name.replace(/\.md$/i, ''), source_md: String(reader.result ?? '') })
    }
    reader.onerror = () => toast(t('mdstudio.import.uploadFailed'), 'error')
    reader.readAsText(file)
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="mdstudio-list-panel">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Button size="sm" icon={<Icon name="plus" size={12} />} onClick={() => onCreate()}>
          {t('mdstudio.new')}
        </Button>
        <Menu
          align="left"
          trigger={(open) => (
            <Button size="sm" variant="secondary" icon={<Icon name="upload" size={12} />}>
              {t('mdstudio.import.trigger')}
              <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} />
            </Button>
          )}
          items={[
            { label: t('mdstudio.import.fromDocs'), icon: 'briefs', onClick: () => setDocsOpen(true) },
            { label: t('mdstudio.import.fromStudio'), icon: 'studio', onClick: () => setStudioOpen(true) },
            { label: t('mdstudio.import.paste'), icon: 'copy', onClick: () => void pasteCreate() },
            { label: t('mdstudio.import.upload'), icon: 'file', onClick: () => fileRef.current?.click() },
          ]}
        />
        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,text/markdown,text/plain"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) uploadLocal(file)
            e.target.value = ''
          }}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading && (
          <div className="flex justify-center py-8">
            <Spinner size={16} />
          </div>
        )}
        {!loading && (layouts ?? []).length === 0 && (
          <EmptyState
            icon="briefs"
            title={t('mdstudio.list.empty')}
            description={t('mdstudio.list.emptyHint')}
          />
        )}
        <ul className="flex flex-col gap-1">
          {(layouts ?? []).map((item) => {
            const active = item.id === selectedId
            return (
              <li key={item.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(item.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') onSelect(item.id)
                  }}
                  className={`group flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 transition-colors duration-150 ${
                    active
                      ? 'border-primary/40 bg-primary/10'
                      : 'border-transparent hover:border-border hover:bg-surface-2'
                  }`}
                >
                  <Icon
                    name="briefs"
                    size={13}
                    className={`shrink-0 ${active ? 'text-primary' : 'text-text-disabled'}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-xs ${active ? 'font-medium text-text-primary' : 'text-text-primary'}`}>
                      {item.title || t('mdstudio.untitled')}
                    </span>
                    <span className="mt-0.5 block text-[10px] text-text-disabled">
                      {t(`mdstudio.platform.${item.platform}`)} · {item.theme_id}
                    </span>
                  </span>
                  <button
                    type="button"
                    title={t('common.delete')}
                    aria-label={t('common.delete')}
                    onClick={(e) => {
                      e.stopPropagation()
                      setDeleteTarget(item)
                    }}
                    className="shrink-0 rounded p-1 text-text-disabled opacity-0 transition-opacity duration-150 hover:bg-error/10 hover:text-error group-hover:opacity-100"
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      {/* 删除确认 */}
      <Modal open={deleteTarget !== null} title={t('mdstudio.delete.title')} onClose={() => setDeleteTarget(null)}>
        <p className="text-sm text-text-secondary">
          {t('mdstudio.delete.body', { title: deleteTarget?.title || t('mdstudio.untitled') })}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(null)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              if (deleteTarget) onDelete(deleteTarget.id)
              setDeleteTarget(null)
            }}
          >
            {t('common.delete')}
          </Button>
        </div>
      </Modal>

      {/* 从 docs 空间导入 */}
      <Modal open={docsOpen} title={t('mdstudio.import.fromDocs')} onClose={() => setDocsOpen(false)}>
        {docsQuery.isLoading && (
          <div className="flex justify-center py-6">
            <Spinner size={16} />
          </div>
        )}
        {docsQuery.isError && <p className="text-sm text-error">{t('mdstudio.import.docsFailed')}</p>}
        {docsQuery.data && docsQuery.data.length === 0 && (
          <p className="text-sm text-text-secondary">{t('mdstudio.import.docsEmpty')}</p>
        )}
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {(docsQuery.data ?? []).map((path) => (
            <li key={path}>
              <button
                type="button"
                onClick={() => {
                  setDocsOpen(false)
                  onImportDocs(path)
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-text-primary transition-colors hover:bg-surface-2"
              >
                <Icon name="file" size={12} className="shrink-0 text-text-disabled" />
                <span className="truncate">{path}</span>
              </button>
            </li>
          ))}
        </ul>
      </Modal>

      {/* 从 Studio 产物导入 */}
      <Modal open={studioOpen} title={t('mdstudio.import.fromStudio')} onClose={() => setStudioOpen(false)}>
        <p className="mb-3 text-xs text-text-secondary">{t('mdstudio.import.studioHint')}</p>
        <Input
          label={t('mdstudio.import.studioRun')}
          value={studioRun}
          onChange={(e) => setStudioRun(e.target.value)}
          placeholder={t('mdstudio.import.studioRunPlaceholder')}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => setStudioOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={!studioRun.trim()}
            onClick={() => {
              setStudioOpen(false)
              onImportStudio(studioRun.trim())
              setStudioRun('')
            }}
          >
            {t('mdstudio.import.confirm')}
          </Button>
        </div>
      </Modal>
    </div>
  )
}
