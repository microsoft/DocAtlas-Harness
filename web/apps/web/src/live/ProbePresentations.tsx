import type { AnswerManifest, AnswerManifestWarning, CitationPresentation } from '@docatlas/contracts'
import { LiveAnswerBody } from './Answers'
import { probePresentations, type ProbePresentation, type ProbeVariantInput } from './probe-state'
import './probe.css'

const relationNames = { support: '支持', refute: '反驳', qualify: '限定' }
const warningNames: Record<AnswerManifestWarning, string> = {
  'unclassified-text': '含尚未分类的文本', 'unknown-locator': '含无法识别的出处', 'malformed-marker': '含格式不完整的引用标记',
  'scope-conflict': '存在来源范围冲突', 'locator-without-text': '部分出处没有已读取的文字', 'limit-exceeded': '原回答映射触及上限，不能视为资料完备',
}

/** Pure controlled comparison. No provider call, local randomization, preference mutation or hidden recording. */
export function ProbePresentations({ manifest, variants, presentationOrder, busy, onCitation }: {
  manifest: AnswerManifest, variants: readonly ProbeVariantInput[], presentationOrder: readonly string[], busy: boolean, onCitation(citation: CitationPresentation): void,
}) {
  const pair = probePresentations(manifest, variants, presentationOrder)
  return <div className="probe-presentations" role="group" aria-label="同一已保存回答的两种呈现">{pair.map(presentation => <ProbePresentationCard key={presentation.variantKey} presentation={presentation} busy={busy} onCitation={onCitation} />)}</div>
}

export function ProbePresentationCard({ presentation, busy, onCitation }: { presentation: ProbePresentation, busy: boolean, onCitation(citation: CitationPresentation): void }) {
  const { manifest } = presentation
  return <article className="probe-presentation" aria-label={`呈现 ${presentation.position}`} data-probe-position={presentation.position} data-probe-variant={presentation.variantKey} data-probe-manifest={manifest.manifestId}>
    <h3 className="probe-position">呈现 {presentation.position}</h3>
    <div className="probe-sections">{presentation.sections.map(section => section === 'answer'
      ? <section key="answer" className="probe-section" aria-label={`呈现 ${presentation.position} 的已保存回答`} data-probe-section="answer"><h4>已保存回答</h4><LiveAnswerBody manifest={manifest} busy={busy} onCitation={onCitation} /></section>
      : <section key="evidence" className="probe-section" aria-label={`呈现 ${presentation.position} 的完整证据集合`} data-probe-section="evidence"><h4>完整证据集合</h4><ProbeEvidenceCollection citations={manifest.citations} busy={busy} onCitation={onCitation} /><ProbeUncertainty manifest={manifest} /></section>)}</div>
  </article>
}

export function ProbeEvidenceCollection({ citations, busy, onCitation }: { citations: readonly CitationPresentation[], busy: boolean, onCitation(citation: CitationPresentation): void }) {
  return <div className="probe-evidence-collection"><p className="probe-muted">保留本回答的全部支持、反驳、限定和未核验定位线索；这些关系是 Agent 的判断，不代表事实已核验。</p>
    {!citations.length && <p className="probe-muted">此回答没有保存的出处；不会为比较生成或补写证据。</p>}
    {citations.map(citation => {
      const quote = citation.locator.selectors.find(selector => selector.type === 'text-quote')
      const verified = citation.verificationStatus === 'read-verified' && citation.evidence !== undefined
      return <article className="probe-evidence" key={citation.citationId} data-probe-citation={citation.citationId} data-probe-relation={citation.relation} data-probe-verification={citation.verificationStatus}>
        <header><strong>出处 {citation.ordinal} · {relationNames[citation.relation]}</strong><span>第 {citation.locator.physicalPage} 页</span></header>
        <p className="probe-evidence-text">{verified ? citation.evidence!.content.text : quote?.type === 'text-quote' ? quote.exact : '没有已读取的原文文字。'}</p>
        <small>文档 {citation.locator.documentId}<br />版本 {citation.locator.revisionId}</small>
        {verified ? <button type="button" className="text-action" disabled={busy} aria-label={`核对完整出处 ${citation.ordinal} · ${relationNames[citation.relation]} · 原始 PDF`} onClick={() => onCitation(citation)}>核对原始 PDF</button>
          : <p className="probe-weak">仅定位线索 · 尚未通过真实 Read 核验，不能当作已验证证据；不启用原文引用跳转。</p>}
      </article>
    })}
  </div>
}

export function ProbeUncertainty({ manifest }: { manifest: AnswerManifest }) {
  const summary = manifest.verificationSummary
  return <aside className="probe-uncertainty" aria-label="此回答的核验边界" data-probe-verification-summary={manifest.manifestId}>
    <p>事实段落 {summary.factualSegments} · 已映射 {summary.mappedFactualSegments} · 有支持 {summary.supportedSegments} · 有限定 {summary.qualifiedSegments} · 存在争议 {summary.contestedSegments} · 未解决 {summary.unresolvedSegments} · 未分类 {summary.unclassifiedSegments} · 出处 {summary.citationCount}</p>
    <p>{summary.complete ? '这份回答的出处映射完整；不代表语义结论或外部资料已穷尽核验。' : '这份回答的出处映射不完整；未解决、冲突和不确定内容原样保留。'}</p>
    {!!summary.warnings.length && <ul>{summary.warnings.map(warning => <li key={warning} data-probe-warning={warning}>{warningNames[warning]}</li>)}</ul>}
  </aside>
}
