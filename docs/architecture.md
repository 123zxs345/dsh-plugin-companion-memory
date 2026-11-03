# DSH 情感陪伴记忆插件

面向情感陪伴，保留用户赋予经历的意义与必要细节，复用已有总结和会话缓存，减少后台整理开销。

模型决定记住、合并、淡化、停止使用以及释放哪些原始细节。插件不使用关键词、情绪分数、出现频次或年龄阈值判断记忆价值。来源有效性、请求容量、任务依赖与事务校验属于执行约束。

## 安装和加载

本包使用 Node.js 24+，当前验证的 Harness 版本是 `0.2.1-rc.2`，Cordis 是 `4.0.5`。安装包随 GitHub Release 提供。

```powershell
npm install https://github.com/123zxs345/dsh-plugin-companion-memory/releases/download/v0.3.2/dsh-plugin-companion-memory-0.3.2.tgz
```

在已经配置模型的 DSH 宿主中，先加载插件，再创建或恢复会话：

```ts
import { resolve } from 'node:path';
import CompanionMemory from 'dsh-plugin-companion-memory';

await root.plugin(CompanionMemory, {
  dataDir: resolve('.dsh-companion-memory'),
  companionId: 'my-companion',
  name: '我的搭子',
  hindsightUrl: 'http://127.0.0.1:8888', // 替换为宿主实际运行的 Hindsight chunks 服务地址
  idleReviewSeconds: 15,
  reviewMaxDelaySeconds: 60,
  candidateBudget: 24,
  minimumSimilarity: 0.55,
  contextTokens: 800,
});
```

这里的 `root` 是宿主已有的 Cordis Context，需要提供 `agents`、`systemPrompt`、`tools` 与 `llm` 服务。使用 Cordis Loader 时，将入口设为 `dsh-plugin-companion-memory`，并传入同样的配置即可。插件跟随宿主模型与凭据，不需要再填写 API Key，也不替换宿主人设。

默认 SQLite 保存记忆。配置 `hindsightUrl` 接入宿主的 Hindsight chunks 语义服务；插件不会下载模型或另启数据库。没有检索服务、没有摘要或没有达标结果时，经历候选为空，不用目录补位。画像仍可用于后台整理，已有内容也保留在 SQLite。外部服务的启动和关闭由宿主管理。

## 三层记忆与逐步展开

原始记忆保存角色、原话与来源；提炼记忆保存意义、必要原话、依据与适用边界；简短总结是模型根据提炼内容生成的一句有区分度的摘要，最长 320 字符。新记忆在同一次阶段 B 中生成提炼层和短总结，无须再调用一次总结模型。

只有简短总结进入 `companion-materials-v2-*` 索引。检索使用实际 semantic cosine 分数，默认 `minimumSimilarity: 0.55`，可按本地嵌入模型调整。无分数、低于阈值的结果不入选；按分数排序去重后最多 `candidateBudget` 条，硬上限 24，可以为 0。相似度只表示本轮问题的相关性，不用于判定长期情感价值或遗忘。

聊天上下文和 `recall_memory` 只返回摘要、记忆编号、修订号与可读层级。模型自行调用 `read_memory({memoryId, revision, level: 'refined'})` 获取提炼内容，或选择 `level: 'raw'` 查看原始来源。原文每页最多 4 个完整来源，通过 `nextOffset` 继续读取，不静默截断原话。已释放的内容明确返回不可用。

后台 B 同样先看摘要候选，再用结构化 `read` 请求局部材料，继续同一原生分支。最多 8 轮读取，每轮最多 8 项、共最多 24 条不同记忆。读取决定可恢复，原文不会另复制进整理日志。完整用户画像是整理背景，独立于额外经历候选。

升级自动迁移到 schema 9，既有记忆先保留空摘要，再由模型按批补齐；不截取旧 meaning 冒充摘要。补齐不改变原来的提炼意义、证据或修订，固定保留的记忆也支持补齐；无变化或失败批次不会自动反复付费。

## 日常行为

- 用户与助手的完整交互先暂存，默认安静 15 秒后整理，持续聊天时从首个完整待整理交互起最多等待 60 秒；正在生成回复时等其结束。普通闲聊允许不形成长期记忆。
- 阶段 A 先读取当前用户画像，再判断是否需要整理及检索方向；阶段 B 维护画像并结合已有理解、新表达与旧总结决定变化。重复讲述没有新增意义时可以保持原总结。
- 使用刚完成的原生会话前缀与工具定义。A 一次提供精简的共同判断规则；仅需 B 时追加操作协议和本批摘要候选，B 继承完整 A，后续读取同样追加。共同规则在一批中仅发送一次，无需 B 的闲聊不支付操作格式的输入成本。服务端缓存是否命中仍由提供商决定。
- 持久化已完成阶段。B 失败后重启可复用 A；预览后重启再应用无需再次调用模型。源资料或相关状态变化时先使旧结果失效。
- 召回先给摘要；模型按需展开意义、重要原话、保留理由、明确或推测、适用与避用情境、淡化状态，插件不按固定权重降权。
- `release_details` 仅释放模型明确列出的来源正文，保留选中的总结与锚点。仍有固定保留、任务或其他记忆依赖时，事务拒绝释放。没有定时按年龄删除的脚本。
- 无新证据的暂缓批次与失败批次不会反复付费；预算恢复后可以继续未完成阶段。

