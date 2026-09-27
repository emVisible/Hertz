/** 设置/自检：Kokoro 权重、TTS、ffmpeg 状态（对 GET /api/monoline/health）。 */

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { monolineApi } from '../../api'
import { Badge, Button, Card, Input, Select, Spinner, useToast } from '../../components/ui'

function Row({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <Badge tone={ok ? 'success' : 'error'}>{ok ? 'OK' : 'NG'}</Badge>
      <span className="text-text-primary">{label}</span>
      {detail && <span className="font-mono text-xs text-text-secondary">{detail}</span>}
    </div>
  )
}

export function SetupTab() {
  const { t } = useTranslation()
  const { data, isLoading, refetch } = useQuery({ queryKey: ['monoline-health'], queryFn: monolineApi.health })

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3">
      <Card>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-text-primary">{t('monoline.setupTitle')}</span>
          <Button size="sm" variant="ghost" onClick={() => refetch()}>{t('common.refresh')}</Button>
        </div>
        {isLoading || !data ? (
          <Spinner />
        ) : (
          <div className="flex flex-col gap-2">
            <Row label={t('monoline.checkKokoro')} ok={data.kokoro_available} detail={data.kokoro_status} />
            <Row label={t('monoline.checkVoices')} ok={data.voices > 0} detail={String(data.voices)} />
            <Row label="ffmpeg" ok={data.ffmpeg} />
            <Row label="ffprobe" ok={data.ffprobe} />
            <Row label={t('monoline.checkNode')} ok={data.node_ok} detail={data.node_bin} />
            <Row
              label={t('monoline.checkHyperframes', { v: data.hyperframes_version })}
              ok={data.node_ok}
            />
            <Row label={t('monoline.checkChrome')} ok={data.chrome_available} />
            <Row label={t('monoline.checkRender')} ok={data.render_ready} />
          </div>
        )}
      </Card>
      <p className="text-xs text-text-secondary">{t('monoline.setupHint')}</p>
      <BrandCard />
    </div>
  )
}

function BrandCard() {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { data: brand } = useQuery({ queryKey: ['monoline-brand'], queryFn: monolineApi.getBrand })
  const { data: themesData } = useQuery({ queryKey: ['monoline-themes'], queryFn: monolineApi.themes })
  const [label, setLabel] = useState<string | null>(null)
  const [theme, setTheme] = useState<string | null>(null)
  const [accent, setAccent] = useState<string | null>(null)
  if (!brand) return <Spinner />
  const save = async (patch: Record<string, string>) => {
    try {
      await monolineApi.updateBrand(patch)
      queryClient.invalidateQueries({ queryKey: ['monoline-brand'] })
      toast(t('common.save'), 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error')
    }
  }
  return (
    <Card>
      <div className="mb-2 text-sm font-medium text-text-primary">{t('monoline.brandTitle')}</div>
      <div className="grid grid-cols-2 gap-3">
        <Input label={t('monoline.brandLabel')} value={label ?? brand.label} onChange={(e) => setLabel(e.target.value)} />
        <Select
          label={t('monoline.theme')}
          value={theme ?? brand.theme}
          onChange={(e) => setTheme(e.target.value)}
          options={(themesData?.themes ?? []).map((x) => ({ value: x.id, label: x.label || x.id }))}
        />
        <Input label={t('monoline.brandAccent')} value={accent ?? brand.accent ?? ''} onChange={(e) => setAccent(e.target.value)} placeholder="#C4F82A" />
        <div className="flex items-end gap-2">
          <label className="flex h-9 cursor-pointer items-center border border-border px-4 text-sm text-text-secondary hover:bg-surface-2 hover:text-text-primary">
            {t('monoline.logoUpload')}
            <input
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.svg"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (!f) return
                try {
                  await monolineApi.uploadBrandLogo(f)
                  queryClient.invalidateQueries({ queryKey: ['monoline-brand'] })
                  toast(t('common.save'), 'success')
                } catch (err) {
                  toast(err instanceof Error ? err.message : String(err), 'error')
                }
              }}
            />
          </label>
          {brand.logo_name && (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await monolineApi.removeBrandLogo()
                queryClient.invalidateQueries({ queryKey: ['monoline-brand'] })
              }}
            >
              {t('monoline.logoRemove')}
            </Button>
          )}
        </div>
      </div>
      {brand.logo_name && <p className="mt-1 font-mono text-[11px] text-text-disabled">{brand.logo_name}</p>}
      <BrandBgm />
      <div className="mt-2">
        <Button
          size="sm"
          onClick={() => save({
            ...(label !== null ? { label } : {}),
            ...(theme !== null ? { theme } : {}),
            ...(accent !== null ? { accent } : {}),
          })}
        >
          {t('common.save')}
        </Button>
      </div>
    </Card>
  )
}

function BrandBgm() {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['monoline-brand-bgm'], queryFn: monolineApi.brandBgm })
  return (
    <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
      <span className="text-xs text-text-secondary">
        {t('monoline.brandBgm')}{data?.src ? ` · ${data.src}` : ''}
      </span>
      <span className="ml-auto flex gap-1">
        <label className="flex h-7 cursor-pointer items-center px-3 text-xs text-text-secondary hover:bg-surface-2 hover:text-text-primary">
          {t('monoline.bgmUpload')}
          <input
            type="file"
            accept=".mp3,.wav,.m4a,.ogg,.flac"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              try {
                await monolineApi.uploadBrandBgm(f)
                queryClient.invalidateQueries({ queryKey: ['monoline-brand-bgm'] })
                toast(t('monoline.bgmOk'), 'success')
              } catch (err) {
                toast(err instanceof Error ? err.message : String(err), 'error')
              }
            }}
          />
        </label>
        {data?.src && (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await monolineApi.removeBrandBgm()
              queryClient.invalidateQueries({ queryKey: ['monoline-brand-bgm'] })
            }}
          >
            {t('monoline.bgmRemove')}
          </Button>
        )}
      </span>
    </div>
  )
}
