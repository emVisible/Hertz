/** Pipeline 发布 tab（v0.20 拆分，D-183）：列表｜发布队列｜内容日历 三视图。
 *  纯结构移动自 PipelineView（原 1162-1350 行段），零行为变化；state 留主壳经 props 下发。 */

import { useTranslation } from 'react-i18next'

import { Badge, Button, Icon } from '../../../components/ui'
import {
  PipelineStage,
  PublishCard,
  SectionCard,
  StageItemRow,
  StageList,
  QueueView,
} from '../../../components/execution'
import { CalendarView } from '../CalendarView'
import type { PipelineViewProps } from './shared'

// 发布 tab 视图：列表（默认）｜发布队列（v0.12 融合）｜内容日历（v0.2.3）
export type PostView = 'list' | 'queue' | 'calendar'

interface PostReviewTabProps {
  p: PipelineViewProps
  postView: PostView
  setPostView: (v: PostView) => void
}

export function PostReviewTab({ p, postView, setPostView }: PostReviewTabProps) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-4 p-4">
      {/* 视图切换：列表（默认）｜发布队列（v0.12）｜内容日历（v0.2.3，Buffer/新榜同款） */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setPostView('list')}
          className={`px-2.5 py-1 text-xs transition-colors ${
            postView === 'list'
              ? 'bg-surface-2 font-medium text-text-primary'
              : 'text-text-secondary hover:bg-surface-2/60'
          }`}
        >
          {t('console.calendarList')}
        </button>
        <button
          type="button"
          onClick={() => setPostView('queue')}
          className={`px-2.5 py-1 text-xs transition-colors ${
            postView === 'queue'
              ? 'bg-surface-2 font-medium text-text-primary'
              : 'text-text-secondary hover:bg-surface-2/60'
          }`}
        >
          {t('console.queueView')}
        </button>
        <button
          type="button"
          onClick={() => setPostView('calendar')}
          className={`px-2.5 py-1 text-xs transition-colors ${
            postView === 'calendar'
              ? 'bg-surface-2 font-medium text-text-primary'
              : 'text-text-secondary hover:bg-surface-2/60'
          }`}
        >
          {t('console.calendar')}
        </button>
      </div>

      {postView === 'calendar' ? (
        <CalendarView
          onSaveSchedule={(item, value) => p.saveMeta(item, { scheduled_at: value })}
        />
      ) : postView === 'queue' ? (
        <QueueView />
      ) : (
        <>
          {/* 发布目标状态（v0.3.8）：noop/缺 cookie 时醒目警示，避免「点了没反应」 */}
          {p.publishStatus && (
            <div
              className={`mx-4 mt-3 flex items-start gap-2 rounded border px-3 py-2 text-xs ${
                p.publishStatus.noop
                  ? 'border-warning/40 bg-warning/10 text-warning'
                  : p.publishStatus.target === 'bilibili' && !p.publishStatus.cookie_exists
                    ? 'border-warning/40 bg-warning/10 text-warning'
                    : 'border-border bg-surface-1/60 text-text-secondary'
              }`}
            >
              <Icon name="config" size={13} className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                {p.publishStatus.noop ? (
                  <>
                    <span className="font-medium">{t('console.publishNoopTitle')}</span>
                    <span className="ml-2">{t('console.publishNoopHint')}</span>
                  </>
                ) : p.publishStatus.target === 'bilibili' && !p.publishStatus.cookie_exists ? (
                  <>
                    <span className="font-medium">
                      {t('console.publishCookieMissing')} — {p.publishStatus.cookie_path}
                    </span>
                    <span className="ml-2">{t('console.publishCookieHint')}</span>
                  </>
                ) : (
                  <>
                    <span className="font-medium">
                      {t('console.publishReady')} → {p.publishStatus.target}
                    </span>
                    {p.publishStatus.target === 'bilibili' && (
                      <span className="ml-2">{t('console.publishCookieReady')}</span>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
          {/* 审核后：approved（发布操作） */}
          <PipelineStage
            title={t('console.stagePublish')}
            isEmpty={false}
            emptyText={t('console.emptyPublish')}
          >
            <StageList
              items={p.stageApproved}
              emptyText={t('console.emptyPublish')}
              renderRow={(item) => (
                <PublishCard
                  item={item}
                  onPublish={(i, selfmade, target, now) => p.publishItem(i, selfmade, target, now)}
                  onSaveMeta={(i, meta) => p.saveMeta(i, meta)}
                  onRequeue={(i) => void p.act(i, 'requeue')}
                  onRandomCover={(i) => void p.randomCover(i)}
                  onEnqueue={(i, phase) => void p.enqueueItem(i, phase)}
                />
              )}
            />
            <p className="border-t border-border/60 px-3 py-2 text-[10px] text-text-disabled">
              {t('console.publishHint')}
            </p>
          </PipelineStage>

          {/* 发布历史（v0.3.8）：已发布内容完整回到发布列表（100 条） */}
          <div className="mt-4">
            <SectionCard title={`${t('console.publishHistory')} (${p.stagePublished.length})`} padded={false}>
              {p.stagePublished.length === 0 ? (
                <p className="p-3 text-sm text-text-disabled">{t('console.noPublishes')}</p>
              ) : (
                <StageList
                  items={p.stagePublished}
                  emptyText={t('console.noPublishes')}
                  renderRow={(item) => (
                    <StageItemRow
                      item={item}
                      badge={
                        <span className="flex items-center gap-1">
                          <Badge tone="success">published</Badge>
                          {/* 分发目标（v0.3.4）：发布记录的目标徽章 */}
                          {(item.publish_json?.target ? (
                            <Badge tone="neutral">{String(item.publish_json.target)}</Badge>
                          ) : null)}
                          {/* 发布数据（v0.4 C1）：回捞/补录的播放·互动 */}
                          {(() => {
                            const stats = (item.publish_json?.stats ?? null) as
                              | Record<string, number>
                              | null
                            if (!stats) return null
                            return (
                              <Badge tone="primary">
                                <span title={t('console.statsTitle')}>
                                  ▶ {stats.view ?? 0}
                                </span>
                              </Badge>
                            )
                          })()}
                          {/* 发布时间（v0.3.8） */}
                          {item.published_at && (
                            <span className="font-mono text-[10px] text-text-disabled">
                              {new Date(item.published_at).toLocaleString()}
                            </span>
                          )}
                        </span>
                      }
                      right={
                        <span className="flex items-center gap-1.5">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void p.setPublishStats(item)}
                            title={t('console.statsHint')}
                          >
                            <Icon name="tag" size={12} />
                            {t('console.stats')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void p.act(item, 'requeue')}
                            title={t('console.backToReviewHint')}
                          >
                            {t('console.backToReview')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void p.publishItem(item, false)}
                            title={t('console.republishHint')}
                          >
                            {t('console.republish')}
                          </Button>
                        </span>
                      }
                    />
                  )}
                />
              )}
            </SectionCard>
          </div>
        </>
      )}
    </div>
  )
}
