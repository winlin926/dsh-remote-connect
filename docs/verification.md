# 验证范围

开发依赖、锁文件和隔离验收宿主统一使用 DSH 0.2.2-rc.3。插件版本为 0.6.1。

## 修改后的检查

- `pnpm build`：编译宿主与客户端，生成插件实际加载的 `lib/index.js`、`lib/client.js` 和类型声明。
- `pnpm test`：SDK 升级后运行一次现有回归。普通修复用 `pnpm exec vitest run <受影响的测试文件>`。
- 其他变更按影响范围选择现有测试；不为日常修改新增压测、基准目录或独立验收框架。

配对页回归执行 `pairingPage()` 生成的脚本，设备回归调用 `PairingService` 的公开入口，HTTP 回归访问真实网关。故障只在网络、磁盘或签发边界模拟；不复制生产算法，不增加测试专用导出。

重点覆盖：领取响应丢失后的幂等重试及其有效期、错误密钥与撤销、两种配对的容量限制和保存失败回滚、公网实例匹配与 24 秒总预算、并发证书申请去重、普通文件限制和预览沙箱。

## 手动验收工具

只保留 `qa:host` 和 `qa:browser`。前者创建 `.qa/smoke/` 下的独立 DSH_HOME；后者通过 ego-browser 访问宿主加载的实际插件，检查局域网开启、配对批准、宿主手机应用就绪、复制失败反馈、中文组合输入、旧轮询响应、HTML/文本预览与撤销，以及桌面和 320/390px 深浅色布局。手机应用必须出现官方抽屉布局且退出 `Loading plugins`；根节点有子元素只说明加载占位界面已经出现。

不运行模拟模型，不调用真实模型供应商，不自动批准外部设备。浏览器完成后恢复它覆盖的本机 Cookie 并关闭测试页面；停止测试宿主时清理本轮目录。`.qa/` 内的认证地址、日志与设备信息不提交、不打包。
截图因窗口最小化或 CDP 超时不可用时，单独记录为 `captureWarnings`，当次流程不再重复尝试捕获；只列出实际保存的截图，并在每次开始前清除同名旧图。布局和交互断言独立执行，不把缺少截图记作已完成视觉复核。

打包使用 `npm pack --dry-run --ignore-scripts --json`，检查生产入口存在且 QA、测试和历史资源没有进入包。已构建时不重复触发 prepack 构建。

## 本轮结果（2026-11-16）

