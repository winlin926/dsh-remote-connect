# 验证记录

## 当前：手机改用宿主原生界面（0.3.0）

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
| `lib/` 产物 | 134 文件 / 5.35 MB（含 59 个 `remote-*.js` 语言包） | 72 文件 / 0.56 MB（全部为入口与类型声明） |
| 源码 | 35 文件 / 4477 行 | 21 文件 / 3099 行 |
| 运行依赖 | 6 个（含 `@deepseek-ai/dsh-web-frontend`，92 文件 / 5.1 MB） | 5 个（qrcode / undici / ws / acme-client / https-proxy-agent） |
| 开发依赖 | 85 个 | 16 个 |
| 打包内容 | 106+ 文件 | 41 文件 / 73 kB |

### 未覆盖的真实环境

- 没有用实体 Android / iPhone 验证，只有 Chrome 的手机视口模拟；虚拟键盘、输入法组合输入与真机滚动惯性仍需真机确认。
- 没有访问或修改真实的 `dsh2.sanlin.xin`、frpc 配置或正在运行的远程连接；公网模式只验证了链路代码与域名规范化，未做真实外部转发。
- 没有向 Let's Encrypt 发起真实申请或续期；ACME 逻辑仍由测试签发器与测试证书覆盖。
- 宿主的移动端改进（0.2.2-alpha.2 起的软键盘、窄屏设置页、触控目标等）随宿主版本走；本轮验证的宿主是 0.2.1-rc.5，插件的代理方案不改变宿主自身的布局表现。
