import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, thumbnailUrl } from '../../api'
import type { LibraryEntry } from '../../api/library'
import { Button, Icon, Modal, Spinner, useToast } from '../../components/ui'
interface OrganizeSuggestion {
  path: string
  tags: string[]
  suggested_name: string
}

interface DuplicateGroup {
  phash: string
  files: LibraryEntry[]
}

const MAX_BATCH = 20

/**
 * 素材 AI 整理（v0.2.3，参考 Eagle AI Action）：LLM 生成标签/建议名，
 * 逐条确认后应用（tags 写 sidecar / rename 原子迁移 sidecar）。
 */
export function OrganizeModal({
  open,
  onClose,
  paths,
  onDone,
}: {
  open: boolean
  onClose: () => void
  paths: string[]
  onDone: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [mode, setMode] = useState<'tags' | 'rename'>('tags')
  const [suggestions, setSuggestions] = useState<OrganizeSuggestion[] | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const batch = paths.slice(0, MAX_BATCH)

  useEffect(() => {
    if (open) {
      setSuggestions(null)
      setChecked(new Set())
      setBusy(false)
    }
  }, [open])

  async function suggest() {
    if (batch.length === 0) return
    setBusy(true)
    try {
      const res = await api.post<{ results: OrganizeSuggestion[] }>('/api/library/ai-organize', {
        paths: batch,
      })
      const valid = res.results.filter((r) => r.path && (r.tags.length > 0 || r.suggested_name))
      setSuggestions(valid)
      setChecked(new Set(valid.map((r) => r.path)))
      if (valid.length === 0) toast(t('assets.organizeEmpty'), 'warning')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function apply() {
    setBusy(true)
    let ok = 0
    let failed = 0
    try {
      for (const s of suggestions ?? []) {
        if (!checked.has(s.path)) continue
        try {
          if (mode === 'tags' && s.tags.length > 0) {
            await api.post('/api/library/tags', { path: s.path, tags: s.tags })
            ok += 1
          } else if (mode === 'rename' && s.suggested_name && s.suggested_name !== s.path.split('/').pop()) {
            await api.post('/api/library/rename', { path: s.path, new_name: s.suggested_name })
            ok += 1
          }
        } catch {
          failed += 1
        }
      }
      toast(t('assets.organizeApplied', { ok }), failed > 0 ? 'warning' : 'success')
      onDone()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('assets.organize')}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-1">
          {(['tags', 'rename'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`px-2.5 py-1 text-xs transition-colors ${
                mode === m
                  ? 'bg-surface-2 font-medium text-text-primary'
                  : 'text-text-secondary hover:bg-surface-2/60'
              }`}
            >
              {t(`assets.organizeMode.${m}`)}
            </button>
          ))}
          <span className="ml-auto text-[10px] text-text-disabled">{batch.length}</span>
        </div>

        {!suggestions ? (
          <button
            type="button"
            disabled={batch.length === 0 || busy}
            onClick={() => void suggest()}
            className="flex items-center justify-center gap-2 border border-primary/40 bg-primary/10 px-3 py-2.5 text-sm text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Spinner size={14} /> : <Icon name="wand" size={14} />}
            {t('assets.organizeRun')}
          </button>
        ) : (
          <>
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {suggestions.map((s) => {
                const name = s.path.split('/').pop() ?? s.path
                const on = checked.has(s.path)
                return (
                  <li key={s.path} className="flex items-start gap-2 border border-border/60 bg-surface-2/40 px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) => {
                        setChecked((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(s.path)
                          else next.delete(s.path)
                          return next
                        })
                      }}
                      className="mt-0.5 accent-primary"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs text-text-primary" title={s.path}>{name}</p>
                      {mode === 'tags' ? (
                        s.tags.length > 0 ? (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {s.tags.map((tag) => (
                              <span key={tag} className="border border-border px-1.5 py-0.5 text-[10px] text-text-secondary">
                                {tag}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <p className="mt-0.5 text-[10px] text-text-disabled">{t('assets.organizeNoSuggestion')}</p>
                        )
                      ) : (
                        <p className="mt-0.5 truncate text-[10px] text-text-secondary" title={s.suggested_name}>
                          {s.suggested_name && s.suggested_name !== name
                            ? `${name} → ${s.suggested_name}`
                            : t('assets.organizeNoSuggestion')}
                        </p>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => void suggest()}>
                {t('common.retry')}
              </Button>
              <Button size="sm" disabled={checked.size === 0 || busy} onClick={() => void apply()}>
                {busy ? <Spinner size={14} /> : <Icon name="check" size={12} />}
                {t('assets.organizeApply', { n: checked.size })}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}

/**
 * 素材查重（v0.2.3，参考 Eagle Find Duplicates）：phash 相似组，
 * 组内缩略图并排，保留其一、删除其余。
 */
export function DuplicatesModal({
  open,
  onClose,
  path,
  onDone,
}: {
  open: boolean
  onClose: () => void
  path: string | null
  onDone: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null)
  const [scanned, setScanned] = useState(0)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open && path) {
      setGroups(null)
      setBusy(true)
      void api
        .get<{ scanned: number; groups: DuplicateGroup[] }>(
          `/api/library/duplicates?path=${encodeURIComponent(path)}`,
        )
        .then((res) => {
          setGroups(res.groups)
          setScanned(res.scanned)
        })
        .catch((err: unknown) => {
          toast(err instanceof Error ? err.message : String(err), 'error')
          setGroups([])
        })
        .finally(() => setBusy(false))
    }
  }, [open, path, toast])

  async function removeFile(entry: LibraryEntry) {
    if (!window.confirm(t('assets.dupDeleteConfirm', { name: entry.name }))) return
    try {
      await api.delete(`/api/library/file?path=${encodeURIComponent(entry.path)}`)
      toast(t('assets.deleted'), 'success')
      setGroups((prev) =>
        (prev ?? [])
          .map((g) => ({ ...g, files: g.files.filter((f) => f.path !== entry.path) }))
          .filter((g) => g.files.length > 1),
      )
      onDone()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('assets.duplicates')}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-text-disabled">{t('assets.dupScanned', { n: scanned })}</p>
        {busy ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : (groups ?? []).length === 0 ? (
          <p className="py-4 text-center text-sm text-text-disabled">{t('assets.dupNone')}</p>
        ) : (
          <ul className="max-h-80 space-y-3 overflow-y-auto">
            {(groups ?? []).map((g) => (
              <li key={g.phash} className="border border-border/60 bg-surface-2/40 p-2">
                <p className="mb-1.5 font-mono text-[10px] text-text-disabled">{g.phash}</p>
                <div className="flex flex-wrap gap-2">
                  {g.files.map((f) => (
                    <div key={f.path} className="flex w-28 flex-col gap-1">
                      {f.thumb ? (
                        <img
                          src={thumbnailUrl(f.path)}
                          alt={f.name}
                          className="h-16 w-28 border border-border bg-surface-1 object-cover"
                        />
                      ) : (
                        <div className="flex h-16 w-28 items-center justify-center border border-border bg-surface-1 text-text-disabled">
                          <Icon name={f.kind === 'video' ? 'studio' : 'box'} size={16} />
                        </div>
                      )}
                      <p className="truncate text-[10px] text-text-secondary" title={f.name}>{f.name}</p>
                      <Button size="sm" variant="danger" onClick={() => void removeFile(f)}>
                        {t('assets.delete')}
                      </Button>
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
