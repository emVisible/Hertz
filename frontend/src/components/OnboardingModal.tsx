import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { Button, Icon, Modal } from './ui'

const ONBOARD_KEY = 'hertz.onboarded.v1'

/** 首次运行欢迎（v0.4 E6）：三步引导——配置 AI / 建计划 / 打开流水线；可跳过。 */
export function OnboardingModal({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [step, setStep] = useState(0)

  useEffect(() => {
    if (localStorage.getItem(ONBOARD_KEY)) onDone()
  }, [onDone])

  const steps = [
    {
      icon: 'studio' as const,
      title: t('onboarding.ai'),
      desc: t('onboarding.aiDesc'),
      action: () => navigate('/config?section=ai'),
    },
    {
      icon: 'plans' as const,
      title: t('onboarding.plan'),
      desc: t('onboarding.planDesc'),
      action: () => navigate('/plans'),
    },
    {
      icon: 'console' as const,
      title: t('onboarding.pipeline'),
      desc: t('onboarding.pipelineDesc'),
      action: () => navigate('/execution?mode=pipeline'),
    },
  ]

  function finish() {
    localStorage.setItem(ONBOARD_KEY, '1')
    onDone()
  }

  const current = steps[step]

  return (
    <Modal open onClose={finish} width={460} title={t('onboarding.title')}>
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-surface-2 text-primary shadow-sm">
          <Icon name={current.icon} size={26} />
        </span>
        <p className="text-sm font-semibold text-text-primary">{current.title}</p>
        <p className="max-w-sm text-xs leading-relaxed text-text-secondary">{current.desc}</p>
        <div className="mt-2 flex items-center gap-1.5">
          {steps.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${i === step ? 'w-5 bg-primary' : 'w-1.5 bg-surface-2'}`}
            />
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between">
        <Button size="sm" variant="ghost" onClick={finish}>
          {t('onboarding.skip')}
        </Button>
        {step < steps.length - 1 ? (
          <Button size="sm" onClick={() => setStep((s) => s + 1)}>
            {t('onboarding.next')}
          </Button>
        ) : (
          <Button size="sm" onClick={() => current.action()}>
            <Icon name="check" size={13} />
            {t('onboarding.start')}
          </Button>
        )}
      </div>
    </Modal>
  )
}
