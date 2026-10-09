import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { englishUiNotices } from './ui-notices'

export type UiLocale = 'en' | 'zh'
export const UI_LOCALE_KEY = 'docatlas.ui.locale.v1'
// The standalone legacy prototype is Chinese; the live product always mounts
// UiLocaleProvider below, whose first-visit default is explicitly English.
const Context = createContext<{ locale: UiLocale, setLocale(locale: UiLocale): void }>({ locale: 'zh', setLocale() {} })
export function initialUiLocale(storage?: Pick<Storage, 'getItem'>): UiLocale {
  try { return storage?.getItem(UI_LOCALE_KEY) === 'zh' ? 'zh' : 'en' } catch { return 'en' }
}
export function UiLocaleProvider({ children, initialLocale }: { children: ReactNode, initialLocale?: UiLocale }) {
  const [locale, setLocale] = useState<UiLocale>(() => { if (initialLocale) return initialLocale; try { return initialUiLocale(window.localStorage) } catch { return 'en' } })
  useEffect(() => {
    document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN'
    document.title = locale === 'en' ? 'DocAtlas — Read. Understand. Explore.' : 'DocAtlas · 阅读与理解'
    try { window.localStorage.setItem(UI_LOCALE_KEY, locale) } catch { /* Storage can be blocked; this tab still switches. */ }
  }, [locale])
  return <Context.Provider value={{ locale, setLocale }}>{children}</Context.Provider>
}
export function useUi() {
  const context = useContext(Context)
  return { ...context, t: (en: string, zh: string): string => context.locale === 'en' ? en : zh,
    notice: (text: string): string => context.locale === 'en' ? englishUiNotices[text] ?? text : text }
}
export function LocaleSwitch() {
  const { locale, setLocale } = useUi()
  return <div className="ui-locale-switch" role="group" aria-label="Interface language / 界面语言">
    <button type="button" lang="en" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}>EN</button>
    <button type="button" lang="zh-CN" aria-pressed={locale === 'zh'} onClick={() => setLocale('zh')}>中文</button>
  </div>
}
export function UiText({ en, zh }: { en: string, zh: string }) { return <>{useUi().t(en, zh)}</> }
