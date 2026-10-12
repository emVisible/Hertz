import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { PipelineItem } from '../../api'
import { useExecutionStore } from '../../stores/execution'
import { PreReviewCard } from './PreReviewCard'

/** 「已下载未加工」卡片（只服务 downloaded 段）。 */
function item(patch: Partial<PipelineItem> = {}): PipelineItem {
  return {
    id: 'i-1',
    seq: 1,
    status: 'downloaded',
    item_type: 'text_only',
    source: 'reddit',
    source_url: 'https://www.reddit.com/r/x/comments/1/',
    media_url: null,
    source_id: 'x1',
    title: '文字帖条目',
    subreddit: 'offmychest',
    author: 'someone',
    reddit_score: 12,
    upvote_ratio: 0,
    score_total: null,
    score_dimensions: null,
    score_reasons: [],
    is_lowscore: false,
    is_invalid: false,
    archived: false,
    raw_path: null,
    video_path: null,
    cover_path: null,
    output_dir: 'pipeline/2026-10-11-01',
    produce_options: null,
    created_at: null,
    updated_at: null,
    ...patch,
  } as PipelineItem
}

const noop = () => {}

afterEach(() => {
  act(() => {
    useExecutionStore.setState({
      pipeline: { ...useExecutionStore.getState().pipeline, busy: {} },
    })
  })
})

/**
 * 状态徽标（`t(itemStatusKey(status))`）与下载态标签（`t('console.downloaded')`）
 * 在 status==='downloaded' 时会渲染出**同一个 key**——i18n 未初始化时两者都是
 * `console.downloaded`，`getByText` 无法区分。所以给状态徽标加个 data-testid，
 * 断言下载态标签时用 `queryAllByText(...).length` 排除徽标那一处。
 */
function downloadLabels() {
  return screen.queryAllByText('console.downloaded')
}

describe('PreReviewCard 下载状态判据', () => {
  it('text_only 条目下载成功（status=downloaded）既不显示「待下载」也不谎报「已下载」', () => {
    // text_only 没有原始媒体是正常形态——下载步骤对它就是 no media, skipping，
    // 只分配产物目录。照 raw_path 判会让已进的「已下载未加工」条目顶着「待下载」；
    // 照 status 无脑判「已下载」又是另一句谎（什么都没下）。所以第三态。
    render(
      <PreReviewCard
        item={item()}
        onSaveOptions={noop}
        onProduce={noop}
        onCancelProduce={noop}
        onReject={noop}
        onUploadCover={noop}
      />,
    )
    expect(screen.getByText('console.textNoMedia')).toBeInTheDocument()
    expect(screen.queryByText('console.pendingDownload')).not.toBeInTheDocument()
    // 状态徽标本身就渲染 console.downloaded（status=downloaded），这是对的；
    // 要断的是**下载态标签**那一处不存在——即全页只有徽标这一处。
    expect(downloadLabels()).toHaveLength(1)
  })

  it('有原始媒体的 video_raw 显示「已下载」', () => {
    render(
      <PreReviewCard
        item={item({ item_type: 'video_raw', raw_path: '/data/pipeline/x/raw.mp4' })}
        onSaveOptions={noop}
        onProduce={noop}
        onCancelProduce={noop}
        onReject={noop}
        onUploadCover={noop}
      />,
    )
    // 徽标 + 下载态标签两处都该在
    expect(downloadLabels()).toHaveLength(2)
    expect(screen.queryByText('console.pendingDownload')).not.toBeInTheDocument()
  })

  it('状态说已下载但文件不在：显示「素材缺失」，两头都不撒谎', () => {
    render(
      <PreReviewCard
        item={item({ item_type: 'video_raw', raw_path: null })}
        onSaveOptions={noop}
        onProduce={noop}
        onCancelProduce={noop}
        onReject={noop}
        onUploadCover={noop}
      />,
    )
    // 这一段按 status 分组，理论不该出现这个态；真出现了要让人看见异常，
    // 而不是谎报已下载，也不复用「待下载」（那是 discovered 的说法）。
    expect(screen.getByText('console.rawMissing')).toBeInTheDocument()
    expect(downloadLabels()).toHaveLength(1)   // 只剩状态徽标那一处
    expect(screen.queryByText('console.pendingDownload')).not.toBeInTheDocument()
  })

  it('制作入口在（卡片是 downloaded 段专属）', () => {
    render(
      <PreReviewCard
        item={item()}
        onSaveOptions={noop}
        onProduce={noop}
        onCancelProduce={noop}
        onReject={noop}
        onUploadCover={noop}
      />,
    )
    expect(screen.getByTitle('console.produce.nowHint')).toBeInTheDocument()
  })

  // 「在忙」要归属到动作：这张卡上除了制作还能换封面，早先写 `!!busy` 时
  // 换封面过程中按钮会显示「制作中」并转圈——用户会以为片子正在生成。
  it('换封面中：制作按钮不显示「制作中」，但仍禁用', () => {
    const { unmount } = render(
      <PreReviewCard
        item={item()}
        onSaveOptions={noop}
        onProduce={noop}
        onCancelProduce={noop}
        onReject={noop}
        onUploadCover={noop}
      />,
    )
    act(() => {
      useExecutionStore.setState({
        pipeline: {
          ...useExecutionStore.getState().pipeline,
          busy: { 'i-1': { action: 'cover', title: 'x' } },
        },
      })
    })
    const produce = screen.getByTitle('console.produce.nowHint')
    expect(produce).not.toHaveAttribute('aria-busy', 'true')
    expect(produce).toHaveTextContent('console.produce.now')
    expect(produce).toBeDisabled()
    unmount()
  })

  it('制作中：制作按钮转圈并显示「制作中」，同时给出取消入口', () => {
    render(
      <PreReviewCard
        item={item()}
        onSaveOptions={noop}
        onProduce={noop}
        onCancelProduce={noop}
        onReject={noop}
        onUploadCover={noop}
      />,
    )
    act(() => {
      useExecutionStore.setState({
        pipeline: {
          ...useExecutionStore.getState().pipeline,
          busy: { 'i-1': { action: 'produce', title: 'x' } },
        },
      })
    })
    expect(screen.getByTitle('console.produce.cancelHint')).toBeInTheDocument()
    expect(screen.queryByTitle('console.produce.nowHint')).not.toBeInTheDocument()
  })
})
