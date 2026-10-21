# dsh-workbuddy

把 **WorkBuddy / CodeBuddy** 订阅接进 DSH：在设置页里登录（可以登录多个）国内账号，
模型选择器里直接看得到**哪个免费、倍率多少**，每天自动签到领积分。

- **模型**：多出两条 provider 路由 —— `workbuddy`（海外）/ `codebuddy`（国内）
- **账号**：设置 → **WorkBuddy 账号**，登录 / 切换 / 移除，可登录多个
- **积分**：每天按北京时间自动签到（+100，连登第 7 天 +1000）、兑换连登档位、抽奖、上报活跃
- **计价**：模型名字里带「免费 / ×0.29」；每次调用真实花了多少积分，设置页直接看

## 前提

- DSH 桌面端或 Web 端（装好后要重启一次）
- 你自己的 WorkBuddy / CodeBuddy 账号（国内和海外是两条独立路由）
- 插件本身**零依赖、无构建**；只有跑自检脚本才需要 Node 22+

## 安装

```bash
git clone https://github.com/DoublexQAQ/dsh-workbuddy.git
```

然后在 DSH 里用插件管理器安装这个**目录**（`plugin_manager` 的 `install_bundle`，
`target` 传目录的绝对路径），装完**重启一次 DSH**。

重启后：设置侧栏里会出现 **WorkBuddy 账号** 这一页。

## 第一次使用

1. **登录**：设置 → WorkBuddy 账号 → 「登录新账号」→ 浏览器里完成一次官方授权。
   要多个账号就再点一次，列表里可以随时切换「当前账号」。
2. **选模型**：设置 → 模型，选 `codebuddy` 路由下的模型（海外的选 `workbuddy`）。
3. **想白嫖就先挑免费的**：`Hy3`、`Step-5-Preview`（名字里就写着「免费」）。

积分功能只作用于**国内账号**；海外账号用来跑模型。

## 看懂「免费」和「花多少积分」

**模型名字里就带计价**（DSH 的模型选择器按 provider 分组，稳定显示的只有名字）：

```
Hy3 · 免费                    GLM-5.3-flash · ×0.08
Step-5-Preview · 免费          GLM-5.3 · ×0.69
hunyuan-2.0-thinking · ×0.04   Default · ×2.2
```

`x0.00` 就是免费。倍率来自上游**按你账号权限下发**的模型表，所以不同账号看到的可能不一样。
点开模型还能看到上下文长度、输出上限、是否强制思考。

**每次真实花了多少积分**：设置页每个账号下面有「上次消耗 N 积分（模型）」，
以及「积分包：还剩多少 / 到哪天作废」——积分是按资源包到期作废的，别放到过期。

设置页里还有一张「模型与积分」表，免费的排在最前面，可随时「刷新价格表」。

## 每日自动积分

装好即开，北京时间（与你的机器时区无关）：

- 默认在 **9 点 / 21 点**跑完整闭环：签到 → 兑换已解锁的连登档位 + 抽奖 → 上报活跃 → 回读余额
- **错过会补**：开机晚了，下一次检查会补一次（笔记本不用 7×24 开着）
- **不会重复**：每天只跑一次，重启也不会重复触发；上游若回「今天已签到」，插件判成「已领过」而不是失败
- 想手动：列表里每个账号有「立即签到 / 刷新余额 / 刷新凭据」，顶部有「全部签到」

时间点与开关都能改（见下）。

## 常用设置

在 `cordis.patch.yml`（或你自己 profile 的 patch 里按 `id: workbuddy` 覆盖）：

```yaml
- id: workbuddy
  name: dsh-workbuddy
  config:
    routes: [workbuddy, codebuddy]   # 只用一个平台就删掉另一个
    autoLogin: true                  # 凭据失效时自动开浏览器授权
    openBrowser: true                # 设 false 则只在设置页显示授权链接
    failover: true                   # 当前账号被拒时自动切下一个
    autoCheckin: true                # 每天自动签到
    checkinHours: [9, 21]            # 签到时点（北京时间，整点）
    autoActivity: true               # 每天自动上报活跃（点亮连登）
    activityHours: [10]
    autoGrowth: true                 # 顺带兑换连登档位 + 抽奖（只涨积分）
    traceOutbound: false             # true = 把每次出站摘要写到 ~/.dsh-workbuddy/outbound.jsonl
```

完整配置项都在 [cordis.patch.yml](cordis.patch.yml) 的注释里。
站点专属的指纹清洗不放这里，放 `~/.dsh-workbuddy/sanitize.json`（见下）。

## 常见问题

**设置里找不到「WorkBuddy 账号」这一页**
装完必须重启一次 DSH —— 界面那一页是在应用启动时组装的。

**登录之后模型用不了**
两条路由的账号是**互相隔离**的：国内账号不能给海外路由用。如果你选的是 `workbuddy`（海外）
下面的模型，需要单独登一个海外账号；反之亦然。

**和别的插件撞了路由**
插件注册的是 llm 路由 `workbuddy` / `codebuddy`。如果另一个插件已经占了同名路由，
本插件**只跳过那一条并写日志**，不会整个激活失败；想两条并存就给其中一个改名：

```yaml
config:
  routeNames: { workbuddy: 'my-workbuddy' }
  routes: [my-workbuddy, codebuddy]
```

**怎么确认上游看不到 DSH**
把 `traceOutbound` 打开，去看 `~/.dsh-workbuddy/outbound.jsonl`：
里面是每次出站的头**名字列表**与请求体（凭据字段已打码）。出站头是照官方客户端构造的，
宿主自己的归属头在构造阶段就会被拒绝发出。

**积分没到账**
看设置页那个账号下面的「上次结果」：如果写的是「今天已经领过了」，说明当天已经领过；
其它文案就是上游的原话，照着排查即可。

**凭据存在哪 / 怎么删**
`~/.dsh-workbuddy/`：账号池 `accounts.json`、会话链映射、可选的出站日志。
在设置页点「移除」就会连凭据一起删掉。

## 站点专属指纹（可选）

插件出站前会把正文里的宿主痕迹改写掉（`deepseek-harness/…`、`DSH`、`app.asar`、`dsh-*` 等），
这些**任何 DSH 都会留下**的通用痕迹在默认表里，不用配置。

如果你在自己的 DSH 里额外装了人格 / 注入了固定文案，那属于**你这台机器特有**的东西，
放在本机状态目录里，不要写进仓库或 patch：

```jsonc
// ~/.dsh-workbuddy/sanitize.json
{
  "extraRules": [
    { "pattern": "某个固定句子", "flags": "g", "replacement": "", "why": "人格注入文案" },
    { "pattern": "某插件名", "replacement": "the local bundle", "why": "插件包名" }
  ],
  "words": ["额外想脱敏的词"]
}
```

改完重启一次 DSH 生效。它只影响**本机出站正文**，不改变插件对别人的行为。

## 许可

MIT，见 [LICENSE](LICENSE)。

上游接口属于腾讯的非公开接口，本项目只是本机转发；请只用**你自己**的账号，
不要把额度转售或共享给他人。