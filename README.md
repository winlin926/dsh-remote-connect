# DSH 远程连接

**远程连接** —— 用手机浏览器继续电脑上的 DeepSeek Harness（DSH）会话，支持扫码配对、消息发送、工具审批、附件与文件管理。

基于 [copylee711/dsh-remote-control](https://github.com/copylee711/dsh-remote-control) 修改，保留原项目 MIT 许可证。当前适配 **DSH 0.2.2-rc.1**。

## 界面预览

![电脑端远程连接面板](assets/desktop-connect.png)

## 手机打开的就是电脑上的界面

插件不再自带一套手机聊天界面。手机浏览器打开远程连接地址时，运行的是**电脑上正在使用的那一份 DSH Web 界面**：

- 电脑升级 DSH 后，手机刷新即同步，不需要更新插件；插件也不再有自己的一套前端版本号要跟。
- DSH 对手机、平板、窄窗口做的适配（软键盘、触屏、窄屏设置页等）随宿主一起生效。
- 插件只负责它真正该负责的部分：认证网关、扫码配对、局域网 / 公网入口、证书与本机管理面板。

宿主 0.2.2 起，手机体验（视口、键盘策略、状态栏颜色、文档语言、触控与窄屏布局）全部由宿主自己负责，插件不再往页面里注入任何覆盖样式。插件保留的 boot 脚本只做远程链路自己的事：同源传输、本机文件预览、断线 / 撤销遮罩、拒绝浏览器翻译提示。

## 相比原项目的修改

- 把"原生界面"从内置前端改为**代理宿主的当前页面**：删除 `@deepseek-ai/dsh-web-frontend` 运行依赖和整套静态资源分发，手机不再拿到旧版本前端。
- 删除自带的自定义手机聊天界面（约 1400 行、依赖 rc.3 内部 Slots/hostFace），插件只保留宿主稳定接口（webServer / connection / schedule）。
- 依赖统一到 **0.2.2-rc.1**，插件入口与宿主同版本编译。
- 跟随宿主 0.2.2 的三处变化：宿主的 `etag` / `304` 原样透传（不再对 `304` 加 `content-encoding`）、WebSocket 两段默认开 `permessage-deflate`（可用 `websocketCompression: false` 关闭）、面板图标改用新的 `settings.section.icon` 插槽。
- 配对页、密码页、拒绝页的配色与字号换成宿主自己的设计 token（#FFFFFF / #0F1115 / #61666B / 12px 圆角 / 26px 标题），主操作仍使用插件共享的强调色。
- 保留扫码配对、局域网 / 公网两种连接、固定域名与 ACME 证书、断线恢复、手机本机文件预览。
- 自动化回归覆盖配对、官方界面挂载、聊天、审批、附件上传、面板与设备撤销。

## 安装

环境要求：Node.js 22.19+ 或 24+，DSH **0.2.2-rc.1 以上**（`dsh.engines.dsh = >=0.2.2-rc.1 <0.3.0-0`）。

在 DSH 插件管理中添加：

```text
@winlin926/dsh-remote-connect
```

使用命令行安装：

```bash
dsh plugin --profile web add @winlin926/dsh-remote-connect@latest
```

DSH 桌面版和 `dsh web` 使用各自的配置，需要分别安装。

## 最简单的用法：同一 Wi-Fi

1. 手机和电脑连接同一个 Wi-Fi。
2. 在电脑上打开插件，选择 **同一 Wi-Fi**，开启远程连接。
3. 手机扫描二维码，在电脑上确认配对。
4. 配对完成后，直接在手机浏览器里继续会话。

此方式**不需要 SakuraFrp、frpc、公网域名或 HTTPS 证书**，也不要求手机安装 App。只在可信局域网中使用。

## 任意网络（公网）怎么用

想在外面用移动网络或其他 Wi-Fi 连接电脑时，需要自己的**固定 HTTPS 域名**和一条能访问电脑的转发通道。

可以把链路理解为：

```text
手机 → 你的 HTTPS 域名 → SakuraFrp / frpc / 反向代理 → 电脑的 127.0.0.1:43128
```

**SakuraFrp 不是必须安装的软件。** 它只是转发方式之一；已经使用其他 frpc、Nginx、Caddy 或内网穿透工具做好转发，就不需要再启动 SakuraFrp。

### 准备转发

1. 准备一个域名，并配置 HTTP 80、HTTPS 443 到本插件网关 `127.0.0.1:43128`。
2. 确保转发服务正在运行，证书与域名匹配。
3. 打开插件，选择 **任意网络**，在“连接与外观设置”填写域名，例如：

   ```text
   https://dsh.example.com
   ```

4. 开启远程连接，点击 **检测连通性**。显示可访问后，再扫码配对。
5. 公网新设备先输入电脑面板显示的 6 位连接密码，再在电脑上确认。

插件不会替你购买域名、创建隧道、启动 SakuraFrp 或修改系统服务。提示“公网入口不可达”时，通常说明转发服务未启动、域名解析不正确，或转发目标不是当前电脑的 `43128`。

使用 SakuraFrp 时，插件会按其 `FrpcWorkingDirectory` 约定部署证书；如面板提示重载隧道，需要在 SakuraFrp 中手动操作。也可使用其他反向代理自行管理证书。

## 从旧版本升级

旧版保存的“手机界面”选择（自定义 / 原生）在升级后失效并被忽略：只剩宿主界面这一种。旧的 `/?ui=custom`、`/?ui=native` 链接会自动跳回 `/`，不需要重新配对。

0.2.2 起宿主按**包自身的 `package.json` 名字**加载插件，不再跟随安装时的依赖键名。如果之前用 `link:` 以别的名字（例如 `@copylee/dsh-remote-control`）挂在本机 profile 里，升级宿主后会报 `Cannot find package`，需要把依赖键名改成 `@winlin926/dsh-remote-connect` 后重启。

`mobileShim` 配置项已在 0.4.0 删除：宿主自己拥有手机布局，插件不再注入覆盖样式。配置里留着这一项会被忽略，不会报错。

## 安全提示

已授权手机拥有与电脑本机相近的操作权限，包括管理设置、凭据和插件。只批准自己的设备，不要将配对链接、连接密码或授权设备信息发到公开位置；不再使用时及时撤销设备。

## 开发与验证

```bash
pnpm install
pnpm typecheck
pnpm test          # 单元测试：网关准入、配对、公网、证书、桌面面板
pnpm build         # tsc + tsdown，产物在 lib/
pnpm qa:host       # 启动隔离的真实 DSH 宿主（独立 DSH_HOME，不碰用户数据）
pnpm qa:native     # 手机视口验收：配对后必须加载宿主界面并能对话
pnpm qa:browser    # 完整链路：面板、配对、官方界面、上传、审批、设备撤销
```

`pnpm qa:*` 需要先运行 `pnpm qa:host` 并在 `.qa/connection.json` 写入宿主地址。

## 致谢

感谢原项目 [copylee711/dsh-remote-control](https://github.com/copylee711/dsh-remote-control) 及其作者 Copy。原项目关于固定域名、密码和证书的设计还参考了 [dsh-remote-web-ui](https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-remote-web-ui)、[DSH Remote](https://github.com/mrRisega/dsh-remote/tree/main/packages/dsh-remote) 与 [dsh-roam](https://github.com/winlin926/dsh-roam)。

## 许可证

MIT，保留原项目版权声明，见 [LICENSE](LICENSE)。
