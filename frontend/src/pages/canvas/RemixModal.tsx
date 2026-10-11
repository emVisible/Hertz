import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { canvasApi, type RemixResult } from '../../api'
import { Button, Icon, Modal, Spinner, useToast } from '../../components/ui'
import { useBoardStore } from '../../stores/board'

const WORD_CATEGORIES = [
  { key: 'conj', label: 'canvas.wordConnect' },
  { key: 'prep', label: 'canvas.wordPreposition' },
  { key: 'aux', label: 'canvas.wordParticle' },
  { key: 'adj', label: 'canvas.wordAdjective' },
  { key: 'obj', label: 'canvas.wordObject' },
] as const

/**
 * 灵感重组（NLP 词性分析）：分析画布卡片词性，随机组合出灵感候选，
 * 每条可一键添加到画布；内置结构性词库可维护。
 */
export function RemixModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const cards = useBoardStore((s) => s.board.cards)
  const addCard = useBoardStore((s) => s.addCard)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<RemixResult | null>(null)
  const [bankOpen, setBankOpen] = useState(false)
  const [bank, setBank] = useState<Record<string, string[]>>({})
  const [bankDrafts, setBankDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (bankOpen) {
      void canvasApi.wordbank().then(setBank).catch(() => undefined)
    }
  }, [bankOpen])

  // AXIOM §2.5：modal 复用时（不同画布/开关多次）残留状态必须重置，
  // 不能依赖组件卸载——上次的 remix 结果/词库面板会错误地出现在下次打开时
  useEffect(() => {
    if (open) {
      setResult(null)
      setBankOpen(false)
      setBank({})
      setBankDrafts({})
      setLoading(false)
    }
  }, [open])

  async function analyze() {
    const texts = cards.map((c) => c.content.trim()).filter(Boolean)
    if (texts.length === 0) {
      toast(t('canvas.remix.empty'), 'warning')
      return
    }
    setLoading(true)
    setResult(null)
    try {
      setResult(await canvasApi.remix(texts))
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setLoading(false)
    }
  }

  function addToBoard(text: string) {
    addCard(text)
    toast(t('canvas.remix.added'), 'success')
  }

  async function saveWordbank() {
    setSaving(true)
    try {
      const categories: Record<string, string[]> = {}
      for (const { key } of WORD_CATEGORIES) {
        const words = (bankDrafts[key] ?? '')
          .split(/[,，\s]+/)
          .map((w) => w.trim())
          .filter(Boolean)
        if (words.length > 0 || (bank[key] ?? []).length === 0) {
          categories[key] = words
        } else {
          categories[key] = []
        }
      }
      await canvasApi.saveWordbank(categories)
      setBank(categories)
      toast(t('canvas.remix.bankSaved'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setSaving(false)
    }
  }

  function openBank() {
    setBankOpen(true)
    const drafts: Record<string, string> = {}
    for (const { key } of WORD_CATEGORIES) {
      drafts[key] = (bank[key] ?? []).join('，')
    }
    setBankDrafts(drafts)
  }

  return (
    <Modal open={open} onClose={onClose} width={640} title={t('canvas.remix.title')}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <p className="text-xs text-text-secondary">
            {cards.length} {t('canvas.remix.cardCount')}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={openBank}>
              <Icon name="tag" size={13} />
              {t('canvas.remix.wordbank')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void analyze()}
              loading={loading}
              icon={<Icon name="refresh" size={13} />}
            >
              {t('canvas.remix.analyze')}
            </Button>
          </div>
        </div>

        {/* 词库管理 */}
        {bankOpen && (
          <div className="space-y-3 border border-border p-3">
            {WORD_CATEGORIES.map(({ key, label }) => (
              <div key={key} className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-xs text-text-secondary">{t(label)}</span>
                <input
                  value={bankDrafts[key] ?? ''}
                  onChange={(e) => setBankDrafts((d) => ({ ...d, [key]: e.target.value }))}
                  placeholder={t('canvas.remix.bankPlaceholder')}
                  className="h-7 min-w-0 flex-1 border border-border bg-surface-1 px-2 text-xs text-text-primary outline-none placeholder:text-text-disabled focus:border-primary"
                />
              </div>
            ))}
            <div className="flex justify-end">
              <Button size="sm" onClick={() => void saveWordbank()} loading={saving}>
                {t('canvas.remix.bankSave')}
              </Button>
            </div>
          </div>
        )}

        {loading && (
          <div className="flex h-32 items-center justify-center">
            <Spinner />
          </div>
        )}

        {result && !bankOpen && (
          <>
            {/* 词性概览 */}
            <div className="max-h-32 space-y-1 overflow-y-auto border border-border p-2">
              {result.cards.map((card, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate text-text-secondary">{card.text}</span>
                  <span className="shrink-0 text-text-disabled">
                    {Object.entries(card.pos)
                      .map(([k, v]) => `${k} ${v}`)
                      .join(' · ')}
                  </span>
                </div>
              ))}
            </div>

            {/* 组合候选 */}
            <div className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
              {result.remixes.map((text) => (
                <button
                  key={text}
                  type="button"
                  onClick={() => addToBoard(text)}
                  className="group flex items-center justify-between gap-2 border border-border px-3 py-2 text-left text-sm text-text-primary transition-colors hover:border-primary hover:bg-primary/5"
                >
                  <span className="min-w-0 flex-1 truncate">{text}</span>
                  <Icon name="plus" size={13} className="shrink-0 text-text-disabled transition-colors group-hover:text-primary" />
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
