/** 新建作业：贴稿 + 参数 → 创建并审大纲。 */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { monolineApi } from '../../api'
import { Button, Card, EmptyState, Input, Select, useToast } from '../../components/ui'

export function NewTab({ onCreated }: { onCreated: (id: string) => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [script, setScript] = useState('')
  const [voice, setVoice] = useState('')
  const [theme, setTheme] = useState('')
  const [speed, setSpeed] = useState('1.0')
  const [brand, setBrand] = useState('Monoline')
  const [busy, setBusy] = useState(false)
  const [topic, setTopic] = useState('')
  const [genBusy, setGenBusy] = useState(false)

  const { data: voicesData } = useQuery({ queryKey: ['monoline-voices'], queryFn: monolineApi.voices })
  const { data: themesData } = useQuery({ queryKey: ['monoline-themes'], queryFn: monolineApi.themes })
  const voices = voicesData?.voices ?? []
  const themes = themesData?.themes ?? []

  const submit = async () => {
    const text = script.trim()
    if (!text) {
      toast(t('monoline.scriptRequired'), 'error')
      return
    }
    setBusy(true)
    try {
      const created = await monolineApi.create(text, {
        voice: voice || undefined,
        theme: theme || undefined,
        speed: Number(speed) || 1.0,
        brand: brand || undefined,
      })
      await monolineApi.buildOutline(created.id)
      onCreated(created.id)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-3">
      <Card>
        <label className="mb-1 block text-xs text-text-secondary" htmlFor="mono-topic">
          {t('monoline.genTitle')}
        </label>
        <div className="flex gap-2">
          <input
            id="mono-topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={t('monoline.genPlaceholder')}
            className="min-w-0 flex-1 border border-border bg-surface-1 px-2 py-1 text-sm text-text-primary outline-none focus:border-primary"
          />
          <Button
            variant="secondary"
            disabled={genBusy || !topic.trim()}
            onClick={async () => {
              setGenBusy(true)
              try {
                const r = await monolineApi.generateScript(topic.trim())
                setScript(r.script)
                toast(t('monoline.genOk', { beats: r.beats }), 'success')
              } catch (e) {
                toast(e instanceof Error ? e.message : String(e), 'error')
              } finally {
                setGenBusy(false)
              }
            }}
          >
            {genBusy ? t('common.loading') : t('monoline.generate')}
          </Button>
        </div>
      </Card>
      <Card>
        <label className="mb-1 block text-xs text-text-secondary" htmlFor="mono-script">
          {t('monoline.pasteScript')}
        </label>
        <textarea
          id="mono-script"
          rows={10}
          value={script}
          onChange={(e) => setScript(e.target.value)}
          placeholder={t('monoline.scriptPlaceholder')}
          className="w-full border border-border bg-surface-1 p-2 text-sm text-text-primary outline-none focus:border-primary"
        />
      </Card>
      <Card>
        <div className="grid grid-cols-2 gap-3">
          <Select
            label={t('monoline.voice')}
            value={voice}
            onChange={(e) => setVoice(e.target.value)}
            options={[
              { value: '', label: t('monoline.autoVoice') },
              ...voices.map((v) => ({ value: v.id, label: `${v.label} · ${v.id}` })),
            ]}
          />
          <Select
            label={t('monoline.theme')}
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
            options={[
              { value: '', label: t('monoline.autoTheme') },
              ...themes.map((x) => ({ value: x.id, label: x.label || x.id })),
            ]}
          />
          <Input label={t('monoline.speed')} value={speed} onChange={(e) => setSpeed(e.target.value)} placeholder="1.0" />
          <Input label={t('monoline.brand')} value={brand} onChange={(e) => setBrand(e.target.value)} />
        </div>
        {voice && (
          <div className="mt-2">
            <div className="mb-1 text-xs text-text-secondary">{t('monoline.audition')}</div>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <audio controls src={monolineApi.sampleUrl(voice)} className="w-full" />
          </div>
        )}
      </Card>
      <div className="flex items-center gap-2">
        <Button onClick={submit} disabled={busy}>
          {busy ? t('common.loading') : t('monoline.createAndOutline')}
        </Button>
        {!script.trim() && <EmptyState title="" description={t('monoline.newHint')} />}
      </div>
    </div>
  )
}
