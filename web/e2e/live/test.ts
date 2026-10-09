import { test as base } from '@playwright/test'
export * from '@playwright/test'

/** Existing journeys explicitly exercise Chinese; the language suite exercises English-first. */
export const test = base.extend<{ uiLocale: 'en' | 'zh' }>({
  uiLocale: ['zh', { option: true }],
  page: async ({ page, uiLocale }, use) => {
    await page.addInitScript(locale => { if (!localStorage.getItem('docatlas.ui.locale.v1')) localStorage.setItem('docatlas.ui.locale.v1', locale) }, uiLocale)
    await use(page)
  },
})
