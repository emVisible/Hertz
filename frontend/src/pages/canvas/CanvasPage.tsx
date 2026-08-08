import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { Board } from './Board'
import { BoardTabs } from './BoardTabs'
import { ToolDock } from './ToolDock'
import { WhispersBar } from './WhispersBar'
import { StudioInspector } from './StudioInspector'
import { LayerPanel } from './LayerPanel'
import { RemixModal } from './RemixModal'
import { Icon, useToast } from '../../components/ui'
import { useBoardStore } from '../../stores/board'
import { briefsApi } from '../../api'
import { useKeyboard } from '../../hooks/useKeyboard'

export function CanvasPage() {
  const { t } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()
  const [whisperOpen, setWhisperOpen] = useState(true)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [layersOpen, setLayersOpen] = useState(false)
  const [remixOpen, setRemixOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const dropRef = useRef<HTMLDivElement>(null)
  const board = useBoardStore((s) => s.board)
  const tool = useBoardStore((s) => s.tool)
  const showClusters = useBoardStore((s) => s.showClusters)
  const toggleClusters = useBoardStore((s) => s.toggleClusters)
  const clearBoard = useBoardStore((s) => s.clearBoard)
  const shuffleCards = useBoardStore((s) => s.shuffleCards)
  const exportBoardJson = useBoardStore((s) => s.exportBoardJson)
  const importBoardJson = useBoardStore((s) => s.importBoardJson)

  useKeyboard()

  /** 画布 → Studio：画布是流水线输入端，内容组装成创作主题一键开跑（奥卡姆：一个入口）。 */
  function runInStudio() {
    const cards = board.cards.map((c) => c.content.trim()).filter(Boolean)
    if (cards.length === 0) {
      toast(t('canvas.briefEmpty'), 'warning')
      return
    }
    const topic = `${board.name}\n\n${cards.join('\n')}`
    localStorage.setItem('hertz-studio-draft', topic.slice(0, 4000))
    navigate('/execution?mode=studio')
  }

  async function saveAsBrief() {
    const chunks = board.cards.map((c) => c.content.trim()).filter(Boolean)
    if (chunks.length === 0) {
      toast(t('canvas.briefEmpty'), 'warning')
      return
    }
    try {
      await briefsApi.create({ name: board.name, content: chunks.join('\n\n') })
      toast(t('canvas.briefSaved'), 'success')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  /** ⌘E 导出当前板为 .revel.json（与 Revel 原项目互通，AXIOM §1.2）。 */
  function exportBoard() {
    const json = exportBoardJson()
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${board.name.replace(/\s+/g, '_')}.revel.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  // ⌘E 快捷键 → 导出（useKeyboard 派发自定义事件，避免跨模块循环依赖）
  useEffect(() => {
    window.addEventListener('board:export', exportBoard)
    return () => window.removeEventListener('board:export', exportBoard)
  })

  useKeyboard()

  function importFromFile(file: File) {
    if (!file.name.endsWith('.revel.json') && !file.name.endsWith('.ravel.json')) {
      toast(t('canvas.importBadType'), 'warning')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const ok = importBoardJson(String(reader.result ?? ''))
      toast(ok ? t('canvas.imported') : t('canvas.importFailed'), ok ? 'success' : 'error')
    }
    reader.readAsText(file)
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) importFromFile(file)
  }

  return (
    <div
      ref={dropRef}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className="flex h-full min-h-0 gap-0"
    >
      <ToolDock />
      <div className="flex min-w-0 flex-1 flex-col">
        <BoardTabs />
        <div className="flex items-center gap-3 border-b border-border bg-surface-1/80 px-3 py-1.5">
          {tool === 'line' && (
            <span className="inline-flex items-center gap-1  bg-fuchsia-500/15 px-2.5 py-0.5 text-xs font-medium text-fuchsia-300">
              <Icon name="link" size={12} />
              {t('canvas.connectMode')}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setLayersOpen((v) => !v)}
              title={t('canvas.layers.title')}
              className={` p-1.5 transition-colors ${
                layersOpen
                  ? 'bg-surface-2 text-text-primary'
                  : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
              }`}
            >
              <Icon name="layers" size={16} />
            </button>
            <button
              type="button"
              onClick={() => shuffleCards()}
              title={t('canvas.shuffle')}
              className=" p-1.5 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              <Icon name="refresh" size={16} />
            </button>
            <button
              type="button"
              onClick={() => {
                if (board.cards.length === 0 && board.strokes.length === 0) return
                if (window.confirm(t('canvas.clearConfirm'))) clearBoard()
              }}
              title={t('canvas.clear')}
              className=" p-1.5 text-text-secondary transition-colors hover:bg-surface-2 hover:text-error"
            >
              <Icon name="trash" size={16} />
            </button>
            <span className="mx-1 h-4 w-px bg-border" />
            <button
              type="button"
              onClick={() => void runInStudio()}
              title={t('canvas.runInStudio')}
              className="flex items-center gap-1 border border-primary bg-primary/10 px-2 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
            >
              <Icon name="play" size={13} />
              {t('canvas.runInStudio')}
            </button>
            <button
              type="button"
              onClick={() => toggleClusters()}
              title={t('canvas.clusters')}
              className={` p-1.5 transition-colors ${
                showClusters
                  ? 'bg-primary/15 text-primary'
                  : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
              }`}
            >
              <Icon name="whisper" size={16} />
            </button>
            <button
              type="button"
              onClick={() => void saveAsBrief()}
              title={t('canvas.saveAsBrief')}
              className=" p-1.5 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              <Icon name="briefs" size={16} />
            </button>
            <button
              type="button"
              onClick={() => setRemixOpen(true)}
              title={t('canvas.remix.title')}
              className=" p-1.5 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              <Icon name="wand" size={16} />
            </button>
            <span className="mx-1 h-4 w-px bg-border" />
            <button
              type="button"
              onClick={exportBoard}
              title={t('canvas.export')}
              className=" p-1.5 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              <Icon name="downloads" size={16} />
            </button>
            <button
              type="button"
              onClick={() => dropRef.current?.querySelector<HTMLInputElement>('input[type=file]')?.click()}
              title={t('canvas.import')}
              className=" p-1.5 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              <Icon name="upload" size={16} />
            </button>
            <input
              type="file"
              accept=".revel.json,.ravel.json,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) importFromFile(file)
                e.target.value = ''
              }}
            />
            <button
              type="button"
              onClick={() => setInspectorOpen((v) => !v)}
              title="Studio 产物"
              className={` p-1.5 transition-colors ${
                inspectorOpen
                  ? 'bg-surface-2 text-text-primary'
                  : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
              }`}
            >
              <Icon name="studio" size={16} />
            </button>
            <button
              type="button"
              onClick={() => setWhisperOpen((v) => !v)}
              title="低语栏"
              className=" p-1.5 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
            >
              <Icon name="whisper" size={16} />
            </button>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 p-3">
          <LayerPanel open={layersOpen} onClose={() => setLayersOpen(false)} />
          <Board />
          <StudioInspector open={inspectorOpen} onClose={() => setInspectorOpen(false)} />
          <WhispersBar open={whisperOpen} />
          <RemixModal open={remixOpen} onClose={() => setRemixOpen(false)} />
          {dragOver && (
            <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center border-2 border-dashed border-primary bg-surface-1/70 text-sm text-primary">
              {t('canvas.importDrop')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
