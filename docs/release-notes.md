本次发布优化手机端启动体验：打开 DSH 时显示与主界面一致的全屏黑白启动场景、真实模块进度和启动完成状态，减少用户对加载卡死的误判。

## 变更

**DSH 风格手机启动界面**。移除底部深色悬浮状态卡，改为自适应明暗主题的全屏启动场景，使用 DSH 黑白鲸鱼标志、插件清单检查状态、真实模块计数和克制的流光进度。检查阶段不显示伪造比例，模块名称使用用户可读文案；启动完成后隐藏进度条并淡出，不阻塞页面交互。

**版本号 0.6.2 → 0.6.3**。插件、`remote-server` 与公网节点示例同步。运行时标识不变：插件内部 ID 仍是 `copylee-remote-control`，管理接口仍是 `/api/dsh-remote-connect/manage`，存储目录仍是 `~/.dsh/dsh-remote-connect/<profile>`，升级不需要重新配对、不需要重建节点。

## 升级

```powershell
dsh plugin --profile <你的 profile> add @winlin926/dsh-carry@latest
```

或在 DSH 插件页对已安装的 dsh-carry 点更新。更新后重启宿主，手机浏览器下次进入时会显示新的启动界面。
