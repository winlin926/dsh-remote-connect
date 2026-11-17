本次发布把公开名称统一为 dsh-carry：npm 包改为 `@winlin926/dsh-carry`，GitHub 仓库改为 `winlin926/dsh-carry`，市场条目按新名称登记。插件能力、节点协议与界面行为与 0.6.0 相同，没有功能变更。

旧包 `@winlin926/dsh-remote-connect` 继续留在 npm 上并标记为已弃用，不删除、不覆盖、不复用版本号。

## 变更

**公开名称改为 dsh-carry**。展示名、npm 包名、GitHub 仓库与市场条目统一为 `dsh-carry`；README、文档、安装命令、截图链接和服务端示例中的版本号同步更新到 0.6.1。

**运行时标识保持不变**。插件内部 ID 仍是 `copylee-remote-control`，管理接口仍是 `/api/dsh-remote-connect/manage`，存储目录仍是 `~/.dsh/dsh-remote-connect/<profile>`，服务标识、前端数据属性和公网节点发现协议都不变。升级后设备授权、公网节点、偏好文件和已配对手机继续有效。

## 升级

1. 在 DSH 的「插件」里移除 `@winlin926/dsh-remote-connect`。
2. 安装 `@winlin926/dsh-carry`。
3. 重启宿主。

新旧包不能同时装到同一个 profile。新包继续读取旧存储目录和旧管理接口，所以迁移后不需要重新扫码配对，也不需要重建公网节点。
