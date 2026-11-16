# 发布约定

插件、服务端版本、Git 标签、GitHub Release 与 npm 包使用同一版本号。节点发现协议的 `protocol` 版本独立于软件版本。

开发期间使用提交哈希识别构建。需要分发预发布包时使用 SemVer 预发布标识，例如 `1.2.0-rc.1`。正式发行只使用尚未发布过的版本号。

## 提交与分发内容

| 去向 | 内容 |
| --- | --- |
| GitHub 源码仓库 | `src/`、`remote-server/` 源码与部署模板、`tests/`、`scripts/`、CI、两份锁文件、构建配置、当前文档、README 截图、许可证、第三方兼容补丁 |
| npm 包与 GitHub Release 附件 | 同一个 `.tgz`，仅含 `lib/*.js`、`lib/types/**/*.d.ts`、`package.json`、`cordis.patch.yml`、README 与 LICENSE |
| 仅本机保留 | `node_modules/`、构建目录、QA 数据、日志、包清单、`.tgz`、真实 `.env`、数据库、设备授权、主机身份与证书 |

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

按影响范围运行[测试指南](verification.md)，更新发行说明。检查 `git diff --check` 和 `git status --short`，只提交发行所需的源文件、测试与文档。

推送源码分支会运行 CI。通过 Windows/Linux 检查后，创建并推送与包版本一致的 `v*` 标签。标签触发 `.github/workflows/publish.yml`，运行两端检查，校验打包结果，向 npm 发布并将同一安装包附到 GitHub Release。

已发布的版本号与标签不可复用；更正已发布版本时，发布新的修订版本并保留原有发行记录。
