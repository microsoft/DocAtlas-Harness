import { createRoot } from 'react-dom/client'
import { lazy, Suspense } from 'react'
import '@fontsource-variable/noto-sans-sc'
import '@fontsource-variable/dm-sans'
import '@fontsource-variable/newsreader'
import '../styles.css'
import { UiLocaleProvider } from './locale'
import { BootBoundary, BootShell } from './BootShell'

const LiveApp = lazy(async () => ({ default: (await import('./LiveApp')).LiveApp }))

document.documentElement.dataset.docatlasUi = 'live'

createRoot(document.getElementById('root')!).render(<UiLocaleProvider><BootBoundary><Suspense fallback={<BootShell />}><LiveApp /></Suspense></BootBoundary></UiLocaleProvider>)
