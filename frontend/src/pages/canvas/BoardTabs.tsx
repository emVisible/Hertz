import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Icon } from '../../components/ui'
import { useBoardStore } from '../../stores/board'

/** 多板板签栏（Revel heritage）：新建 / 切换 / 双击重命名 / 删除（保留最后一块）。 */
export function BoardTabs() {
  const { t } = useTranslation()
  const boards = useBoardStore((s) => s.boards)
  const activeBoardId = useBoardStore((s) => s.activeBoardId)
  const switchBoard = useBoardStore((s) => s.switchBoard)
  const addBoard = useBoardStore((s) => s.addBoard)
  const renameBoard = useBoardStore((s) => s.renameBoard)
  const removeBoard = useBoardStore((s) => s.removeBoard)
  const [renaming, setRenaming] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) inputRef.current?.focus()
  }, [renaming])

  function commitRename(id: string) {
    const el = inputRef.current
    if (el) renameBoard(id, el.value)
    setRenaming(null)
  }

  return (
    <div className="scrollbar-none flex min-w-0 items-center gap-1 overflow-x-auto border-b border-border bg-surface-1/60 px-2 py-1">
      {boards.map((b) => {
        const active = b.id === activeBoardId
        return (
          <div
            key={b.id}
            onDoubleClick={() => setRenaming(b.id)}
            className={`group flex shrink-0 items-center gap-1.5 px-2 py-1 text-xs transition-colors ${
              active
                ? 'bg-surface-2 text-text-primary'
                : 'text-text-secondary hover:bg-surface-2/60 hover:text-text-primary'
            }`}
          >
            {renaming === b.id ? (
              <input
                ref={inputRef}
                defaultValue={b.name}
                onBlur={() => commitRename(b.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename(b.id)
                  if (e.key === 'Escape') setRenaming(null)
                }}
                className="w-28 bg-transparent text-xs text-text-primary outline-none focus:border-primary"
              />
            ) : (
              <button
                type="button"
                onClick={() => switchBoard(b.id)}
                className="max-w-40 truncate"
                title={`${b.name} — ${t('canvas.cardCount', { n: b.cards.length })}`}
              >
                {b.name}
              </button>
            )}
            {boards.length > 1 && (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(t('canvas.boardRemove', { name: b.name }))) removeBoard(b.id)
                }}
                title={t('canvas.boardRemoveTitle')}
                className=" p-0.5 text-text-disabled transition-colors hover:text-error"
              >
                <Icon name="close" size={11} />
              </button>
            )}
          </div>
        )
      })}
      <button
        type="button"
        onClick={addBoard}
        title={t('canvas.boardNew')}
        className="shrink-0 p-1 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  )
}
