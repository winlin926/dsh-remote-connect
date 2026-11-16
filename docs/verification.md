# 验证与清理依据

当前候选：**0.6.0**；验证日期：**2026-11-16**；DSH **0.2.2-rc.3**，Node.js **24.22.0**，Windows。

## 版本与记录核对

GitHub Release 与 npm 的最新公开版本均为 `0.5.0`，不存在已发布的 `0.6.x` 或远端 `v0.6.x` 标签。GitHub `main` 已包含开发候选代码，源码提交与正式发行是两件事。

| 开发提交 | 当时写入的候选号 | 内容 |
| --- | --- | --- |
| `ae8110e` | 0.6.0 | 公网节点、自托管服务、统一发现 |
| `a488dc7` | 0.6.1 | 删除节点时撤销主机注册 |
| `272f1cc` | 0.6.2 | v2 节点身份、多主机共享节点 |
| `1445524`、`a882f7f`、`ed7d9ae` | 0.6.3 | 插件更新卡片、未接入传输栈清理 |

这些提交的功能全部纳入当前 `0.6.0`，不回退到 `ae8110e`。对外版本、包内版本、服务端版本与标签统一；不重写已推送历史。后续按 [发布约定](releasing.md) 区分开发构建和正式发行。

GitHub API 返回本仓库没有 PR，不能以不存在的 PR 证明删除安全。使用 Git 提交、实际调用关系、现有项目记录和本机缓存测量交叉核对；Issue #1 要求明确“访问已有宿主”，README 保留该说明。清理前 `98c3004` 的 Windows/Linux CI 成功，本轮修改后的远端 CI 尚未执行。

当前授权工具未提供 Slack 或 Statsig 读取接口，也没有接入生产 APM；没有把它们当作已核查证据。下面的无调用结论限定于本仓库，不能推断所有外部旧客户端都已停用。

## 已删除或简化的候选项

| 项目 | 依据与处理 |
| --- | --- |
| `src/public-node.ts` 的 `createHash` 导入 | TypeScript `noUnusedLocals` 报错；摘要计算已有 `identityOfPublicKey`，删除闲置导入。 |
| `PUBLIC_NODE_PROTOCOLS`、`PUBLIC_NODE_KINDS` | 全仓无读取；有效校验由 `isPublicNodeProtocol`、`isPublicNodeKind` 实际执行，删除两份闲置列表。 |
| `cacheScope`、`CacheScopeInput`、`CacheScope`、`REVISION_PATTERN` | `fb4f921` 引入后只被两个单元测试调用，运行入口没有引用；删除函数、类型、专用常量和这两个测试，修正文档中的虚构调用。保留真实网关缓存头、资源路径分区和服务端隔离测试。 |
| `PublicNodeConfig.record()` | TypeScript 报未使用私有方法；节点增删改已有各自有效校验，删除闲置方法。 |
| `service-node.ts` 的 `NodesFile` | TypeScript 报未使用类型；持久化实际经过 `readNodes`/`writeNodes`，删除重复类型。 |
| `Gateway.cookieHeader()` 的 `req` 参数 | TypeScript 报参数未使用；安全性由调用方算好的 `secure` 参数决定，同步删除两处调用参数，Cookie 行为保留。 |
| `hosts.ts` 的 `RouteContext` 导入 | TypeScript 报未使用；`Router` 和其他路由使用的 `RouteContext` 保留。 |
| `constantTimeHexEqual()` | 全仓无调用；鉴权仍使用实际被调用的 `constantTimeStringEqual()` 和 `timingSafeEqual`，只删除闲置实现。 |
| `nullLogger` | 全仓没有引用，连现有测试也不使用；生产 `createLogger()` 与脱敏逻辑保留。 |
| `contract.ts` 的 `NodePublicIdentity`、`NodeIdentityRecord`、`HostRegistration`、`PairingClient`、`ClaimPairing` | 五个推导类型无引用；保留所有实际运行的 zod schema 与解析校验。 |
| `NODE_TO_HOST_FRAME_TYPES` | 全仓无读取；删除闲置列表，保留服务端实际用于校验的 `HOST_TO_NODE_FRAME_TYPES` 和两端帧处理。 |
| `TUNNEL_PROTOCOL_VERSION` | 只有服务端测试使用，还被误填到字符串类型的软件 `hello.version`；改用测试软件版本字符串，删除无运行用途的常量。 |
| 测试环境的 `HELLO_TIMEOUT_MS` | `loadConfig()` 不读取该变量；实际超时来自共享隧道常量，删除没有效果的测试设置。 |
| `src/remote/vendor/README.md`、`LICENSE` 与根目录 `THIRD-PARTY-LICENSES.md` | `a882f7f` 已删除全部对应协议、加密和 WebRTC 源码，仅留下孤立说明；现用隧道协议在 `dc9a920` 独立新增。删除三份失去对应代码的文件及打包条目，原项目 MIT `LICENSE` 保留。 |
| 五份 `agentworkrecords/*.md` | 内容覆盖旧包名、临时隧道、旧界面与过时验收数字；没有运行或发布调用，现行说明已在 README 与 docs。删除后仍可从 Git 历史追溯。 |
| `docs/research.md` | 固定要求 `protocol === 1`，与现行 v1/v2 检测矛盾；其余边界已在 README、`public-node.md` 与 `self-host.md`，删除重复旧文档。 |
| 旧 `docs/verification.md` 内容 | 混有多轮候选包哈希、本机绝对路径、真实主机标识与过时安装状态；由本页当前证据和明确边界直接替换，发现文档示例改用公开测试公钥。 |
| `remote-server/.dockerignore` | Compose 构建上下文为仓库根目录，旧忽略文件不在生效位置。替换成根目录白名单，仅允许服务端源码、构建清单、网页和共享隧道协议；Dockerfile 同步只复制这一份共享协议。 |
| 服务端旧构建产物 | `tsc` 不清理已删除模块的输出；服务端 build 先清空自己的 `dist/` 再编译，防止退役控制面进入镜像。 |
| 验收脚本的 `dist/main.js` 候选回退 | `tsconfig.json` 固定输出 `dist/remote-server/src/main.js`；删除永远不应命中的旧布局回退。 |
| 浏览器验收的 `Network.clearBrowserCache` | 影响共享浏览器 profile，不是当前页面。删除该调用；本轮隔离网关首次访问实传资源，重访与重开命中缓存，证明验收不依赖全局清理。 |
| `.gitignore` 中 `lib/types` 子规则 | 已被 `lib/` 完整覆盖；删除重复规则，显式排除 `.agents/`、真实环境文件、日志与覆盖率产物。 |

