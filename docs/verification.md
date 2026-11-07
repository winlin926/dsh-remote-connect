# 验证记录

## 当前：适配 DSH 0.2.2-rc.1，手机端与官方一致（0.4.0）

宿主 0.2.2 把手机/平板适配做进了官方界面，本插件不再需要、也不应该再往页面里注入移动端覆盖样式。本轮把依赖升到 0.2.2-rc.1、跟随它的三处接口变化，并按实测的官方设计 token 重做了插件自己那几个页面。

### 接口与行为变化

- **WebSocket 压缩**：手机段与宿主段都开 `permessage-deflate`；新配置项 `websocketCompression` 默认 `true`。宿主 0.2.2 的 release note 说明远程连接默认压缩，插件侧不跟上则两段都白压。
- **条件请求**：宿主开始发 `etag` 并回 `304`。网关对 `304` 只补 `vary`，不加 `content-encoding`、不二次压缩，`range` 请求也不重压缩（否则手机拿到的是坏缓存）。
- **面板图标**：宿主新增 `settings.section.icon` 插槽，`nav-icon.ts` 从「往 DOM 里塞 marker + CSS mask」改成直接导出一个 React 手机图标组件，id 与 `settings.section` 一致。
- **删除 `mobileShim`**：实测宿主 0.2.2 自己负责 `interactive-widget`、表单字号、`theme-color` 与 `lang`。官方 `dsh-client-ui-conversation` 的补丁说明明确按「键盘平移整页」实现，而 shim 注入的 `resizes-content` 是另一套模型，二者冲突。boot 脚本现在只做远程链路自己的事（本机文件链接、断线遮罩、boot 报告、拒绝翻译提示）。
- **自有页面重排**：配对页、密码页、拒绝页、不可用页改用实测的官方 token —— 亮色 `#FFFFFF` / `#0F1115` / `#61666B` / `#818588` / `rgba(0,0,0,.12)`，暗色 `#151517` / `#F9FAFB` / `#ADB2B8` / `rgba(255,255,255,.16)`；标题 26px/500，正文 14px，卡片 12px 圆角并去掉重投影；`theme-color` 跟随深浅色。主操作固定用陶土橙 `#D97757`（docs/ui-spec.md 的例外条目）。

### 手机端面板与网关加固

用手机视口（320×568 / 390×844 / 430×932，深浅色，软键盘）逐状态核过之后修掉的一批缺陷：

- **面板**：关闭键、侧栏入口、折叠标题与重命名框统一到 44px 触控目标（断点 `@media (max-width:560px), (pointer:coarse)`，桌面不被放大）；设备列表不再套内层滚动（`max-height`/`overflow` 在窄屏与粗指针下取消）；按 `visualViewport` 把面板钳在软键盘上方，收起后复原；复制走 `execCommand` 兜底（局域网 http 下 `navigator.clipboard` 不存在）；2.5s 轮询单飞并在页面隐藏时暂停；两个对话框补 `aria-label` / `aria-labelledby` 与初始焦点。
- **网关**：发给手机的 close 码先规范化（1005/1006/1004 等 `ws` 拒发的值转 1011），`ws.close` 抛错时 `terminate` 兜底 —— 原来一个空 close 帧就能让宿主进程未捕获异常退出；`response` 一开始就撤掉 120s 空闲计时，长流不再被掐断；`/rc/boot.js` 带内容 `etag` 并支持 `304`；预览能力 URL 增加 12 小时绝对寿命（原来只有 2 小时滑动闲置，持续使用可无限续期）。
- **boot 脚本**：撤销探测单飞，且不跟随 `/rc/sse` 载体；重连按 3s→6s→…→30s 退避，连上后归零；随机 UUID 兜底改为可再次覆盖的属性；blob 打开的窗口断开 `opener`；断线遮罩改为 `aria-modal` 对话框，焦点落在唯一按钮上。
- **配对密码入口**：从只渲染在「任意网络」主栏移到「密码直连配对」开关下方，局域网连接的用户也能设置。
- **强调色**：固定陶土橙 `#D97757`，删除三色选择与跟随宿主 `--cl-accent` 的整套同步机制。

### 自动化

- `pnpm typecheck`：通过。
- `pnpm test`：8 个测试文件、78 条测试通过。新增：`304` 保持 `etag`、无体、无二次压缩；WebSocket 两段协商出 `permessage-deflate` 并完成消息回环；boot 脚本不再包含 `interactive-widget` / `dsh-rc-mobile`；`ws` 拒发的 close 码全量规范化、空 close 帧不让宿主崩；`/rc/boot.js` 用内容 `etag` 走 304；跨源 `EventSource` 交还浏览器；撤销探测单飞且跳过 SSE 载体；重连退避 3s→30s 并在连上后归零；预览能力超过 12 小时绝对寿命即退役；撤销遮罩是可聚焦确认按钮的模态对话框。
- `pnpm build`：通过，`lib/index.js` 108.42 kB（gzip 33.50 kB）、`lib/client.js` 73.29 kB（gzip 19.68 kB）。
- 打包检查：`npm pack --dry-run --json --ignore-scripts` → 27 个文件、70.4 kB；`lib/types` 与 `src` 一一对应（清掉 `lib/` 重建后没有残留的 `remote/*` 声明）。

### 隔离的真实 DSH 与 Chrome

`.qa/` 下独立 DSH_HOME 与 `@deepseek-ai/dsh@0.2.2-rc.1`，手机视口 390×844、`isMobile`、iPhone UA；桌面 1280×960。

