# DSH Remote Connect · 远程连接

**电脑上的任务继续跑，手机上接着聊。**

用手机浏览器继续电脑上的 **DeepSeek Harness（DSH）** 会话：查看进展、补充要求、处理工具审批，或打开电脑上的文件预览。手机打开的就是你正在用的那个 DSH 宿主自带的 Web 界面，不用安装 App。

**同一 Wi-Fi → 手机扫码 → 电脑确认 → 手机继续会话。** 局域网连接不需要域名、隧道或证书；外网访问可另外配置固定 HTTPS 域名与转发通道。

当前版本 **0.5.0**，适配 **DSH 0.2.2 系列**，验证基线为 **0.2.2-rc.3**。这是基于 [copylee711/dsh-remote-control](https://github.com/copylee711/dsh-remote-control) 维护的非官方插件，保留原作者署名和 MIT 许可证。

[安装与扫码](#安装与扫码) · [界面预览](#界面预览) · [公网连接](#进阶固定域名公网连接) · [从 dsh-roam 迁移](#从-dsh-roam-迁移)

## 安装与扫码

电脑需要 Node.js **24.9+** 和 DSH **0.2.2-rc.1 以上、0.3.0 以下**。

在 DSH 的 **插件 → 添加插件** 中输入：

```text
@winlin926/dsh-remote-connect
```

使用 `dsh web` 的用户，也可以在命令行装到 `web` profile：

```bash
dsh plugin --profile web add @winlin926/dsh-remote-connect@latest
```

插件装在**你正在用的那个宿主**里，连的也是它：桌面版连桌面版，`dsh web` 连 `dsh web`。两者的 profile 各自独立，需要在对应宿主中安装。

**不需要为了手机访问另起一个 `dsh web` 实例。** 手机打开的是这个宿主自己正在用的界面，机器上不会多出一个 DSH 进程；远程连接只是给这个已有宿主加了一条用手机访问的入口。

1. 手机和电脑连接同一个 Wi-Fi。
2. 点击电脑侧栏底部的远程连接按钮，或进入 **设置 → 远程控制**。
3. 选择 **同一 Wi-Fi**，点击 **开启远程连接**。
4. 用手机扫描二维码，在电脑上确认新的配对请求。
5. 在手机浏览器中继续会话、查看进展或处理审批。

二维码有效期为 5 分钟，过期后刷新二维码；已有设备授权不因二维码过期而失效。手机打不开地址时，先核对两台设备所在网络和面板显示的地址、端口。

## 界面预览

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-remote-connect/main/assets/desktop-connect.png" alt="电脑上的远程连接面板：开启连接、扫码配对与管理已授权设备" width="760" />
</p>

<p align="center"><strong>电脑上：开启连接、扫码配对、管理已授权设备</strong></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-remote-connect/main/assets/mobile-session.png" alt="手机上的 DSH 新会话界面" width="300" />
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/winlin926/dsh-remote-connect/main/assets/mobile-chat.jpg" alt="手机上的 DSH 对话与输入框" width="300" />
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-remote-connect/main/assets/mobile-tools.jpg" alt="手机上的工作区工具入口" width="300" />
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/winlin926/dsh-remote-connect/main/assets/mobile-settings.png" alt="手机上的 DSH 通用设置界面" width="300" />
</p>

<p align="center"><strong>手机上：新会话 · 对话 · 工作区工具 · 通用设置</strong></p>

手机加载的是电脑正在运行的那一份 DSH Web 界面。聊天、设置和工具入口由宿主版本及已启用扩展决定；插件不另存一份手机前端，也不覆盖宿主的聊天布局。电脑更新 DSH 后，手机刷新即可加载宿主当前界面，宿主接口变更时仍需检查插件兼容性。

## 能做什么

| 能力 | 说明 |
| --- | --- |
| 继续会话与审批 | 使用宿主界面查看任务、发送消息、切换工作区与模型、处理工具审批。 |
| 扫码配对 | 新设备在电脑上确认后连接；网络失败后，可在原有效期内继续配对领取。 |
| 设备管理 | 查看在线状态、重命名设备、撤销单台或全部设备授权。 |
| 文件预览 | 打开电脑上的 HTML 页面及其资源，或预览普通文件；普通文件上限为 48 MiB。 |
| 公网访问 | 使用固定 HTTPS 域名与已有转发通道，在其他网络访问电脑。 |
| 证书管理 | 申请、续期 ACME 证书，并按转发工具的约定部署证书。 |

## 进阶：固定域名公网连接

需要在移动网络或其他 Wi-Fi 使用时，准备自己的 **HTTPS 域名**和一条能访问电脑的转发通道：

```text
手机 → HTTPS 域名 → frpc / SakuraFrp / 反向代理 → 电脑的 127.0.0.1:43128
```

1. 将域名的访问请求转发至插件的公网网关 `127.0.0.1:43128`；自定义端口时以面板为准。
2. 在 **任意网络 → 连接设置** 中填写域名，例如 `https://dsh.example.com`。
3. 确保转发服务运行且 HTTPS 证书有效，开启远程连接并点击 **检测连通性**。
4. 检测通过后用手机扫码，输入电脑显示的 6 位连接密码，再在电脑上确认配对。

SakuraFrp 只是转发方式之一，已有 frpc、Nginx、Caddy 或其他反向代理时，可继续使用。插件不购买域名、不创建临时 Cloudflare/Pinggy 隧道，也不代为启动转发服务。

需要插件申请证书时，HTTP 80 的 ACME 校验请求也必须转发至网关。使用 SakuraFrp 时，插件按其 `FrpcWorkingDirectory` 约定部署证书，面板提示后需手动重载隧道；其他反向代理也可自行管理证书。

检测会核对当前电脑的实例身份。出现“公网入口不可达”时，检查域名解析、转发目标、转发服务和证书，避免把入口转到另一台电脑。

## 升级

更新当前插件、重载宿主中的插件后，刷新手机页面即可。包名、内部插件标识、设备凭据格式与存储位置保持兼容，已有设备不需要重新配对。

旧版的自定义手机界面和 `mobileShim` 配置已退出使用。`/?ui=custom`、`/?ui=native` 链接会转到宿主界面，旧界面偏好会被忽略。

如果曾用另一个依赖键名将源码 `link:` 到 profile，需将依赖键改为包自身的 `@winlin926/dsh-remote-connect`；DSH 0.2.2 按包自身名称加载插件。

### 从 dsh-roam 迁移

`dsh-roam` 已停止维护，后续开发集中在本项目。两者是独立插件，请在同一宿主 profile 中停用旧插件，再安装本项目并重新扫码配对。

| 事项 | 迁移后的行为 |
| --- | --- |
| 手机界面 | 使用宿主原生 DSH Web 界面，不再维护独立手机 UI。 |
| 设备授权 | 不导入旧浏览器授权或设备凭据，需要在电脑上重新批准。 |
| 外网连接 | 不提供旧版 Cloudflare/Pinggy 临时隧道，改用固定 HTTPS 域名与转发通道。 |
| 配置目录 | 旧项目使用 `$DSH_HOME/dsh-roam`，本项目使用 `$DSH_HOME/dsh-remote-connect/<profile>`；未设置 `DSH_HOME` 时，根目录默认为用户目录下的 `.dsh`。 |
| 电脑会话 | 会话仍由原 DSH 宿主管理；切换连接插件不会迁移或删除宿主会话。 |

旧配置不自动导入，也不自动删除。公网域名和证书部署请按本项目的连接设置重新核对。

### 第三方 Web UI 扩展兼容

`@linxin666/dsh-web-all@0.4.18` 的一条旧网格样式可能让手机新会话右偏，而历史会话正常。仓库提供[针对该版本的补丁](https://github.com/winlin926/dsh-remote-connect/blob/main/patches/@linxin666__dsh-web-all@0.4.18.patch)，仅删除这条冲突声明。

补丁需通过宿主 profile 的 pnpm `patchedDependencies` 单独应用，更新远程连接插件不会自动修改其他扩展。升级该扩展时，先确认上游是否已修复，再移除版本补丁。

## 授权与安全

已授权手机拥有与电脑本机相近的操作权限，包括管理设置、凭据和插件。只批准自己的设备，不公开配对链接与连接密码，不再使用时撤销授权。局域网入口只在可信网络使用；公网入口使用 HTTPS。

## 开发与验证

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm qa:host
# 另一终端；需要 PATH 中的 ego-browser.exe
pnpm qa:browser
```

浏览器验收前运行 `ego-browser skill` 阅读当前指南。隔离宿主和浏览器只使用本轮 `.qa/smoke/` 数据，不配置真实模型、不向模型发送请求；结束时回收本轮进程、认证地址、日志和截图。

SDK 升级或跨模块修改运行完整回归，局部修复选择受影响的测试。测试通过仅表示对应场景通过，浏览器窄屏模拟不等于手机真机验收；公网真实签发与手机网络切换需在对应环境验证。

## 致谢与许可证

感谢原项目 [copylee711/dsh-remote-control](https://github.com/copylee711/dsh-remote-control) 及作者 Copy。固定域名、密码和证书设计还参考了 [dsh-remote-web-ui](https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-remote-web-ui)、[DSH Remote](https://github.com/mrRisega/dsh-remote/tree/main/packages/dsh-remote) 与 [dsh-roam](https://github.com/winlin926/dsh-roam)。

MIT，保留原项目版权声明，见 [LICENSE](LICENSE)。
