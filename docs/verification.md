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

CI 在 Windows 和 Linux 上运行插件与服务端检查，并在 Linux 上构建服务端镜像。真实手机、部署后的公网节点、TLS 签发和 Compose 启动需在对应环境单独验证。
