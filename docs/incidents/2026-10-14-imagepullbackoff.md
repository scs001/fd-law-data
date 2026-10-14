# 2026-10-14 法律线 ImagePullBackOff 事故报告

**状态**：已修复并完成防复发加固。**唯一遗留**：rmfyalk 人工重登（见文末）。

## 一句话

节点镜像 GC 强制重拉后，法律线全线 `ImagePullBackOff`——11 个在制对象钉的
ccr tag 早已被驱逐（hkccr 尚存副本），而 relay 的 seen 账本**按设计不重灌已见
tag**；另有一批对象仍钉 2026-10-11 退役的 Harbor，全凭节点缓存续命，pod 一重建
即死。两因叠加，同时打掉了抓取、装载、报告与登录代理（broker 停机 7 小时）。

## 时间线（北京时间）

| 时间 | 事件 |
|---|---|
| 10-11 | Harbor 退役（retire-jenkins-harbor）；部分对象迁移到 ccr，但 flk-law-crawl / broker / guide-cases / flk-embed 等遗留 Harbor 钉 |
| 10-13 23:41 | vm-0-15 节点 `DiskPressure` 转真→假（kubelet 镜像 GC 触发点）；大量镜像被逐出 |
| 10-14 00:00 起 | 所有需重拉的法律线 Job 依次 `ImagePullBackOff`；broker Deployment 老 pod 仍在跑 |
| 10-14 02:xx | broker 老 pod 被替换 → 新 pod 拉 Harbor 失败 → **broker 停机**；此后 401 探活全败 |
| 10-14 07:0x | 排查开始（起因：legal-sources-report Job 连续失败） |
| 10-14 07:0x | 定位：ccr 上 `sha-7d89e71` manifest unknown（hkccr 有）；Harbor `connect: connection refused` |
| 10-14 07:5x | relay 手动补单 `sha-7d89e71` → ccr 可拉 → 11 对象恢复 Running |
| 10-14 07:5x-08:1x | chart 收敛 apply（broker + flk-law-crawl → ccr）；observer 重钉；4 挂起对象同步；anchors 补齐 |

## 根因链（两个独立缺陷叠加）

1. **tag 驱逐 + relay 设计性不回溯**：集群只拉 ccr。生产在用的
   `lawcraw-business/fd-law-data:sha-7d89e71` 只存在于 hkccr；ccr 侧副本被删
   （TCR 个人版 tag 配额清理，10-06 有先例）。relay 为了不烧 push 配额，对
   「已见过」的 tag 永不重灌——于是没有任何机制把 ccr 侧补回来。节点缓存一旦
   被 GC，pod 再也起不来。
2. **退役 Harbor 遗留钉**：`flk-law-crawl`、`legal-auth-broker`、
   `guide-cases-crawl`、`flk-embed` 仍钉 `100.64.0.8:30880`（10-11 已退役，
   连接直接被拒），此前仅靠节点缓存运行。
3. **放大器**：broker 停机 7h → 探活 401 → `crawl_identities` 里
   `rmfyalk/acct001` 进 `login_required` → dispatcher 每条 rmfyalk 单子判
   "auth pool dry"。另有 vm-0-15 上一枚 **主机级** `/etc/cron.d/fd-dispatcher`
   与集群内 dispatcher 抢单，但它没有 k8s SA token，凡它领到的单必报
   `dispatcher k8s error: ... serviceaccount/token`。

## 修复动作（全部已实证）

| # | 动作 | 证据 |
|---|---|---|
| 1 | relay 手动补单 `sha-7d89e71` → ccr | `skopeo inspect` ccr 可见；11 对象相继 Running |
| 2 | chart 收敛并 apply：全line → `sha-b63d0d1`（ccr 锚点），broker → ccr `sha-b726e1f` | `kubectl diff` 仅含预期 delta；broker rollout success |
| 3 | 三处 suspend 收敛回 live 真相（ccdi crawl/load、rmfyalk load） | apply 不再误停在跑源 |
| 4 | 4 个非图表对象重钉（flk-law-load/embed、guide-cases-crawl/load）+ 清掉 flk-law-load 一条重复明文 DB URL | `kubectl replace` OK；env 校验只剩 secret 引用 |
| 5 | federation-observer 重钉 `fd-industry-runner:sha-ea21592` | 手动触发 Job → Completed，日志 `0 reported, 0 already known` |
| 6 | vm-0-4 第二集群同病修复（fd-master 4 crons、proxy-control、broker、flk-crawl、observer、rmfyalk） | 两 Deployment rollout success |
| 7 | vm-0-15 主机级 fd-dispatcher cron 禁用（改名留档） | 集群内 dispatcher 是合法路径（有 SA token+namespace env） |
| 8 | anchors.conf 补齐：45+ 条 live pin 入锚；hkccr 缺的从 ccr 反镜像过去 | relay 日志 `OK ... sha-b63d0d1` 每 5 分钟循环 |
| 9 | 新增 `fd-image-pin-audit.sh`（巡检全舰队钉镜像可拉性） | 已提交 fd-industry-data 6bc9215 |

## 防复发三件套

1. **锚点自愈**：`/etc/tcr-relay/anchors.conf` 现含全部法律线生产 tag +
   45 条 live pin；relay 每 5 分钟对锚点无条件重灌（备份在
   `anchors.conf.bak-20261014*`）。驱逐后 5 分钟内自动补回。
2. **可拉性巡检**：`fd-image-pin-audit.sh`（fd-industry-data `scripts/`）。
   部署配方在脚本头（cheap3 + `/etc/cron.d/fd-image-pin-audit`，需 key 级
   凭据与多集群 kubeconfig）。
3. **清单同步**：helm chart 与 fd-law-data/k8s 所有清单已同步到同一锚点 tag，
   手动 apply 也不会再引入死钉。

## 遗留与人工动作

- **rmfyalk 重登（人工）**：`crawl_identities#27 rmfyalk/acct001` 自 10-10
  02:45 探活 401 后 `login_required`；登录站 #33/#34 起了但一直未完成。
  流程：`kubectl -n scraw apply -f k8s/legal-auth-broker.yaml`（镜像已换 ccr，
  可直接拉起）→ port-forward 登录 pod 6080 → 完成上游登录。之后 dispatcher
  自动恢复派发（本轮验证单 #173 的 "auth pool dry" 属正确行为）。
- **flk-law-embed**：其 `flk-embed-credentials` secret 在 scraw 不存在，
  保持 suspend；启用前需先补 secret。
- **my-others/* 三个第三方镜像**：hkccr 命名空间无权推送，无法反镜像；
  为已知例外（nango-server、pi-agent、pi-agent-bridge）。
