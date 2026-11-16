# 发布约定

当前正式候选版本为 **0.6.0**。插件、服务端软件版本、Git 标签 `v0.6.0`、GitHub Release 与 npm 包版本保持一致；节点发现协议的 `protocol: 2` 独立于软件版本。

开发期间用提交哈希识别构建。需要分发预发布包时使用 `0.6.0-dev.N` 或 `0.6.0-rc.N`，不为每轮修改递增正式补丁号。正式版本只在实际发布时确定；已经发布到 npm 的同版本不能替换。

## 提交与分发内容

| 去向 | 内容 |
| --- | --- |
| GitHub 源码仓库 | `src/`、`remote-server/` 源码与部署模板、`tests/`、`scripts/`、CI、两份锁文件、构建配置、当前文档、README 截图、许可证、第三方兼容补丁 |
| npm 包与 GitHub Release 附件 | 同一个 `.tgz`，仅含 `lib/*.js`、`lib/types/**/*.d.ts`、`package.json`、`cordis.patch.yml`、README 与 LICENSE |
| 仅本机保留 | `node_modules/`、构建目录、`.qa/`、`.agents/`、`.mnemon/`、日志、包清单、`.tgz`、真实 `.env`、数据库、设备授权、主机身份与证书 |

`tests/fixtures/` 中的证书和私钥只用于失败场景与本机测试，属于公开测试数据，不能用于部署。`.env.example` 只有占位值，可以提交。服务端源码不塞入插件安装包，需要自托管时从仓库构建。

## 发布检查

```powershell
pnpm install --frozen-lockfile --ignore-scripts
npm ci --prefix remote-server --ignore-scripts
pnpm typecheck
npm --prefix remote-server run typecheck
pnpm test
npm --prefix remote-server test
pnpm build
npm pack --dry-run --ignore-scripts --json > package-manifest.json
node scripts/check-package.mjs package-manifest.json
```

按影响范围运行 [浏览器验收](verification.md)，更新 [当前发行说明](release-notes.md)。提交前检查 `git diff --check` 和 `git status --short`，只提交相关文件。

推送源码分支只触发 CI。确认对应提交的 Windows/Linux 检查通过后，显式批准正式发布，再创建并推送与包版本一致的 `v*` 标签。标签会触发 `.github/workflows/publish.yml`：重新验证插件与服务端、打包一次、校验实际 `.tgz`，向 npm 发布该包，并把同一文件附到 GitHub Release。

正式发布会永久占用 npm 版本号；不通过修改 Release 标题把 `0.6.3` 包伪装成 `0.6.0`，不覆盖已有标签或发行附件。Git 历史中的开发提交保留，不为整理公开版本重写已推送历史。
