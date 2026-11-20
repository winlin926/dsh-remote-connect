# 测试指南

## 插件

需要 Node.js 24.9+ 和仓库 `packageManager` 指定的 pnpm 版本。

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run --ignore-scripts --json > package-manifest.json
node scripts/check-package.mjs package-manifest.json
Remove-Item -LiteralPath package-manifest.json
```

包检查验证生产入口、类型声明和许可文件，拒绝测试、日志与私有运行数据。

## 自托管节点

```powershell
npm ci --prefix remote-server --ignore-scripts
npm --prefix remote-server run typecheck
npm --prefix remote-server test
node scripts/verify-node-v2.mjs
docker build -f remote-server/Dockerfile -t dsh-remote-server .
```

## 改名兼容性

更名后的包仍必须使用旧的运行时标识。在隔离的 `.qa/` profile 里验证：先装入本次构建的包，并把一份由 0.6.0 写出的 `dsh-remote-connect/<profile>` 存储目录放在 `DSH_HOME` 下。

- 新包能启动，面板、二维码与配对页正常渲染。
- 旧存储目录被继续读取：设备授权、公网节点和偏好文件在升级后照常可用，不重新生成。
- 客户端仍能访问 `/api/dsh-remote-connect/manage`，服务标识仍为 `dsh-remote-connect`。
- 新旧包不能同时装入同一个 profile；迁移顺序是先移除旧包再安装新包。

## 浏览器验收

先安装 ego-browser，并确保 `ego-browser.exe` 位于 PATH。在两个终端分别执行：

```powershell
pnpm qa:host
pnpm qa:browser
```

测试宿主使用独立 `.qa/` 目录，检查配对、设备撤销、文件预览、节点管理、插件更新以及桌面和窄屏布局；结束后停止测试宿主并清理测试数据。

## 双线路验收

用隔离 DSH 启动测试网关，将 `scripts/public-entry-double.mjs` 的 `--target` 指向该网关。手机通过 ADB reverse 打开测试入口，并使用面板产生的配对票据。安卓真机直连通过同一 Wi-Fi 建立，测试入口通过 USB 转发，方便分别切断两条线路。

1. 选择公网优先，完成一次设备授权并打开一个会话。检查 Host 已建立备用直连。
2. 停止测试入口。切到直连后在当前会话发送消息，并打开工作区预览。记录 Host 的直连请求计数。
3. 恢复入口，暂时关闭手机 Wi-Fi。在当前会话再次发送消息，随后恢复 Wi-Fi。核对两个消息的会话 ID 与执行次数，设备授权在切换期间保持有效。
4. 撤销测试设备。入口请求应返回 403，Host 应关闭该设备的直连。

首次打开域名需要入口可达。既有可信内网 HTTPS 可使用同域名直连。通过故障期间的 LAN 码建立的是局域网会话。公网恢复后可用域名入口开启双线路会话。生产域名、蜂窝网络与锁屏恢复按实际设备分别验证。
