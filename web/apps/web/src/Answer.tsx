import { CITATIONS, type ChatMessage, type QuoteContext, type ReadingStyle } from './demo-state'
import { CitationButton } from './CitationButton'
import { Icon } from './icons'

const quarters = [
  { quarter: 'Q1', revenue: '12.3', growth: '+4%' },
  { quarter: 'Q2', revenue: '13.1', growth: '+7%' },
  { quarter: 'Q3', revenue: '14.0', growth: '+7%' },
  { quarter: 'Q4', revenue: '15.2', growth: '+9%' },
]

export function answerText(message: ChatMessage): string {
  if (message.answer === 'revenue') return '示例回答：2025 年各季度营收分别为 12.3、13.1、14.0、15.2 百万美元。Q4 相对 Q1 提升约 23.6%（演示计算：15.2 / 12.3 - 1）。报告的 Growth 列没有标明同比或环比口径。来源：示例 PDF 第 2 页。'
  if (message.answer === 'risk') return '示例回答：报告预计 2026 年继续增长，但提到供应波动和竞争性定价压力。计划在 Q1 推出 Widget Pro。来源：示例 PDF 第 5、6 页。'
  if (message.answer === 'selection') return `演示选区上下文（第 ${message.context?.page} 页）：${message.context?.quote ?? ''}`
  return '示例回答：Q4 营收为 15.2 百万美元；西部地区同比增长最快；2026 年需关注供应波动与竞争性定价压力。来源：示例 PDF 第 2、3、6 页。'
}

export function Answer({ message, style, onOpen, onOpenDocument }: {
  message: ChatMessage, style: ReadingStyle, onOpen: (context: QuoteContext) => void, onOpenDocument: (id: string) => void,
}) {
  const cite = (key: string) => <CitationButton citation={CITATIONS[key]!} onOpen={onOpen} />
  if (message.answer === 'cancelled') return <p className="cancelled-answer"><Icon name="stop" size={15} />已停止演示。你可以修改问题后继续。</p>
  if (message.answer === 'local') return <div className="answer-body"><p>这份 PDF 已在你的浏览器中打开，文件没有上传到服务器。</p><p>当前原型尚未连接模型，因此暂不生成它的全文摘要。你可以先选中原文中的一段，体验“带着选区追问”。</p><button className="text-action" onClick={() => message.sourceId && onOpenDocument(message.sourceId)}><Icon name="book" size={16} />打开这份 PDF<Icon name="chevron" size={14} /></button></div>
  if (message.answer === 'unsupported') return <div className="answer-body"><p>当前是交互原型，可演示示例报告的摘要、营收变化和风险分析。</p><p>请选择示例资料，或打开自己的 PDF 体验阅读与选区。其他问题需要接入 Agent 后才能回答。</p></div>
  if (message.answer === 'selection' && message.context) return <div className="answer-body">
    <p>这段原文已经和你的问题一起带入对话。</p>
    <blockquote className="selected-excerpt">{message.context.quote}</blockquote>
    <p>这里先演示上下文的绑定方式。接入 Agent 后，就能围绕这个确切的片段进行解释、比较和核验。</p>
    <button className="text-action" onClick={() => message.context && onOpen(message.context)}><Icon name="link" size={15} />回到所选原文 · 第 {message.context.page} 页<Icon name="chevron" size={14} /></button>
  </div>
  if (message.answer === 'revenue') return <div className="answer-body">
    <p className="answer-lead">营收逐季提升，第四季度达到 <strong>1,520 万美元</strong>。{cite('revenue')}</p>
    <div className="revenue-table-wrap"><table className="revenue-table"><caption>2025 年季度营收 · 单位：百万美元</caption><thead><tr><th scope="col">季度</th><th scope="col">营收</th><th scope="col">报告列示增长率</th></tr></thead>
      <tbody>{quarters.map(row => <tr key={row.quarter}><th scope="row">{row.quarter}</th><td><span className="table-bar" style={{ width: `${Number(row.revenue) / 15.2 * 88}%` }} /><span>{row.revenue}</span></td><td>{row.growth}</td></tr>)}</tbody></table></div>
    <p>从 Q1 的 1,230 万美元到 Q4 的 1,520 万美元，首尾两季相差约 <strong>23.6%</strong>。{cite('quarters')}</p>
    <details className="calculation"><summary>查看演示计算</summary><code>(15.2 ÷ 12.3 − 1) × 100 ≈ 23.6%</code><p>这是基于原表数字的计算，不是 PDF 中直接给出的结论；未运行 Pi 或 Python。</p></details>
    <div className="answer-caution"><Icon name="info" size={17} /><p><strong>还有一个口径需要核验</strong>原表的 Growth 列没有明确说明同比还是环比，不能直接把它当作其中一种。</p></div>
  </div>
  if (message.answer === 'risk') return <div className="answer-body">
    <p className="answer-lead">报告对 2026 年的增长保持预期，同时列出了两项风险。{cite('risk')}</p>
    <div className="answer-points"><section><h3>供应波动</h3><p>原文使用 “supply variability”，但没有进一步量化影响。{cite('risk')}</p></section><section><h3>竞争性定价压力</h3><p>原文提到 “competitive pricing pressure”，需要结合其他资料进一步核验。{cite('risk')}</p></section></div>
    <p>产品计划中，Widget Pro 预计在 Q1 推出；这是规划，不是已经完成的事实。{cite('roadmap')}</p>
  </div>
  return <div className={`answer-body overview-answer ${style === 'guided' ? 'guided-answer' : ''}`}>
    <p className="answer-lead">这份报告可以先抓住三条主线。</p>
    <div className="overview-points">
      <section><span className="point-index">01</span><div><h3>营收稳步上升</h3><p>第四季度营收达到 <strong>1,520 万美元</strong>，是报告列出的四个季度中最高的一季。{cite('revenue')}</p></div></section>
      <section><span className="point-index">02</span><div><h3>区域增长带来新动力</h3><p>西部地区同比增长最快，报告将其归因于新的分销合作伙伴。{cite('region')}</p></div></section>
      <section><span className="point-index">03</span><div><h3>增长预期之外，也要看风险</h3><p>报告预计 2026 年继续增长，同时提醒关注供应波动和竞争性定价压力。{cite('risk')}</p></div></section>
    </div>
    <p className="answer-closing">点击句子旁的数字，可以直接回到原始 PDF 核验。</p>
  </div>
}
