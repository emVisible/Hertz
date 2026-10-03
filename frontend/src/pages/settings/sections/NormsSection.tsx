/** 设置 ·「我的规范与固定计划」（v0.34）——运营者自己的一本册子。
 *
 * 为什么单独一节：这两段文字**只有你看**，不进任何 AI 提示词。它们和
 * `channel_persona`（会被 `ai/router.py` 拼进脚本与标题 prompt）的区别就是
 * 「改了这个不会改动产出」——混在同一格里，改个备注就会顺手改了视频口播。
 *
 * 为什么也不放看板：看板那个是**每天一条**的目标（存 `daily_goal`），
 * 这两段是**长期一份**（存 runtime.yaml）。按天的东西放设置页，每天要多切一次屏。
 */

import { useTranslation } from 'react-i18next'

import { Button } from '../../../components/ui'
import { heading, section, sub } from './shared'

interface NormsSectionProps {
  form: Record<string, string>
  set: (key: string, value: string) => void
  save: () => void
  dirty: boolean
}

const area =
  'w-full resize-y rounded border border-border bg-surface-0 px-2.5 py-2 text-sm leading-relaxed text-text-primary outline-none focus:border-primary'

export function NormsSection({ form, set, save, dirty }: NormsSectionProps) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className={heading}>{t('settings.normsTitle')}</h2>
        <p className={sub}>{t('settings.normsHint')}</p>
      </div>

      <section className={section}>
        <label className="mb-1.5 block text-xs font-medium text-text-secondary" htmlFor="hz-norms">
          {t('settings.normsLabel')}
        </label>
        <textarea
          id="hz-norms"
          rows={9}
          value={form.creator_norms ?? ''}
          placeholder={t('settings.normsPlaceholder')}
          onChange={(e) => set('creator_norms', e.target.value)}
          className={area}
        />
        <p className="mt-1.5 text-[10px] text-text-disabled">{t('settings.normsFootnote')}</p>
      </section>

      <section className={section}>
        <label
          className="mb-1.5 block text-xs font-medium text-text-secondary"
          htmlFor="hz-standing-plan"
        >
          {t('settings.planLabel')}
        </label>
        <textarea
          id="hz-standing-plan"
          rows={7}
          value={form.standing_plan ?? ''}
          placeholder={t('settings.planPlaceholder')}
          onChange={(e) => set('standing_plan', e.target.value)}
          className={area}
        />
        <p className="mt-1.5 text-[10px] text-text-disabled">{t('settings.planFootnote')}</p>
      </section>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={!dirty}>
          {t('settings.save')}
        </Button>
        <span className="text-xs text-text-disabled">{t('settings.normsSaveHint')}</span>
      </div>
    </div>
  )
}
