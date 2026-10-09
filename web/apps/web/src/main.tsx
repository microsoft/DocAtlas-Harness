import { createRoot } from 'react-dom/client'
import '@fontsource-variable/noto-sans-sc'
import { DemoApp } from './DemoApp'
import './styles.css'

const cleanUrl = new URL(window.location.href)
if (cleanUrl.searchParams.has('token')) {
  cleanUrl.searchParams.delete('token')
  window.history.replaceState(null, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash)
}

createRoot(document.getElementById('root')!).render(<DemoApp />)
