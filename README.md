# DSH 情感陪伴记忆插件

**遗忘本身不是问题。重要的是，从经历里提炼出这个人真正会记住的东西。**

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的选择性记忆插件，项目名 `dsh-plugin-companion-memory`。

## 为什么做这个插件

记忆插件有个两难：忘得太多，会丢掉用户认真说过、希望被记住的细节；可把每次闲聊都带进下一轮对话，上下文迟早装不下。压缩、检索、分层让记忆更容易存下和找回。对情感陪伴，我们还想追问一句：存下来的，真的是这个人在意的吗？

后来我们想，人不也会忘吗？你未必记得上周每顿饭吃了什么，却可能一直记得那晚加班回家，家人给你留了一碗面。值得留下的，可能是被惦记的感受，以及这段经历对你的意义。

所以，我们把问题从“怎样少忘一点”推进到“怎样提炼重要信息”：让模型在相处中主动学习、持续修正用户画像，理解你看重什么、希望怎样被对待、哪些经历会被你自己记住。再结合这份理解，判断记忆的保留、提炼、合并与修正。重要性由模型结合这个人与当时的情境判断，用户当下的表达优先。

这就是 DSH 情感陪伴记忆插件（dsh-plugin-companion-memory）的出发点。原始记忆保留原话与来源，提炼记忆留下意义和适用情境，简短总结用于检索；相关性达标才进入候选，最多24条，由模型按需展开更深的内容。

陪伴也需要负担得起。插件复用刚结束的原生会话前缀、已有总结和阶段结果，减少重复整理的开销，让新的经历继续修正对你的理解。

我们希望让大肥鱼记住你在意的事，让下一次聊天能接着上一次的相处。这里不按内容类型、关键词、情绪分数或固定遗忘天数筛选记忆；取舍由模型结合画像和经历的意义判断。

[观看介绍视频](https://www.bilibili.com/video/BV1G1436xEp4/) · [GitHub 源码与下载](https://github.com/123zxs345/dsh-plugin-companion-memory) · 喜欢这个想法，欢迎点颗 Star。

**Companion Memory for DeepSeek Harness:** understand the person, distill what matters, and keep the relationship continuous through an evolving user profile, selective layered memory and native conversation-prefix reuse.

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

### npm 安装（推荐）

在常用的 `web` profile 中执行：

```sh
dsh plugin --profile web add dsh-plugin-companion-memory
```

首次 npm 发行版为 **0.3.3**。安装后重启 `dsh web`。也可以在支持 npm 插件的市场中搜索 `dsh-plugin-companion-memory`；各市场的收录由其维护者和同步流程决定。

[npm 包与版本](https://www.npmjs.com/package/dsh-plugin-companion-memory) · [GitHub 源码](https://github.com/123zxs345/dsh-plugin-companion-memory)

### GitHub 安装（0.3.2）

原有 GitHub Release 和固定 Git 版本仍可使用：

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
