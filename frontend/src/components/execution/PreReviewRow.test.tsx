/** 预处理紧凑行的「在忙」归属（v0.34 修）。
 *
 * 用户实测报的原话：「我在未评分里点击直接下载，评分也会同样改变状态为评分中
 * 且额外有一个提示 icon 在旋转」。
 *
 * 根因：三个按钮都写 `loading={!!busy}` + `busy ? <自己的忙态文案> : …`。
 * `busy` 是**这条目**上任意动作，于是点下载时评分按钮也转起来、文案也变成
 * 「评分中」——界面上呈现两个动作同时在跑，而评分压根没被调用。
 *
 * 本文件钉住正确形状：`loading` 与忙态文案按 `busy.action` 判定，
 * `disabled` 仍按 `!!busy`（同一条目不允许并发两个写操作）。
 */
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { PipelineItem } from '../../api'
import { useExecutionStore } from '../../stores/execution'
import { PreReviewRow } from './PreReviewRow'

function item(patch: Partial<PipelineItem> = {}): PipelineItem {
  return {
    id: 'i-1',
    seq: 1,
    status: 'discovered',
    item_type: 'video_raw',
    source: 'reddit',
    source_url: 'https://www.reddit.com/r/x/comments/1/',
    media_url: null,
    source_id: 'x1',
    title: '待评分条目',
    subreddit: 'offmychest',
    author: 'someone',
    reddit_score: 12,
    upvote_ratio: 0.9,
    score_total: null,
    score_dimensions: null,
    score_reasons: [],
    is_lowscore: false,
    is_invalid: false,
    archived: false,
    raw_path: null,
    video_path: null,
    cover_path: null,
    created_at: null,
    updated_at: null,
    ...patch,
  } as PipelineItem
}

const noop = () => {}

function renderRow(stage: 'discovered' | 'scored', i = item()) {
  return render(
    <PreReviewRow
      item={i}
      stage={stage}
      onScore={noop}
      onDownload={noop}
      onDownloadDirect={noop}
      onReject={noop}
    />,
  )
}

/** 按 title 找按钮（未参与 i18n 初始化时 t() 直接回显 key）。 */
function btn(titleKey: string): HTMLElement {
  return screen.getByTitle(titleKey)
}

afterEach(() => {
  useExecutionStore.setState({ pipeline: { ...useExecutionStore.getState().pipeline, busy: {} } })
})

describe('PreReviewRow：在忙归属到动作', () => {
  it('下载中：下载按钮转圈 + 文案「下载中」，评分按钮保持静止', () => {
    useExecutionStore.setState({
      pipeline: { ...useExecutionStore.getState().pipeline, busy: { 'i-1': { action: 'download', title: 'x' } } },
    })
    renderRow('discovered')

    const dl = btn('console.downloadUnscoredHint')
    expect(dl).toHaveAttribute('aria-busy', 'true')
    expect(dl).toHaveTextContent('console.busy.download')

    // 这条是本次修复的主角：评分没被调用，就不许显示评分中、更不许转圈
    const score = btn('console.scoreHint')
    expect(score).not.toHaveAttribute('aria-busy')
    expect(score).toHaveTextContent('console.score')
    expect(score).not.toHaveTextContent('console.busy.score')
    // 但仍然禁用：同一条目不许并发另一个写操作
    expect(score).toBeDisabled()
  })

  it('评分中：评分按钮转圈 + 文案「评分中」，下载按钮保持静止', () => {
    useExecutionStore.setState({
      pipeline: { ...useExecutionStore.getState().pipeline, busy: { 'i-1': { action: 'score', title: 'x' } } },
    })
    renderRow('discovered')

    const score = btn('console.scoreHint')
    expect(score).toHaveAttribute('aria-busy', 'true')
    expect(score).toHaveTextContent('console.busy.score')

    const dl = btn('console.downloadUnscoredHint')
    expect(dl).not.toHaveAttribute('aria-busy')
    expect(dl).toHaveTextContent('console.downloadUnscored')
    expect(dl).toBeDisabled()
  })

  it('闲置：两个按钮都不转圈，文案都是常态', () => {
    renderRow('discovered')
    expect(btn('console.downloadUnscoredHint')).not.toHaveAttribute('aria-busy')
    expect(btn('console.scoreHint')).not.toHaveAttribute('aria-busy')
    expect(screen.getByTitle('console.scoreHint')).toBeEnabled()
  })

  it('已评分段：下载中只有下载按钮转圈', () => {
    useExecutionStore.setState({
      pipeline: { ...useExecutionStore.getState().pipeline, busy: { 'i-1': { action: 'download', title: 'x' } } },
    })
    renderRow('scored')
    const dl = btn('console.downloadHint')
    expect(dl).toHaveAttribute('aria-busy', 'true')
    expect(dl).toHaveTextContent('console.busy.download')
  })

  it('别的动作（如 reject）在跑：两个按钮都不转圈，但都被禁用', () => {
    // 归属要精确到动作：未知/别的动作不该让任何按钮冒充「下载中/评分中」。
    useExecutionStore.setState({
      pipeline: { ...useExecutionStore.getState().pipeline, busy: { 'i-1': { action: 'reject', title: 'x' } } },
    })
    renderRow('discovered')
    expect(btn('console.downloadUnscoredHint')).not.toHaveAttribute('aria-busy')
    expect(btn('console.scoreHint')).not.toHaveAttribute('aria-busy')
    expect(btn('console.downloadUnscoredHint')).toBeDisabled()
    expect(btn('console.scoreHint')).toBeDisabled()
  })
})
