# DSH 情感陪伴记忆插件

**人也记不住每次闲聊。重要的是，理解什么对这个人值得记住。**

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的选择性记忆插件。模型主动维护用户画像，思考用户在意什么、哪些片段会被用户自己记住、哪些经历承载情感联系，再决定记忆的保留、提炼、合并与修正。

同样是一碗面，普通外卖可能只是当天的细节，家人特意留的面却可能承载被惦记的感受。重要性来自这个人与这段经历的意义，不按内容类型、关键词、情绪分数或固定遗忘天数筛选。

**Companion Memory for DeepSeek Harness:** model-guided selective memory, an evolving user profile, three-layer progressive disclosure, and native conversation-prefix reuse for emotional companionship.

## 设计

| 机制 | 做什么 |
| --- | --- |
| 主动维护用户画像 | 新经历补充或修正对用户的理解；完整画像始终参与后台取舍，不靠本轮检索碰运气。 |
| 原始记忆 → 提炼记忆 → 简短总结 | 保留原话与来源，提炼意义和情境，用短总结作为检索入口。 |
| 相关才入选 | 只比较简短总结的语义相似度，达标才进入候选，最多24条，可以是0条，不硬凑。 |
| 渐进披露 | 模型自己决定看提炼内容，还是进一步核对原始来源。 |
| 缓存与总结复用 | 尽早复用刚完成的原生会话前缀，沿用已有总结，阶段成功结果可恢复，减少重复整理。 |
| 理解可以改变 | 今天想听建议，就按今天的需要回应；画像帮助理解，不把用户定型。 |

缓存是否实际命中由模型提供商决定，插件不承诺固定命中率。相似度只用于本轮相关性，不用来判断长期情感价值。

## 安装

已验证环境：**Node.js 24+、DeepSeek Harness 0.2.1-rc.2、Cordis 4.0.5**。先在宿主中配置好模型与凭据，插件复用宿主，不需要再填写模型 API Key。

在常用的 `web` profile 中安装发布包：

```sh
dsh plugin --profile web add https://github.com/123zxs345/dsh-plugin-companion-memory/releases/download/v0.3.2/dsh-plugin-companion-memory-0.3.2.tgz
```

也可以从固定版本的 Git 仓库安装：

```sh
dsh plugin --profile web add "git+https://github.com/123zxs345/dsh-plugin-companion-memory.git#v0.3.2"
```

重启 `dsh web`。组合包会在当前 profile 下加载 `companion-memory`，数据保存在该 profile 的 `companion-memory/` 目录。Git 仓库包含可安装的编译结果，使用者无需先构建源码。

使用 DSH 的「自定义插件索引」时，可以在「发现 → 添加索引源」填入：

```text
https://raw.githubusercontent.com/123zxs345/dsh-plugin-companion-memory/main/market/index.json
```

语义召回使用宿主已有的 [Hindsight](https://github.com/vectorize-io/hindsight) chunks 服务。在当前 profile 的 `cordis.patch.yml` 配置它的地址：

```yaml
- id: companion-memory
  config:
    dataDir: !!js "ctx.get('profileContext').dir + '/companion-memory'"
    companionId: default
    idleReviewSeconds: 15
    reviewMaxDelaySeconds: 60
    candidateBudget: 24
    minimumSimilarity: 0.55
    contextTokens: 800
    hindsightUrl: http://127.0.0.1:8888
```

将地址替换为你的实际服务。profile 补丁会替换整个 `config`，请保留数据目录及已有自定义配置。未配置检索服务时，本地SQLite与后台画像维护仍然保留，额外经历候选为空，不用无关内容补位。插件不会自动下载嵌入模型或另起数据库；外部服务由宿主管理。

默认用于一个主人的 profile。多用户部署请使用隔离的作用域、独立 `companionId` 和数据目录。

## 使用示例

以下为虚构示意：

> 用户：以后我说累了，先听我吐槽两句，别急着给建议。

模型可以将它提炼成：疲惫时希望先被倾听，并保留适用情境与原话依据。另一天出现“今天我想听听你的办法”时，当前表达优先，也可以修正已有理解。

默认安静15秒后尝试整理；持续聊天时，从首个完整待整理交互起最多等待60秒，生成回复期间会等待其结束。普通闲聊可以不形成长期记忆。上述时间是本地调度目标，不是提供商缓存TTL。

插件给宿主模型提供 `recall_memory` 与 `read_memory`，聊天先看到摘要；需要时再展开意义或原话。后台模型决定记忆变化，执行层只检查来源、容量、依赖和事务一致性。

## 程序化接入

在创建或恢复宿主 Agent 之前加载：

```ts
import { resolve } from 'node:path';
import CompanionMemory from 'dsh-plugin-companion-memory';

await root.plugin(CompanionMemory, {
  dataDir: resolve('.dsh-companion-memory'),
  companionId: 'my-companion',
  hindsightUrl: 'http://127.0.0.1:8888',
  candidateBudget: 24,
  minimumSimilarity: 0.55,
});
```

`root` 是已有的Cordis Context，需提供 `agents`、`systemPrompt`、`tools`、`llm` 服务。插件不替换宿主人设。使用 `createCompanionMemoryPlugin({ runModel, isBudgetError })` 可接入宿主的人民币预算与结算。

加载后通过 `root.companionMemory.reviewNow('preview')` 预览整理计划，通过 `applyPreview()` 应用；`userProfile()` 读取当前画像。设置 `idleReviewSeconds: 0` 可关闭自动调度，保留手动整理。

完整架构、三层披露、画像修正、遗忘与详情释放、预算适配、作用域及控制器接口见[技术说明](https://github.com/123zxs345/dsh-plugin-companion-memory/blob/main/docs/architecture.md)。

## 数据与卸载

记忆存入本地SQLite。模型整理会使用宿主的模型服务；启用Hindsight时，短总结也会送到你配置的检索服务。插件不额外保存宿主API密钥。删除插件记忆不等于删除宿主原始聊天或微信、QQ平台记录。

```sh
dsh plugin --profile web remove dsh-plugin-companion-memory
```

卸载后重启宿主。数据目录保留，是否删除由你决定。

## 从源码构建

在这个独立仓库的根目录执行：

```sh
npm ci
npm run check
npm run build
npm pack
```

测试使用虚构资料和宿主模型桩，不调用付费模型API。源码、类型声明与编译结果均开放。问题和改进建议请提交到[Issues](https://github.com/123zxs345/dsh-plugin-companion-memory/issues)。

## 许可

[MIT](./LICENSE)。依赖及用途见[第三方声明](./THIRD_PARTY_NOTICES.md)。