- `scripts/browser-qa.mjs`（`DSH_QA_APPROVAL=1`）全绿：本机面板 200、配对待批准、远程管理被宿主授予、官方 WebSocket 复用（`/rc/sse` 与 `/api/remote.mux` 无失败）、真实会话流式回复、二进制上传 200、一次性工具审批在宿主只执行 1 次、手机上插件面板可开、撤销后同一浏览器 403；`preRevocationErrors` 为空。
- 手机截图 `.qa/official-mobile-chat.png` 与官方 0.2.2 手机界面一致：顶栏 + 「对话 / 轨迹」标签、附件卡、工具调用卡、"2 轮 3 步"、底部输入区与蓝色发送按钮；`scrollWidth === innerWidth`，无横向溢出。
- 配对页 `.qa/shot-pairing.png`（亮）/ `.qa/shot-pairing-dark.png`（暗）与宿主 token 对齐。

### 官方数值来源（实测，不是猜的）

在真实 0.2.2 页面上用 Playwright 读计算样式：亮色正文 `rgb(15,17,21)`、次要 `rgb(97,102,107)`、说明 `rgb(129,133,140)`、卡片描边 `rgba(0,0,0,0.12)`、主按钮 `rgb(65,118,230)`、`--dsw-radius-md: 12px`、标题 26px/500；暗色背景 `rgb(21,21,23)`、正文 `rgb(249,250,251)`、次要 `rgb(173,178,184)`、描边 `rgba(255,255,255,0.16)`、主按钮 `rgb(122,170,255)`。官方 `--dsw-alias-*` 字面值由主题 presenter 在运行时注入，CSS 里取不到，所以只能这样量。

### 升级路径上的坑（给维护者）

- 宿主 0.2.2 的插件加载器按**包自身的 `package.json` 名字**解析 import，不认 `link:` 的依赖键别名。旧 profile 里的 `@copylee/dsh-remote-control` 键必须改成 `@winlin926/dsh-remote-connect`，否则报 `ERR_MODULE_NOT_FOUND`。
- 旧 `pnpm-lock.yaml` 会把 `dsh-llm-deepseek` 的 peer 解析留在 0.2.1-rc.3，运行时报 `does not provide an export named 'createModelListingCache'`。删 lockfile 与 `node_modules` 重装即可。
- 本机 shell 若带 `DSH_PROFILE`，插件存储目录会跟着变；`vitest.config.ts` 固定 `DSH_PROFILE=default` 以免测试路径漂移。

### 未覆盖的真实环境

- 没有用实体 Android / iPhone 验证，只有 Chrome 的手机视口模拟；虚拟键盘、输入法组合输入、真机滚动惯性仍需真机确认（尤其删掉 `interactive-widget` 之后的键盘表现）。
- 没有做真实公网转发（frpc / SakuraFrp）与真实 Let's Encrypt 申请；仍由测试签发器覆盖。
- 没有在英文环境下验证页面语言与 `translate` 行为。

## 历史：手机改用宿主原生界面（0.3.0）

本轮删除插件内置的固定版本前端与自带手机界面，网关改为取回宿主的 `GET /` 并注入同源 boot 脚本；页面、资源、API 与 WebSocket 全部透明代理到宿主。手机现在运行的就是电脑上正在使用的那一份 DSH Web 界面。

### 自动化

- `pnpm typecheck`：通过（`@deepseek-ai/dsh` 及宿主接口依赖已统一到 0.2.1-rc.5）。
- `pnpm test`：8 个测试文件、67 条测试通过。其中新增/改写：首页代理与 boot 脚本同源下发、`/assets/*` 不再由插件读取、`?ui=custom|native` 302 回 `/`、退役的 `ui` 偏好被忽略。
- `pnpm build`：通过；`lib/` 只剩 `index.js` + `client.js` + 类型声明。
- 打包检查：`npm pack --dry-run --json --ignore-scripts` → 41 个文件、73 kB，QA 文件未入包，无 `lib/remote*`、无 `style.css`，依赖中不再出现 `dsh-web-frontend`。

### 隔离的真实 DSH 与 Chrome

使用 `.qa/` 下的独立 DSH Web profile（`@deepseek-ai/dsh@0.2.1-rc.5`）、测试模型与临时目录，不使用真实用户数据；Chrome 无头，手机视口 390×844、`isMobile`、DPR 3。

- `scripts/native-qa.mjs`：扫码配对 → 电脑确认 → 手机进入 `/`。断言：`/rc/boot.js` 由网关同源下发、`__DSH_REMOTE_CONTROL__` 生效、宿主 `__DSH_BOOT__` / `__ModuleLoader__` 存在、`#root` 已挂载、页面脚本来自宿主构建（`./assets/index-*.js`）、`lang="zh-CN"`、配对后无 4xx / 控制台错误、无横向溢出、输入区可达、发消息收到模型回复。
- `scripts/browser-qa.mjs`（`DSH_QA_APPROVAL=1`）：电脑面板打开并显示，局域网启动、配对待批准、宿主 WebSocket 复用、`/api/session/prompt` 流式回复、二进制上传 200、一次性工具审批在宿主只执行 1 次、手机上插件面板可打开、撤销设备后同一浏览器得到 403。

### 体积与依赖

| 指标 | 改造前 | 改造后 |
|---|---|---|
| `lib/` 产物 | 134 文件 / 5.35 MB（含 59 个 `remote-*.js` 语言包） | 72 文件 / 0.56 MB（入口与类型声明） |
| 源码 | 35 文件 / 4477 行 | 21 文件 / 3099 行 |
| 运行依赖 | 6 个（含 `@deepseek-ai/dsh-web-frontend`，92 文件 / 5.1 MB） | 5 个（qrcode / undici / ws / acme-client / https-proxy-agent） |
| 开发依赖 | 85 个 | 16 个 |
| 打包内容 | 106+ 文件 | 41 文件 / 73 kB |