## 保留依据

- `src/` 的有效模块、直接依赖均有运行调用；自托管节点、证书、设备存储、重试与流式转发属于现行功能。
- v1 节点识别、旧配置迁移和 `verificationCode` 线协议字段有兼容用途。缺少外部使用遥测，不删除这些可能影响现有设备的路径。
- `patches/` 的第三方手机布局补丁在 `d8d8865`/`9e4bbb3` 的历史修复和项目记录中有复现依据；没有证据证明对应上游版本已不再使用，保留并标明适用版本。
- README 截图均有展示或市场清单引用；两份锁文件分别服务 pnpm 插件与独立 npm 服务端，不能合并或当作重复文件删除。
- 测试证书与私钥位于 `tests/fixtures/`，用于证书匹配、过期和错误场景；作为公开测试数据保留。当前文件扫描没有发现生产 token，未承诺扫描全部 Git 历史。

## 本轮验证

- 插件：`pnpm typecheck`、`pnpm test`、`pnpm build` 通过；17 个文件 **283** 个测试。较清理前少的两个测试只服务已删除的 `cacheScope`。
- 服务端：`npm run typecheck`、`npm test` 通过；6 个文件 **57** 个测试，覆盖多 Host 隔离、配对、资源缓存、HTTP/SSE/WebSocket、撤销、限流与异常帧。
- 真实服务端进程：`node scripts/verify-node-v2.mjs` 的 **16** 个检查通过，包括 v2 发现、版本 `0.6.0`、公钥摘要、无令牌注册和重启后身份不变。
- 依赖锁：`pnpm install --frozen-lockfile --lockfile-only --ignore-scripts --offline` 通过；服务端 package 与 package-lock 根版本一致。
- 将实际 `.tgz` 离线安装到隔离 DSH profile，再运行 `qa:browser`，**19** 项通过：配对批准、官方应用就绪、桌面和 320/390px 深浅色布局、中文输入、复制回退、旧轮询、预览、撤销、v1/v2 节点标签及插件更新流程。8 张截图生成无警告，人工查看了节点面板与 320px 深色面板。
- 包检查直接读取 tarball，校验包名、版本、依赖与入口 SHA-256；只允许生产 JS、类型、包清单、Cordis patch、README 和 LICENSE。测试、QA、服务端源码、私有运行数据均未进入插件安装包。
- 其余 52 个源码模块均能从插件、客户端、服务端或运维工具的实际入口到达；包检查额外通过 1 份有效清单，并拒绝 7 种私有文件、错误声明、缺失许可、版本不符或路径越界的清单。
- CI 增加服务端类型检查与测试，并在 Linux 上构建镜像；发布流程把同一份实际 `.tgz` 用于 npm 和 GitHub Release。

本轮浏览器的插件资源测量：

| 场景 | 可操作时间 | 实传字节 | 命中 |
| --- | --- | --- | --- |
| 隔离入口首次访问 | 2410 ms | 1,752,117 | 0/3 |
| 同页重访 | 857 ms | 0 | 3/3 内存 |
| 关页重开 | 849 ms | 0 | 3/3 磁盘 |

这些是单次桌面样本，不是生产 p95，也不能代表日常 54 插件总量。历史日常 profile 的三段测量已与本机原始缓存报告及 `e5a7f7f` 交叉核对：14,656,593 → 699,746 → 3,243,349 字节，插件捆包后两次均复用；其余流量来自第三方资源和宿主动态接口。这支持保留真实缓存链路，不能证明外部协议无人使用，也不能把两次环境不同的耗时当作本次清理带来的加速。

## 当前安装包

`winlin926-dsh-remote-connect-0.6.0.tgz`：**30 个文件、119,741 字节**。原开发候选为 31 个文件、120,949 字节；删减 1,208 字节，不据此宣称运行性能提升。

- 包 SHA-256：`12fee7fe1e7c9430dce83d39b2996c463abbb71ad7ca73f1a673876ad608d5bf`
- `lib/index.js` SHA-256：`2c6e7e4a4c69d632efa83244d9a99b12cb4323911c6e2aa509b95b3d9221360a`
- `lib/client.js` SHA-256：`33f53846c58a02023761921ac84e47bc3f29629eb263fba97d8a2e4c4d95b38d`，与原候选一致。

## 验证边界

真实 Android/iPhone、真实公网节点与隧道、真实域名证书签发未在本轮验证；本机未安装 Docker，镜像构建与 Compose 启动待 CI/部署环境执行。没有改动日常 DSH profile，没有发布 npm 或创建版本标签。

浏览器脚本只作用于隔离宿主，结束时恢复覆盖的 Cookie 并关闭测试页面。隔离宿主已停止；本轮 `.qa/release-060` 的递归清理被自动审批以 `blocked by policy` 拒绝，残余验收数据尚待清理。`.qa/`、本机配置与凭据不提交、不打包。