- 公网入口统一为「节点」：发现文档 `/.well-known/dsh-remote`、`kind` 为 `gateway` 或 `service`、节点增删检测切换、公网密码删除、旧公网设备标记重配对、同主机局域网回退、缓存键按节点 origin + 主机身份 + revision 隔离。
- 自托管服务新增 `remote-server/`（Node 24 + `node:sqlite` + `ws`，Caddy 终止 HTTPS，单节点）与主机侧 `src/service-node.ts`：Host 主动连出 `/v1/tunnel`，手机经节点的普通 HTTP、SSE 与 WebSocket 请求转给本机 DSH；两侧共用 `src/remote/tunnel-protocol.ts`，不另造控制帧格式。
- 检查：`pnpm typecheck`、`pnpm build`、`pnpm exec vitest run` 通过，17 个文件 228 个测试；`remote-server` 的 `tsc -p tsconfig.json --noEmit` 与 `npm test` 通过，71 个测试。
- 删除自托管节点时先撤销节点侧注册：`DELETE /v1/hosts/:hostId`（Host Bearer、只能删自己、事务级联设备关系与会话、204）与 `ServiceNode.unregister()`；撤销失败不阻断本地删除，用中文提示在节点上执行 `npm run admin:reset -- <hostId>`。
- `npm pack --ignore-scripts` 生成 `@winlin926/dsh-remote-connect@0.6.1` 候选 `.tgz`：49 个文件、127747 字节；`lib/index.js` 与 `lib/client.js` SHA-256 分别为 `c9eed3616a6310ca9c3f876af7e986b888eb672a611718330b5f30b209d9915b`（189302 字节）、`779d092dd8225b1792284f10f109decb34518843557b2684d26f6beb97cd0d9c`（88769 字节）；`.tgz` SHA-256 `4e6ed6c9806866ccfd219988858dcfa73a03f1f739d692ff286d4783126edac1`、SHA-512 `SceUceCgHh61RLNvaCsFNLwjqg5F2FY4VY08O5jkKa/r8DAXngoaiubsiADSypwZMqUoV+Y0ajLD4VnLDbLBYA==`。未发布 npm。
- 隔离宿主 `qa:browser` 15 项通过：桌面与 320/390px 深浅色、扫码批准、宿主应用就绪、复制回退、组合输入、旧轮询响应、HTML/文本预览、撤销，以及公网节点面板（空列表文案、拒绝非 HTTPS、不可达节点不落盘）。三段缓存：首次访问 2978 ms / 3 请求 / 1,747,132 字节，同页重访 1473 ms / 0 字节 / 3 内存命中，关页重开 1859 ms / 0 字节 / 3 磁盘命中。该 profile 只有 3 个初始资源，不能代表日常 54 插件总量。
- 日常 profile 已装 0.6.1（`file:` 固定 tgz）并重启宿主：重启后 `/.well-known/dsh-remote` 返回 `version: "0.6.1"`，`hostId` `g7iflg32huZJkCXpOeWlLfYIOgAkPLcCyVIU-e2Un_Q` 与指纹 `83b89f960df686e6499025e939e5a52d` 与重启前一致，5 台设备授权保留，未配对访问仍 403。
- 日常 54 插件三段缓存（桌面 Chromium，真实磁盘缓存）：冷启动 7373 ms / 90 请求 / 14,656,593 字节；同页重访 4236 ms / 47 请求 / 699,746 字节（4.8%，插件捆包全部命中、0 字节）；关页重开 4797 ms / 86 请求 / 3,243,349 字节（22.1%，7.8 MB 与 1.4 MB 捆包仍从磁盘缓存复用）；三次 `boot-reports` 均 `phase=ready result=ready errors=0 completed=3`。残余为 `dsh-genui` 两个 vendor 资源无缓存头（909,910 + 177,738 字节/次）与宿主动态接口 JSON；完整报告见 `F:\AIData\dsh-releases\dsh-remote-connect\0.6.1\lan-cache-report.md`。
- `package-manifest.json` 式的旧包清单未再生成；`scripts/check-package.mjs` 直接校验 `.tgz`，确认入口文件与本次构建逐字节相同、包内无 `.qa`、测试与开发文件。
- 边界：自托管节点的端到端链路只在本机进程内假节点与自签 HTTPS 上验证，未在真实域名、真实服务器、真实手机与真实隧道上跑通；Docker 镜像未在本机 `build`/`up`；Coturn 临时凭据与真实 TLS 未实测；隔离宿主的浏览器验收已用真实 Chromium 渲染，但截图因 CDP 超时未保存，视觉复核只有布局断言。
- v2 本轮：公网节点契约并入 `docs/public-node.md`（`protocol: 2`，删除冻结备忘录）并同步 `docs/self-host.md`、`remote-server/README.md`、根 `README.md`、`.env.example`；本机无 Docker，Compose/Dockerfile/Caddyfile 只做静态核对；`scripts/verify-node-v2.mjs` 已在本工作树（未合并 B 的 v1 服务端）运行并按预期失败，浏览器 v2 断言需在 A 合并后执行。

- `pnpm test`：10 个文件、129 个测试通过；`pnpm typecheck`、`pnpm build` 通过。
- 局域网 TLS 覆盖证书到期/SAN/私钥、可信 WSS/SSE、Secure Cookie、规范 Host/origin、热重载原子性及不降级；browser transport 覆盖官方启动成功/失败状态、加载错误与凭据净化。
- `npm pack --ignore-scripts` 生成 `@winlin926/dsh-remote-connect@0.5.1` 候选 `.tgz`。包检查通过：24 个文件；`lib/index.js` 与 `lib/client.js` SHA-256 分别为 `e30b258ce39b23622e589ac401e98ee308e8a09c9f5aa9b9aff8e60000edf5fa`、`afd971cbf703850353aabe0bd9908e6a176b82c8613b97aa681c97b488a7a0ee`。未发布 npm。
- 隔离 DSH profile 从 `.tgz` 离线安装，桌面与 320/390px 手机布局、扫码批准、应用交接、输入/复制、预览和撤销通过。首次页面就绪 3.670s、同页重访 1.349s、关页重开 1.473s；重访与重开均传输 0 字节，重开 3 个资源均命中磁盘缓存。该 profile 只有 3 个初始资源请求，不能代表日常 54 插件的完整资源总量；浏览器进程重启后的缓存持久性未验证。
- 电脑没有 `dsh-lan.sanlin.xin` 证书，局域网 DNS 记录也未验通；未启用 LAN TLS，未更新日常 profile 或重启 DSH。手机 HTTPS、WSS 真机验收待证书与 DNS 条件具备后完成。

