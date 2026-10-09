import { Component, type ReactNode } from 'react'
import { useUi } from './locale'

export function BootShell() {
  const { t } = useUi()
  return <div className="boot-shell"><header>DocAtlas</header><main aria-busy="true"><div className="boot-copy" role="status">{t('Opening your workspace…', '正在打开工作区…')}</div><div className="boot-input" aria-hidden="true"><i /><i /><span /></div></main></div>
}
export class BootBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <div className="boot-shell"><header>DocAtlas</header><main><p role="alert">Unable to load the interface. / 界面未能加载。</p><button onClick={() => location.reload()}>Reload / 重新加载</button></main></div> : this.props.children }
}
