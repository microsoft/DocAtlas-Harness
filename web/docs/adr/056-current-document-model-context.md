# ADR-056：让模型知道当前问题已经附带文档

状态：接受，2026-09-10，修复用户上传后自然提问仍被要求上传的问题。

实际检查发现：上传记录为ready，用户“能看到论文吗 / 总结全文”的提交和prepared记录均已含明确sourceRefs，但无选区时DocumentSession只把原问题交给模型，没有提供当前附件上下文。原真实模型smoke又在问题里指定工具名与页码，未覆盖自然问法。

修复在DocAtlas Core的DocumentSession准备阶段完成：只根据已验证scope附加当前文档数量及精确documentId/revisionId，说明文件可由DocAtlas工具访问，不在原生工具目录里。保留用户原话、选区文本及原请求hash；UI历史继续使用原提交映射，不把附加说明显示成用户输入。

- 文档相关问题先核对sources再Read；全文摘要优先sequential并沿nextCursor读取，明确不完整覆盖，不把tree nodeId当作blockId。
- 附件元数据不是Evidence。引用沿用既有Read Locator→checkpoint→Answer规则，不凭上下文生成证据。
- 准备文本不授予访问权；只有原来的onConsumed才能激活scope，切换/撤销/无资料帧逻辑不变。无sourceRefs的原生任务原文不改。
- 不更换模型、Agent Loop、Pi原生工具、provider路由或持久协议。只完善当前文档上下文与已有Read/Tree的工具描述。
- 验收加入自然问题“总结全文”的真实Azure测试，不在用户问题中指定工具。合成PDF之外的语料质量不因此自动通过。

UI采用一个输入面：附件标签在框内上方，添加/已有资料在底部左侧，发送在右侧；保留拖入、当前来源选择与按需原始PDF。采用实际浏览器位置断言，不只验证按钮存在。

参考（本轮实际打开核对）：

- [OpenAI Function calling](https://developers.openai.com/api/docs/guides/function-calling)：提供明确工具用途与何时使用的指引，不能只依赖工具注册。
- [Claude 文件上传](https://support.claude.com/en/articles/8241126-uploading-files-to-claude)：在聊天中附加文件及拖入；不照搬其容量限制。
- [Gemini Notebook chat](https://support.google.com/gemininotebook/answer/16179559?hl=en)：来源选择与点击引用回到上下文。

OpenAI公开搜索未确认Azure GPT-5.6 Luna部署名的特定行为；保留原endpoint/model，以实际调用验证，不宣称迁移或更换模型。