## 本轮结果（2026-11-14）

- 构建通过，生成目录先清理再编译，旧强调色和侧栏搬移模块没有残留声明。
- 已完成 SDK 升级回归；修正测试时钟后仅重跑受影响文件，配对、保存失败回滚、网关、证书及预览相关场景通过。
- `qa:browser` 在隔离 rc.3 宿主通过：扫码批准、宿主挂载、中文组合输入、两种复制失败反馈、旧轮询响应、HTML/文本预览与撤销。桌面及 320/390px 深浅色无横向溢出，关闭按钮对比度至少 4.5:1。
- 已成功采集的深浅色截图完成视觉复核；末次复跑的 CDP 截图超时，布局、对比度和交互断言通过，缺失截图单独报告。
- 发布包包含运行入口、类型声明、元数据、README 和许可证；QA、测试、截图和过时模块不入包。README 截图从 GitHub 读取。
- 安装仍有上游 `dsh-otel` 的 OpenTelemetry peer 范围警告，本轮未改写该上游依赖；隔离宿主启动与上述场景通过。
- 网关响应中途断开时，gzip 转换曾吞掉上游错误，使浏览器继续等待。已通过真实 HTTP 请求先复现，再改用 Node.js `pipeline` 统一结束各段流；网关现有 27 个场景通过，包含压缩与直传两种断流。
- 对照日常宿主实际安装的 54 个插件，约 36.9 MB 的同一合并脚本直接读取与经隔离网关读取的内容哈希一致；慢速接收约 47 秒完整结束。ego-browser 在 369px 局域网 HTTP 页面退出加载状态，显示官方应用布局。用户随后确认手机可以正常打开；这发生在新增断流修复重载之前。
- 右偏来自 `@linxin666/dsh-web-all` 0.4.18 的手机 CSS：单列 `grid-template-columns` 强制覆盖官方三列网格，产生宽度随内容变化的隐式列。在同一 369px 视口打开新会话和已有历史会话，新会话输入框左边距约 72px，历史会话约 16px；移除该声明后两者均约 16px，历史会话无横向溢出。
- `patches/@linxin666__dsh-web-all@0.4.18.patch` 只删除这条覆盖。本机 desktop 配置通过 pnpm 的 `patchedDependencies` 登记该版本补丁，已安装文件同步修正；远程插件不注入聊天布局样式。其余依赖记录及已有音频补丁保持不变。第三方包修复发布后，需要先核对上游，再移除这条版本补丁。
- 运行中的宿主已读到修复；真实刷新新会话、重新打开既有历史会话后，369px 视口的主区域起点均为 0，输入框左边距均约 16px，无横向溢出。验证未临时改动页面 CSS。pnpm 冻结锁文件检查、补丁反向应用检查及客户端脚本语法检查通过；没有升级其他依赖。手机旧页面需刷新后再确认对齐表现。

## 接口约定

- `GET /.well-known/dsh-remote`：节点发现，字段与校验规则见 `docs/public-node.md`；`gateway` 由本机网关提供，`service` 由 `remote-server` 提供，两者结构必须一致。
- `WSS /v1/tunnel`：Host 主动连出的隧道，帧格式见 `src/remote/tunnel-protocol.ts`；节点不解密、不落盘业务正文。
- `/rc/health`：保留 `ok` 和 `service`，新增不落盘的随机 `instanceId`，域名检测只接受当前实例。
- `/rc/pair/claim`：响应结构不变；批准后同一密钥可在原有效期内重试；刷新、停止、过期与撤销立即使旧请求失效。
- 设备凭据、偏好和存储位置保持兼容。旧自动化桥接已删除，任务管理由宿主原生界面处理。

## 验证边界

单元测试、模拟 DOM 和桌面接口核对不等于 Android Chrome、iPhone Safari 的真机验证。手机打开已由用户确认；软键盘、后台恢复、网络切换、公网转发与 ACME 签发仍需在对应环境单独确认。新增断流修复的构建需由用户选择时机重载，再验证实机上的中断行为。
