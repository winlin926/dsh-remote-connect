# 验证记录

## 当前：固定公网域名改造

本轮以 `dsh-remote-control` 为主体，删除 Cloudflare Quick Tunnel / localhost.run 临时隧道，将“任意网络”改为自己的固定 HTTPS 域名，并迁入 `dsh-roam` 的连接密码与证书能力。手机 `src/remote/` 没有改动。

### 自动化

- `pnpm exec vitest run`：8 个测试文件、60 条测试通过。
- `pnpm exec tsc --noEmit`：通过。
- `pnpm build`：TypeScript 与 tsdown 构建通过。
- `git diff --check`：通过。
- 打包检查：106 个文件、57 个手机界面懒加载块，QA 文件未进入包；无 tunnel-worker 或临时隧道产物。

覆盖范围：固定域名规范化与私网地址拒绝、旧配置迁移、固定/随机密码、错误密码限速、当前网关身份探测、固定 Host 校验、密码前置闸门、本机确认、设备撤销、ACME 挑战路径限制、HTTP / WebSocket / SSE 传输、连接生命周期与回滚、证书状态/自签替换/续期/错误隔离/Windows 私钥 ACL、系统代理解析。

### 隔离的真实 DSH 与 Chrome

使用 `.qa/` 下的独立 DSH Web profile、测试模型与临时配置，不使用真实用户数据。

- 电脑面板：固定域名、密码、证书、代理和自定义/原生界面选项均显示；没有 Cloudflare / localhost.run 控件。
- 布局：1180 / 720 / 390px 视口无文档横向溢出；保留原有强调色与卡片风格。
- 公网模式：监听 43128，二维码使用固定域名；切换手机界面选项不重建监听端口。
- 本地 HTTPS 测试域名：完成输入密码 → 电脑确认 → 自定义手机界面启动，WebSocket 正常；切换原生界面通过，无页面脚本错误。
- 测试域名为 `dsh.example.com`，HTTPS 证书只存在于 `.qa/`，没有安装到系统。

### 未覆盖的真实环境

- 没有访问或修改真实 `dsh2.sanlin.xin`、日本节点、frpc 配置或正在运行的远程连接。
- 没有向 Let’s Encrypt 发起真实申请或续期；申请逻辑用测试签发器和测试证书验证。
- 没有进行实体 Android / iPhone、移动运营商网络或 Safari 验证。
- 证书部署后是否需要重载 frpc 由面板提示；插件不会自动重启系统服务。
