import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ReactNode } from 'react'

import type { PipelineItem } from '../../api'
import { useExecutionStore } from '../../stores/execution'
import { Badge, Button, CopyButton, Icon } from '../ui'
import { ITEM_TYPE_BADGE, MediaThumb, PIPELINE_ITEM_TONE } from './PipelineStage'
import { ScoreDims } from './ScoreDims'

/** 审核卡片（v0.3.2 重构：内容审核专用——发布元数据全部移到发布卡）：
 *  媒体（播放/换封面）+ 原始标题只读 + 源头审核链接 + 评分维度网格 +
 *  文案折叠 + 操作组（打回预处理/通过/拒绝——v0.3.9 职责单一）。
 *  标题/标签/分区/排期/版权等 B站发布元数据 → PublishCard。 */
export function AuditCard({
  item,
  onApprove,
  onReject,
  onUploadCover,
  onRandomCover,
  onBackToPrep,
  focused,
  selectMode,
  onSelect,
  selected,
  pick,
}: {
  item: PipelineItem
  onApprove: (item: PipelineItem) => void
  onReject: (item: PipelineItem) => void
  onUploadCover: (item: PipelineItem, file: File) => void
  /** 随机抽帧封面（v0.11.9）：审核时即可换封面——所见即发布 */
  onRandomCover?: (item: PipelineItem) => void
  onBackToPrep: (item: PipelineItem) => void
  /** 键盘导航焦点（v0.4 A1）：j/k 移动，a/r/b 操作 */
  focused?: boolean
  /** 批量选择模式（wave10.1）：模式下点击整卡切换选中（交互元素除外） */
  selectMode?: boolean
  /** 多选切换（v0.4 A2）：传了才可批量 */
  onSelect?: (item: PipelineItem) => void
  /** 已勾选（v0.4 A2）：高亮 */
  selected?: boolean
  /** 「捞入今日」（v0.34 D-218）：入口由列表侧决定，卡片自己不发起写（`TodayPick`） */
  pick?: ReactNode
}) {
  const { t } = useTranslation()
  // v0.11.3：审核操作进行中——按钮转圈 + 防重复提交
  const busy = useExecutionStore((s) => s.pipeline.busy[item.id])
  const [open, setOpen] = useState(false)
  const coverInputRef = useRef<HTMLInputElement>(null)
  const script = item.script_json
  // v0.11.9：卡片标题 = 发布标题（B 站中文包装）——审核所见即发布所得；
  // 未加工/无包装时回退原版标题；原版标题降级到 meta 行小字（不丢原文可读性）
  const biliTitle = (script?.bili_title as string | undefined) ?? item.title
  const titleIsLocalized = biliTitle !== item.title
  const scriptBody =
    (script as Record<string, unknown>)?.narration ??
    (script as Record<string, unknown>)?.script ??
    (script as Record<string, unknown>)?.subtitle_zh ??
    ''

  return (
    <li
      id={`audit-item-${item.id}`}
      onClick={(e) => {
        if (!onSelect || !selectMode) return
        // 交互元素（按钮/链接/输入/折叠）不误选
        if ((e.target as HTMLElement).closest('button,a,label,input,textarea,summary')) return
        e.preventDefault()
        onSelect(item)
      }}
      className={`group flex gap-5 px-4 py-4 transition-shadow ${
        focused ? 'ring-2 ring-primary/60 ring-inset' : ''
      } ${selected ? 'bg-primary/5' : ''} ${selectMode ? 'cursor-pointer' : ''}`}
    >
      {/* 选中指示（wave10.1 批量选择模式）：左侧竖条——不占布局、无常驻 checkbox */}
      {selectMode && (
        <span
          className={`w-1 shrink-0 rounded-full transition-colors ${
            selected ? 'bg-primary' : 'bg-transparent'
          }`}
          aria-hidden
        />
      )}
      {/* 媒体区（相册感）：w-1/3 宽度，16:9 圆角卡片 + 柔和阴影 + 留白 */}
      <div className="group/cover relative aspect-video w-1/3 shrink-0">
        <div className="aspect-video overflow-hidden rounded-lg shadow-sm">
          <MediaThumb item={item} className="h-full w-full" />
        </div>
        {onRandomCover && (
          <button
            type="button"
            disabled={busy?.action === 'cover'}
            onClick={() => onRandomCover(item)}
            title={t('console.coverRandomHint')}
            aria-label={t('console.coverRandomHint')}
            className="absolute bottom-1.5 right-10 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-black/55 text-white/90 opacity-0 backdrop-blur-sm transition-opacity group-hover/cover:opacity-100 hover:border-primary hover:text-primary disabled:opacity-40"
          >
            <Icon name="refresh" size={13} className={busy?.action === 'cover' ? 'animate-spin' : ''} />
          </button>
        )}
        <button
          type="button"
          onClick={() => coverInputRef.current?.click()}
          title={t('console.changeCover')}
          aria-label={t('console.changeCover')}
          className="absolute bottom-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-black/55 text-white/90 opacity-0 backdrop-blur-sm transition-opacity group-hover/cover:opacity-100 hover:border-primary hover:text-primary"
        >
          <Icon name="edit" size={13} />
        </button>
        <input
          ref={coverInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onUploadCover(item, file)
            e.target.value = ''
          }}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          {/* 发布标题（v0.11.9：审核所见 = 发布所得）——仅读展示，编辑在发布卡 */}
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary" title={biliTitle}>
            {biliTitle}
          </p>
          {/* 类型徽章（v0.8）：图片/视频一眼区分 */}
          {ITEM_TYPE_BADGE[item.item_type] && (
            <Badge tone={ITEM_TYPE_BADGE[item.item_type].tone}>
              {t(ITEM_TYPE_BADGE[item.item_type].labelKey)}
            </Badge>
          )}
          <Badge tone={PIPELINE_ITEM_TONE[item.status] ?? 'neutral'}>{item.status}</Badge>
          {/* v0.8.9 AXIOM 4.6：原片兜底交付（合成失败降级）——如实标注，不伪装完整成功 */}
          {(item.script_json as Record<string, unknown> | null)?.produced_degraded != null && (
            <span className="shrink-0 border border-warning/50 px-1.5 py-0.5 text-[10px] leading-none text-warning">
              {t('console.degradedRaw')}
            </span>
          )}
          {/* v0.9 compose_quality：字幕烧录降级/音频守卫重混——不静默降级 */}
          {(item.script_json as Record<string, unknown> | null)?.compose_quality != null &&
            ((item.script_json as Record<string, unknown>).compose_quality as Record<string, unknown>).burn !== 'ass' && (
              <span className="shrink-0 border border-warning/50 px-1.5 py-0.5 text-[10px] leading-none text-warning">
                {t('console.subsBurnFallback')}
              </span>
            )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-text-secondary">
          {/* 原版标题（v0.11.9：发布标题不同时降级展示，hover 看全文） */}
          {titleIsLocalized && (
            <span
              className="max-w-56 truncate border border-border px-1.5 py-0.5 text-[10px] text-text-disabled"
              title={item.title}
            >
              [EN] {item.title}
            </span>
          )}
          {/* 源头审核：subreddit 可点击直达源帖（系统浏览器打开） */}
          {item.source_url ? (
            <a
              href={item.source_url}
              target="_blank"
              rel="noopener noreferrer"
              title={t('console.viewSource')}
              className="border border-border px-1.5 py-0.5 text-[10px] text-text-secondary transition-colors hover:border-primary hover:text-primary"
            >
              r/{item.subreddit}
            </a>
          ) : (
            <Badge tone="neutral">r/{item.subreddit}</Badge>
          )}
          <Badge tone="neutral">u/{item.author}</Badge>
          <Badge tone="neutral">r{item.reddit_score}</Badge>
          {item.score_total != null && <Badge tone="primary">AI {item.score_total.toFixed(1)}</Badge>}
          {/* 未评分（v0.11.10）：直下条目无 AI 参考——显式标注而非留空。
              is_lowscore 与 score_total 同源于 ScoreStep，无需叠加判断 */}
          {item.score_total == null && (
            <Badge tone="neutral">{t('console.unscored')}</Badge>
          )}
          {item.is_lowscore && (
            <span className="border border-warning/50 px-1.5 py-0.5 text-[10px] leading-none text-warning">
              {t('console.lowScore')}
            </span>
          )}
          {/* 旁白回退字幕（v0.22.x）：原声字幕不可用时的静默降级显性化 */}
          {(item.script_json as Record<string, unknown> | null)?.subtitle_source ===
            'narration_fallback' && (
            <span
              title={t('console.narrationFallbackHint')}
              className="border border-warning/50 px-1.5 py-0.5 text-[10px] leading-none text-warning"
            >
              ⚠️ {t('console.narrationFallback')}
            </span>
          )}
          {/* 预检警告（v0.22.x D-190）：ASR/LLM/TTS 缺失等非阻断降级 */}
          {Array.isArray((item.script_json as Record<string, unknown> | null)?.produce_warnings) &&
           ((item.script_json as Record<string, unknown>).produce_warnings as string[]).length > 0 && (
            <span
              title={((item.script_json as Record<string, unknown>).produce_warnings as string[]).join('\n')}
              className="border border-warning/50 px-1.5 py-0.5 text-[10px] leading-none text-warning"
            >
              ⚠️ {((item.script_json as Record<string, unknown>).produce_warnings as string[]).length} 项警告
            </span>
          )}
          {/* 相似内容提示（v0.5 A）：phash 判重防重复投稿 */}
          {item.similar && (item.similar.published.length > 0 || item.similar.queued.length > 0) && (
            <span
              title={[
                ...(item.similar.published.length > 0
                  ? [t('console.similarPublished') + ': ' + item.similar.published.join(' | ')]
                  : []),
                ...(item.similar.queued.length > 0
                  ? [t('console.similarQueued') + ': ' + item.similar.queued.join(' | ')]
                  : []),
              ].join('\n')}
              className="border border-warning/60 bg-warning/10 px-1.5 py-0.5 text-[10px] leading-none text-warning"
            >
              ⚠ {t('console.similar')}
              {item.similar.published.length > 0 && ` · ${t('console.similarPublished')}×${item.similar.published.length}`}
              {item.similar.queued.length > 0 && ` · ${t('console.similarQueued')}×${item.similar.queued.length}`}
            </span>
          )}
          {item.source_url && (
            <a
              href={item.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary transition-colors hover:bg-primary/20"
            >
              <Icon name="link" size={10} />
              {t('console.viewSource')}
            </a>
          )}
        </div>
        {/* 评分维度：独立迷你网格 */}
        <ScoreDims dims={item.score_dimensions} />
        {item.error && <p className="mt-1 text-xs text-error">{item.error}</p>}

        {script && (
          <details className="mt-2" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
            <summary
              className="cursor-pointer select-none text-xs text-text-secondary hover:text-text-primary"
              aria-label={`${t('console.script')}: ${item.title}`}
            >
              {t('console.script')}
            </summary>
            <div className="relative mt-1 border border-border bg-surface-2/50">
              <CopyButton text={String(scriptBody)} className="absolute right-1.5 top-1.5" />
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap p-2 pr-9 font-mono text-[11px] leading-relaxed text-text-primary">
                {String(scriptBody || '—')}
              </pre>
            </div>
          </details>
        )}

        {/* 操作区（v0.3.9 职责单一）：审核只负责 通过 / 拒绝 / 打回预处理 */}
        <div className="mt-2 flex items-center justify-end gap-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
          {pick}
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy}
            onClick={() => onBackToPrep(item)}
            title={t('console.backToPrepHint')}
          >
            <Icon name="rewind" size={12} />
            {t('console.backToPrep')}
          </Button>
          <Button
            size="sm"
            className="w-20"
            loading={busy?.action === 'approve'}
            disabled={!!busy}
            onClick={() => onApprove(item)}
          >
            <Icon name="check" size={12} />
            {busy?.action === 'approve' ? t('console.busy.approve') : t('console.approve')}
          </Button>
          <Button
            size="sm"
            variant="danger"
            className="w-20"
            loading={busy?.action === 'reject'}
            disabled={!!busy}
            onClick={() => onReject(item)}
          >
            <Icon name="close" size={12} />
            {busy?.action === 'reject' ? t('console.busy.reject') : t('console.reject')}
          </Button>
        </div>
      </div>
    </li>
  )
}
