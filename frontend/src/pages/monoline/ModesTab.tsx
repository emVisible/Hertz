/** 模式库：28 种呈现模式浏览（数据与缩略 glyph 移植自 monoline）。 */

import { useTranslation } from 'react-i18next'

import { Card } from '../../components/ui'
import { MODE_COUNT, MODE_GROUPS } from './modes'

export function ModesTab() {
  const { t } = useTranslation()
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <p className="text-xs text-text-secondary">
        {t('monoline.modesIntro', { groups: MODE_GROUPS.length, count: MODE_COUNT })}
      </p>
      {MODE_GROUPS.map((g) => (
        <section key={g.id}>
          <h3 className="mb-2 text-sm font-medium text-text-primary">
            {g.zh} <span className="font-mono text-xs text-text-disabled">{g.modes.length}</span>
            <span className="ml-2 text-xs font-normal text-text-secondary">{g.note}</span>
          </h3>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {g.modes.map((m) => (
              <Card key={m.kind} className="flex items-center gap-3">
                <span
                  className="shrink-0 text-text-secondary"
                  // eslint-disable-next-line react/no-danger
                  dangerouslySetInnerHTML={{
                    __html: `<svg viewBox="0 0 48 30" width="72" height="45" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${m.glyph}</svg>`,
                  }}
                />
                <span className="flex min-w-0 flex-col">
                  <b className="text-sm text-text-primary">
                    {m.zh} <i className="font-mono text-[11px] font-normal not-italic text-text-disabled">{m.kind}</i>
                  </b>
                  <span className="truncate text-xs text-text-secondary">{m.desc}</span>
                </span>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
