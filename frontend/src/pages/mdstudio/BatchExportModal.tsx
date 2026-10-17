/** MD Studio 批量出图队列（§10 候选 4）。
 *
 * 一次选中多篇排版稿 → 逐篇出图 → 打成一个 ZIP（每篇一个子目录）。
 * 内核早就支持逐篇出图，缺的是队列：进度、失败原因、取消、以及「一个批次一个包」
 * 这个交付形状——顺序触发 N 次浏览器下载会被宿主拦，用户最后只拿到最后一篇。
 *
 * 批量只做**出图**：微信/知乎在小红书之外的场景是长图 PNG，所以这里对小红书出卡片组、
 * 其余平台出长图，与单篇导出保持同一套判定（同一平台同一形状），避免两条路各说各话。
 */

import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  applyTheme,
  codeThemeNameFor,
  exportCards,
  highlightCodeBlocks,
  parseToIR,
  renderLongImage,
  renderMermaidCache,
  xhsCards,
  zipBlobs,
  type ThemeOverrides,
} from '@hertz/mdcore'

import { layoutApi, type LayoutPlatform } from '../../api'
import { Button, Icon, Modal, Progress, useToast } from '../../components/ui'
import { batchFileName, downloadBlob, safeEntryName, yieldToUi } from './shared'

export interface BatchTarget {
  id: string
  title: string
  platform: LayoutPlatform
}

type ItemState = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

interface BatchExportModalProps {
  open: boolean
  targets: BatchTarget[]
  onClose: () => void
  /** 全部跑完后回调（宿主据此清空选择） */
  onFinished?: (ok: boolean) => void
}

const STATE_TONE: Record<ItemState, string> = {
  pending: 'text-text-disabled',
  running: 'text-primary',
  done: 'text-success',
  failed: 'text-error',
  skipped: 'text-warning',
}

