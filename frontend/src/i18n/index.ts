import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import en from './en.json'
import zh from './zh.json'

const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('hertz-lang') : null

i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: saved === 'en' || saved === 'zh' ? saved : 'zh',
  fallbackLng: 'zh',
  interpolation: { escapeValue: false },
})

export function setLanguage(lng: 'zh' | 'en'): void {
  localStorage.setItem('hertz-lang', lng)
  void i18n.changeLanguage(lng)
}

/** 工序名翻译（单一真相源 §1.2）：无翻译的 key 回退显示 key 本身，
 * 避免裸 i18n key 与三处重复实现（PlansPage/useStudioExecution 共用）。 */
export function phaseLabel(t: (key: string) => string, key: string): string {
  const name = t(`studio.phaseNames.${key}`)
  return name.startsWith('studio.phaseNames.') ? key : name
}

export default i18n