插件提供 `recall_memory` 和 `read_memory` 工具，不禁用宿主其他工具。后台整理只支持受限的本地记忆读取协议，不执行外部动作。

15/60 秒是本地调度目标，并非服务端缓存 TTL。[DeepSeek 官方缓存说明](https://api-docs.deepseek.com/guides/kv_cache/) 表明缓存按 best-effort 维护，没有固定命中保证；插件尽早复用刚完成的原生前缀，实际命中以提供商返回的用量为准。

工作区的 `node scripts/analyze-memory-cache.ts <测试数据目录>` 可离线分析原生记录，按聊天/A/B 输出实际输入、命中、未命中、新增文本字符数，以及明确标注的已有前缀复用估算。估算用上一次实际输入加输出作分母，并非提供商精确覆盖率；费用以金额账本为准。报告不输出聊天或记忆原文。

## 持续维护的用户画像

画像由模型写下的“对用户的理解”和“相处习惯”组成，与普通经历共享同一套来源、修订、纠正和遗忘机制。它可以包含用户在意的意义、如何感到被关心、当前牵挂与关系边界；不要求填满固定标签，也不把一次心情固化成人格结论。每项保留明确/推测、适用情境和依据。

整理时完整画像始终进入模型上下文，不依赖本轮检索是否命中。模型先考虑新表达对画像的更新，再据此判断经历是否值得保留。新经历也可以超出旧画像、推动画像改变。画像更新复用阶段 B 的同一个计划，没有第三次画像总结调用；没变化的理解不必改写。

`candidateBudget` 限制额外送入的经历候选；画像不占用这些名额。完整请求仍须通过宿主金额预算。如果画像逐渐冗长，由模型合并有相同意义的理解；插件不会用固定分数截掉某些画像项。

画像投影有稳定的内容版本，读取和检索记账不会改写版本。更正、停止使用或删除对应来源后，下一次读取立即反映当前有效内容，不留下第二份过期画像。`/user-profile` 子路径导出 `readCompanionUserProfile(store, companionId)` 及其类型。

## 接入宿主金额预算

原生请求通过宿主 `llm/stream` 调用链。宿主若在更外层实施人民币预算，用程序化入口接入相同的预算检查与结算：

```ts
import { createCompanionMemoryPlugin } from 'dsh-plugin-companion-memory';

await root.plugin(createCompanionMemoryPlugin({
  dataDir: resolve('.dsh-companion-memory'),
  companionId: 'my-companion',
  runModel: (request, next) => existingBudget.run(request, next),
  isBudgetError: error => error?.code === 'MONEY_BUDGET_EXCEEDED',
}));
```

`existingBudget.run` 表示宿主提供的请求前预留、请求后结算适配器；根据宿主实际接口实现此函数。插件不会自行声称宿主已有金额上限，也不会另起一个绕过宿主预算的 API 客户端。具体金额上限由各宿主自行配置。

原生 DSH token-meter 主要统计 Agent 会话落盘的模型回复；本插件的有界后台整理通过 `llm/stream` 发出，不会自动成为该界面的会话用量。需要统一显示与金额限制时，必须接入上述宿主账本适配器。

## 控制接口与作用范围

加载后可通过 `root.companionMemory`，或程序化选项 `onReady(controller)` 获得控制器：

```ts
await root.companionMemory.reviewNow('preview');
await root.companionMemory.applyPreview();
const status = root.companionMemory.snapshot();
const profile = root.companionMemory.userProfile(); // { revision, entries }
```

`idleReviewSeconds: 0` 停止自动调度，保留手动整理；`maintenanceMode: 'off'` 暂停整理。`contextTokens` 限制聊天记忆上下文，`candidateBudget` 限制整理的额外经历候选，均不代表记忆重要性阈值。

默认用于单一主人的宿主作用域。多用户宿主应在各自隔离作用域安装，使用独立 `companionId` 和数据目录；程序化选项 `ownerScope` 可限定关联的 Agent 范围。

在当前 `0.2.1-rc.2` 中，宿主创建受限作用域 Agent 时还需在 `setup` 中调用官方 `bindScopeParent(agent, owner)`；仅从某个 Context 调用 `agents.create` 不会自动建立该父作用域关系。

`forget(eventIds)` 清除对应记忆来源及派生记忆，撤销待用整理与检索上下文，并尝试清理索引。结果明确返回 `hostHistoryErased: false`：宿主原始会话、微信/QQ平台记录和备份由各自的保留策略管理。详情释放同样只处理插件的记忆来源，不代替宿主历史清理。

卸载会取消并等待插件自己的后台请求、解除监听，再关闭插件拥有的 SQLite 连接。传入的外部 store 不由插件关闭。

## 从源码构建

```powershell
npm ci
npm run check
npm run build
npm pack
```

产物包含编译后的插件、类型声明和许可证，不包含桌面应用、用户数据或密钥。