export function BatchExportModal({ open, targets, onClose, onFinished }: BatchExportModalProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const [states, setStates] = useState<Record<string, ItemState>>({})
  const [details, setDetails] = useState<Record<string, string>>({})
  const [running, setRunning] = useState(false)
  const cancelRef = useRef(false)

  const done = targets.filter((item) => states[item.id] === 'done').length
  const failed = targets.filter((item) => states[item.id] === 'failed').length
  const progress = targets.length ? ((done + failed) / targets.length) * 100 : 0

  const patch = (id: string, state: ItemState, detail?: string) => {
    setStates((prev) => ({ ...prev, [id]: state }))
    setDetails((prev) => {
      const next = { ...prev }
      if (detail) next[id] = detail
      else delete next[id]
      return next
    })
  }

  const reset = () => {
    setStates({})
    setDetails({})
  }

  const start = async () => {
    if (running || targets.length === 0) return
    cancelRef.current = false
    reset()
    setRunning(true)
    const entries: Array<{ name: string; blob: Blob }> = []
    let anyOk = false

    for (const [i, item] of targets.entries()) {
      if (cancelRef.current) {
        patch(item.id, 'skipped', t('mdstudio.batch.skipped'))
        continue
      }
      patch(item.id, 'running')
      try {
        const doc = await layoutApi.get(item.id)
        if (!doc.source_md.trim()) {
          patch(item.id, 'skipped', t('mdstudio.batch.emptySource'))
          continue
        }
        const ir = parseToIR(doc.source_md)
        const overrides = (doc.overrides ?? {}) as ThemeOverrides
        const cover = (doc.cover ?? {}) as { footer?: string; qr?: string | null; breaks?: number[] }
        const folder = `${String(i + 1).padStart(2, '0')}-${safeEntryName(doc.title || item.title)}`
        // Mermaid 预渲染（P2-4）+ Shiki 二次 pass（P1-3）：与单篇导出同一套，
        // 两条路各做各的正是这仓反复吃过的亏——单篇有、批量没有，用户分不出区别。
        const { cache } = await renderMermaidCache(ir)
        const mermaid = cache.size ? cache : undefined
        const themeName = codeThemeNameFor(doc.theme_id, overrides)
        if (doc.platform === 'xhs') {
          const result = xhsCards(ir, {
            theme: doc.theme_id,
            overrides,
            footer: cover.footer ?? '',
            qr: cover.qr ?? null,
            breaks: Array.isArray(cover.breaks) ? cover.breaks : undefined,
            mermaid,
          })
          for (const page of result.pages) await highlightCodeBlocks(page, { themeName })
          const blobs = await exportCards(result.pages)
          blobs.forEach((blob, page) => {
            entries.push({
              name: `${folder}/page-${String(page + 1).padStart(2, '0')}.png`,
              blob,
            })
          })
          patch(item.id, 'done', t('mdstudio.batch.cards', { count: blobs.length }))
        } else {
          const el = applyTheme(ir, doc.theme_id, overrides, document, undefined, { mermaid })
          await highlightCodeBlocks(el, { themeName })
          el.style.width = doc.platform === 'zhihu' ? '690px' : '375px'
          el.style.boxSizing = 'border-box'
          document.body.appendChild(el)
          try {
            const blob = await renderLongImage(el)
            entries.push({ name: `${folder}/long.png`, blob })
          } finally {
            el.remove()
          }
          patch(item.id, 'done', t('mdstudio.batch.longImage'))
        }
        anyOk = true
      } catch (e) {
        // 单篇失败不该掐掉整批：记原因、继续下一篇，最后统一报告
        patch(item.id, 'failed', (e as Error).message || t('mdstudio.batch.failed'))
      }
      await yieldToUi()
    }

    if (entries.length === 0) {
      // 一张都没出来：取消就说取消，没取消就是真的没有可导出的东西
      toast(
        cancelRef.current ? t('mdstudio.batch.canceled') : t('mdstudio.batch.nothing'),
        cancelRef.current ? 'warning' : 'error',
      )
    } else {
      // 取消也要交付已经出的那几篇：让用户为一次取消丢掉几十 MB 渲染结果是产品缺陷
      const zip = await zipBlobs(entries)
      downloadBlob(zip, batchFileName())
      toast(
        cancelRef.current
          ? t('mdstudio.batch.partial', { count: entries.length })
          : t('mdstudio.batch.done', { count: entries.length }),
        cancelRef.current ? 'warning' : 'success',
      )
    }
    setRunning(false)
    onFinished?.(anyOk)
  }

  return (
    <Modal open={open} title={t('mdstudio.batch.title')} onClose={onClose} width={560}>
      <p className="mb-3 text-xs text-text-secondary">{t('mdstudio.batch.hint')}</p>
      <Progress value={running || done + failed > 0 ? progress : 0} className="mb-4" />
      <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
        {targets.map((item) => {
          const state = states[item.id] ?? 'pending'
          return (
            <li key={item.id} className="flex items-center gap-2 rounded px-1 py-1 text-xs">
              <span className="min-w-0 flex-1 truncate text-text-primary">{item.title}</span>
              <span className="shrink-0 text-text-disabled">{t(`mdstudio.platform.${item.platform}`)}</span>
              <span className={`w-16 shrink-0 text-right ${STATE_TONE[state]}`}>
                {t(`mdstudio.batch.state.${state}`)}
              </span>
              {details[item.id] && (
                <span className="w-28 shrink-0 truncate text-right text-text-disabled" title={details[item.id]}>
                  {details[item.id]}
                </span>
              )}
            </li>
          )
        })}
      </ul>
      <div className="mt-5 flex items-center justify-end gap-2">
        {running ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<Icon name="stop" size={12} />}
            onClick={() => {
              cancelRef.current = true
            }}
          >
            {t('mdstudio.batch.cancel')}
          </Button>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={onClose}>
              {t('common.close')}
            </Button>
            <Button size="sm" onClick={() => void start()} disabled={targets.length === 0}>
              {t('mdstudio.batch.start')}
            </Button>
          </>
        )}
      </div>
    </Modal>
  )
}