import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useBoardStore, unconnectedSimilarPairs, useBoardClusters } from '../../stores/board'
import { Icon } from '../../components/ui'
import type { WhisperKind } from '../../core/whisper'

const WHISPER_ICON: Record<WhisperKind, 'alert' | 'link' | 'whisper'> = {
  wake: 'alert',
  ghost: 'link',
  prompt: 'whisper',
}

export function WhisperText({ whisper }: { whisper: ReturnType<typeof useBoardStore.getState>['whispers'][number] }) {
  const { t } = useTranslation()
  if (whisper.type === 'wake') return <>{t('whisper.wakeText')}</>
  if (whisper.type === 'ghost') {
    return <>{t('whisper.ghostText', { peer: (whisper.peer ?? '').slice(0, 12) })}</>
  }
  return <>{t(`whisper.prompts.${whisper.promptIndex ?? 0}`)}</>
}

export function WhispersBar({ open }: { open: boolean }) {
  const { t } = useTranslation()
  const board = useBoardStore((s) => s.board)
  const whispers = useBoardStore((s) => s.whispers)
  const lastTouchAt = useBoardStore((s) => s.lastTouchAt)
  const addWhisper = useBoardStore((s) => s.addWhisper)
  const dismissWhisper = useBoardStore((s) => s.dismissWhisper)
  const clusters = useBoardClusters()
  const [muted, setMuted] = useState(false)

  const pairs = useMemo(() => unconnectedSimilarPairs(board.cards, clusters), [board.cards, clusters])

  useEffect(() => {
    if (muted) return
    const timer = setInterval(() => {
      addWhisper({ now: Date.now(), lastTouchAt, cardCount: board.cards.length, unconnectedSimilar: pairs })
    }, 5000)
    return () => clearInterval(timer)
  }, [muted, lastTouchAt, board.cards.length, pairs, addWhisper])

  if (!open) return null

  return (
    <aside className="flex w-64 shrink-0 flex-col border-l border-border bg-surface-1/80 backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <Icon name="whisper" size={15} />
          {t('whisper.title')}
        </h2>
        <button
          type="button"
          onClick={() => setMuted((m) => !m)}
          title={muted ? t('whisper.unmute') : t('whisper.mute')}
          className={` p-1 transition-colors ${muted ? 'text-error' : 'text-text-secondary hover:text-text-primary'}`}
        >
          <Icon name={muted ? 'moon' : 'sun'} size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
        {whispers.length === 0 && (
          <p className="text-xs leading-relaxed text-text-disabled">{t('whisper.empty')}</p>
        )}
        {whispers.map((w) => (
          <div
            key={w.id}
            className=" border border-border bg-surface-2/60 p-2.5 text-xs leading-relaxed text-text-secondary"
          >
            <div className="mb-1 flex items-center gap-1.5 text-text-secondary">
              <Icon name={WHISPER_ICON[w.type]} size={12} className={w.type === 'ghost' ? 'text-warning' : ''} />
              <span className="font-semibold">{t(`whisper.types.${w.type}`)}</span>
            </div>
            <p>
              <WhisperText whisper={w} />
            </p>
            <div className="mt-1.5 flex justify-end">
              <button
                type="button"
                onClick={() => dismissWhisper(w.id)}
                className=" px-1.5 py-0.5 text-text-disabled transition-colors hover:text-text-primary"
              >
                {t('whisper.dismiss')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  )
}
