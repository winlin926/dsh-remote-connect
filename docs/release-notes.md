本次发布给插件补上自己的图标和显示名，安装后不再显示技术包名和一排空白方块。插件能力、节点协议和连接行为与 0.6.1 相同。

## 新增

**插件图标与显示名**。包根新增 `icon.svg`，并在 `package.json` 声明 `icon` 与 `./icon` 导出；新增 `locale/zh.json`、`locale/en.json`，把显示名设为「远程控制（dsh-carry）」/「Remote Control (dsh-carry)」。DSH 插件管理页按包清单的 `icon` 渲染图标、按 `locale/<语言>.json` 的 `meta.title` 渲染名称，缺少这两项时退回技术包名和默认图形——0.6.1 之前就是这种状态。

## 变更

**版本号 0.6.1 → 0.6.2**。插件、`remote-server` 与公网节点示例同步。运行时标识不变：插件内部 ID 仍是 `copylee-remote-control`，管理接口仍是 `/api/dsh-remote-connect/manage`，存储目录仍是 `~/.dsh/dsh-remote-connect/<profile>`，升级不需要重新配对、不需要重建节点。

## 升级

```powershell
dsh plugin --profile <你的 profile> add @winlin926/dsh-carry@latest
```

或在 DSH 插件页对已安装的 dsh-carry 点更新。更新后重启宿主，图标与显示名随插件管理页一起生效。
