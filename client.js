/**
 * dsh-workbuddy — 浏览器半身（设置页里的「WorkBuddy 账号」）。
 *
 * 只做一件事：往 `settings.section` 这个**列表式**槽里追加一页（`id: 'workbuddy'`）。
 * 这是纯追加的座位（`replaceRisk: none`）：不改动、不替换、不遮蔽宿主或任何其它插件的
 * 界面，也不读别人的 DOM / 样式 / 组件；样式全部走 `wbk-` 前缀的类名，颜色一律取宿主
 * 主题变量，所以换主题、换语言都不会串味。
 *
 * 数据走插件自己的同源接口 `/api/workbuddy/*`（由 Host 半身在 `webServer` 上注册），
 * 而不是类型化 Remote——这样它与 DSH 的内核版本解耦，也能在任何提供 webServer 的
 * 组合里工作。凭据从不下发到浏览器：页面拿到的账号视图里没有 token 字段。
 */

window.__ModuleLoader__.load({
  id: 'dsh-workbuddy',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback, useRef } = React

    const NS = 'settings.workbuddy'

    /** 同源接口前缀：跟随宿主页面的 base（子路径部署也能对上）。 */
    const API = (() => {
      try {
        return new URL('api/workbuddy', document.baseURI).pathname
      } catch {
        return '/api/workbuddy'
      }
    })()

    const DICT = {
      zh: {
        'meta.title': 'WorkBuddy 账号',
        'meta.description': '在设置里登录并管理多个国内 CodeBuddy / WorkBuddy 账号：切换当前账号、查看积分、每日自动签到。',
        title: 'WorkBuddy 账号',
        sub: '国内账号在这里登录，可登录多个。调用顺序：先用「模型轮换顺序」里的模型（当前账号试链上第一个能用的），模型本身被拒就在同一个号上换下一个模型；整条链在这个号上都被禁了、或这个号被拒（凭据失效 / 余额见底 / 限流），才换到下一个账号。凭据只落在本机 ~/.dsh-workbuddy/。',
        loading: '正在加载…',
        loadFailed: '读不到插件后端',
        retry: '重试',
        login: '登录新账号',
        loginCn: '登录国内账号',
        loginIntl: '登录国际版账号',
        import: '导入 JSON',
        importPrompt: '粘贴凭据 JSON：{ accounts: [{ route: "codebuddy"|"workbuddy", auth: { accessToken, refreshToken }, account: { uid, nickname } }] }，也接受单个 { auth, account } 或裸数组。',
        importBadJson: 'JSON 解析失败：{reason}',
        importDone: '已导入 {imported} 个账号（新增 {created} 个）',
        importPartial: '已导入 {imported} 个（新增 {created}），跳过：{skipped}',
        importFailed: '导入失败：{reason}',
        importGo: '导入这些账号',
        export: '导出 JSON',
        exportHint: '导出账号与凭据（含 token，仅本机回环接口），可直接粘回「导入 JSON」或备份',
        exportDone: '已导出 workbuddy-accounts.json（并已复制到剪贴板）',
        exportFailed: '导出失败：{reason}',
        routeDisabled: '该路由未在 config.routes 中启用',
        partialTotals: '未刷全',
        loginStarting: '正在获取授权链接…',
        loginWaiting: '已打开官方授权页，等待授权完成…',
        loginHint: '若浏览器没有自动打开，点下面的链接完成登录。',
        openLink: '打开授权页',
        copyLink: '复制链接',
        copied: '已复制',
        loginDone: '登录成功，账号已加入列表。',
        loginFailed: '登录未完成：{reason}',
        loginTimeout: '等待超时，可以再点一次「登录新账号」。',
        cancel: '取消',
        accounts: '账号',
        empty: '还没有账号——点「登录新账号」，浏览器里完成一次官方授权即可。',
        active: '当前',
        setActive: '设为当前',
        remove: '移除',
        removeConfirm: '移除账号 {name}？它的凭据会一并从本机删除。',
        checkinNow: '立即签到',
        checkinAll: '全部签到',
        credits: '刷新余额',
        refreshGrowth: '刷新成长',
        refreshToken: '刷新凭据',
        working: '进行中…',
        credit: '积分',
        streak: '连登',
        todayCheckin: '今日签到',
        yes: '已签',
        no: '未签',
        never: '未记录',
        at: '{time}',
        daily: '每日自动积分',
        autoCheckin: '每天自动签到',
        autoActivity: '每天自动上报活跃（点亮连登）',
        autoGrowth: '顺带兑换连登档位与抽奖',
        autoRedeem: '自动兑换：刷新成长发现「可兑」档位时当场全部兑掉',
        growthStreak: '连登',
        growthRedeem: '兑换',
        growthLottery: '抽奖',
        growthActivity: '活跃',
        growthCredits: '余额',
        growthNone: '—',
        growthNoTier: '无可兑换档位',
        growthNoChance: '无抽奖次数',
        growthNeverRun: '今天还没跑',
        growthReported: '已上报',
        growthNotReported: '未上报',
        hours: '签到时点（北京时间，逗号分隔）',
        activityHours: '活跃时点（北京时间）',
        save: '保存设置',
        saved: '设置已保存',
        saveFailed: '保存失败：{reason}',
        resultOk: '完成：{message}',
        resultPartial: '部分账号未成功：{message}',
        resultFailed: '失败：{message}',
        refreshed: '凭据已刷新',
        noteIntl: '海外 WorkBuddy 平台没有这套成长接口，本页的积分功能只作用于国内账号。',
        lowCredit: '低于 {floor}，已停用聊天',
        accountBlocked: '今日禁用模型：{models}',
        gateTitle: '积分闸门',
        gateHint: '自己填一个数：已知余额低于它的账号自动换掉；全部低于就停止使用（签到回血后自动恢复）。填 0 = 关闭闸门。',
        gateLabel: '余额低于此值就换号',
        gateSave: '保存阈值',
        gateOn: '生效中 · 低于 {floor} 换号',
        gateOffTag: '已关闭',
        gateBelow: '踩线（低于阈值）{count} 个：{names}',
        gateSaved: '闸门阈值已保存：{floor}',
        gateOff: '闸门已关闭',
        routeCn: '国内',
        routeIntl: '海外',
        models: '模型与积分',
        modelsHint: '倍率来自上游按账号权限下发的模型表：x0.00 就是免费，其余按倍率折算积分。列表同步进模型选择器，名字后面直接带「免费」或「×0.29」。',
        refreshModels: '刷新价格表',
        modelsRefreshed: '价格表已刷新',
        modelsEmpty: '暂时读不到上游模型表（{reason}）',
        modelsFreeCount: '共 {total} 个模型，其中 {free} 个免费',
        free: '免费',
        thinking: '可思考',
        sectionCn: '国内账号',
        sectionIntl: '海外账号',
        accountCount: '个账号',
        emptyCn: '国内还没有账号——点上方「登录国内账号」。',
        emptyIntl: '海外还没有账号——点上方「登录国际版账号」。',
        contractWarn: '宿主契约对不上：{items}（已降级运行，不是故障）',
        chainTitle: '模型轮换顺序',
        chainHint: '自己挑 3–4 个模型，从上到下依次试。第一个被上游禁用（模型下线 / 该号无权限 / 限流）就自动轮到下一个；这条链在当前账号上全被禁掉，就自动换下一个账号，新账号从第 1 个模型重新试。',
        chainEmpty: '还没选模型 —— 从下面挑第 1 个。',
        chainAdd: '加一个模型',
        chainPick: '选择模型…',
        chainClose: '收起选择器',
        noCredit: '不消耗积分',
        chainFull: '已选满 4 个',
        chainSave: '保存轮换顺序',
        chainUp: '上移（更优先）',
        chainDown: '下移',
        chainRemove: '从链里移除',
        chainBlocked: '今日已被禁用',
        chainPicked: '已在轮换顺序里',
        chainUnblock: '清空今日禁用记录',
        chainUnblocked: '已清空今日模型禁用记录',
        hbLabel: '积分',
        hbTitle: '当前账号 {name}：{credits} 积分\n全部 {count} 个账号合计 {total}\n点击刷新余额',
        hbLow: '当前账号 {name} 余额 {credits}，低于闸门 {floor}',
        hbError: '读不到余额：{reason}',
        hbLoading: '读取中…',
        hbRefreshed: '余额已刷新：{credits}',
        hbSettingsHint: '打开 WorkBuddy 账号面板',
        panelClose: '关闭',
      },
      en: {
        'meta.title': 'WorkBuddy accounts',
        'meta.description': 'Sign in and manage several CodeBuddy / WorkBuddy accounts from Settings: switch the active one, read credits, and collect daily points automatically.',
        title: 'WorkBuddy accounts',
        sub: 'Sign in here — several accounts are fine. Call order: the model chain is tried first (the active account uses the first model it is allowed to use); when a model itself is refused, the same account moves to the next model in the chain. The account only rotates when the whole chain is disabled on it, or when the account itself is refused (bad credential / no credits / rate limited). Credentials stay on this machine under ~/.dsh-workbuddy/.',
        loading: 'Loading…',
        loadFailed: 'Cannot reach the plugin backend',
        retry: 'Retry',
        login: 'Add account',
        loginCn: 'Add domestic account',
        loginIntl: 'Add international account',
        import: 'Import JSON',
        importPrompt: 'Paste credential JSON: { accounts: [{ route: "codebuddy"|"workbuddy", auth: { accessToken, refreshToken }, account: { uid, nickname } }] } — a single { auth, account } or a bare array also works.',
        importBadJson: 'JSON parse failed: {reason}',
        importDone: 'Imported {imported} account(s) ({created} new)',
        importPartial: 'Imported {imported} ({created} new); skipped: {skipped}',
        importFailed: 'Import failed: {reason}',
        importGo: 'Import these accounts',
        export: 'Export JSON',
        exportHint: 'Export accounts and credentials (includes tokens; loopback-only route). Paste it back into Import, or keep it as a backup.',
        exportDone: 'Exported workbuddy-accounts.json (also copied to the clipboard)',
        exportFailed: 'Export failed: {reason}',
        routeDisabled: 'This route is not in config.routes',
        partialTotals: 'not refreshed',
        loginStarting: 'Getting the authorization link…',
        loginWaiting: 'The official authorization page is open — waiting for it to finish…',
        loginHint: 'If the browser did not open, use the link below.',
        openLink: 'Open authorization page',
        copyLink: 'Copy link',
        copied: 'Copied',
        loginDone: 'Signed in — the account was added.',
        loginFailed: 'Sign-in did not finish: {reason}',
        loginTimeout: 'Timed out waiting; press “Add account” again.',
        cancel: 'Cancel',
        accounts: 'Accounts',
        empty: 'No accounts yet — press “Add account” and finish one official authorization in the browser.',
        active: 'Active',
        setActive: 'Make active',
        remove: 'Remove',
        removeConfirm: 'Remove {name}? Its credentials are deleted from this machine.',
        checkinNow: 'Collect now',
        checkinAll: 'Collect all',
        credits: 'Refresh credits',
        refreshGrowth: 'Refresh growth',
        refreshToken: 'Refresh token',
        working: 'Working…',
        credit: 'Credits',
        streak: 'Streak',
        todayCheckin: 'Today',
        yes: 'Collected',
        no: 'Not yet',
        never: 'No record',
        at: '{time}',
        daily: 'Daily points',
        autoCheckin: 'Collect daily points automatically',
        autoActivity: 'Report daily activity (lights the streak)',
        autoGrowth: 'Also redeem streak tiers and draw the lottery',
        autoRedeem: 'Auto-redeem unlocked streak tiers on every growth refresh',
        growthStreak: 'Streak',
        growthRedeem: 'Redeem',
        growthLottery: 'Lottery',
        growthActivity: 'Activity',
        growthCredits: 'Balance',
        growthNone: '—',
        growthNoTier: 'No tier to redeem',
        growthNoChance: 'No draw left',
        growthNeverRun: 'Not run yet today',
        growthReported: 'reported',
        growthNotReported: 'not reported',
        hours: 'Collect hours (Beijing time, comma separated)',
        activityHours: 'Activity hours (Beijing time)',
        save: 'Save settings',
        saved: 'Settings saved',
        saveFailed: 'Save failed: {reason}',
        resultOk: 'Done: {message}',
        resultPartial: 'Some accounts failed: {message}',
        resultFailed: 'Failed: {message}',
        refreshed: 'Token refreshed',
        noteIntl: 'The overseas WorkBuddy platform has no growth domain; the points features here apply to domestic accounts only.',
        lowCredit: 'below {floor}, chat disabled',
        accountBlocked: 'disabled today: {models}',
        gateTitle: 'Credit gate',
        gateHint: 'Type a number: accounts whose known balance is below it are swapped out; when every account is below, the route stops until check-in restores them. 0 turns the gate off.',
        gateLabel: 'Swap out below this balance',
        gateSave: 'Save floor',
        gateOn: 'on · swap below {floor}',
        gateOffTag: 'off',
        gateBelow: '{count} account(s) below the floor: {names}',
        gateSaved: 'Gate floor saved: {floor}',
        gateOff: 'Gate turned off',
        routeCn: 'Domestic',
        routeIntl: 'Overseas',
        models: 'Models and credits',
        modelsHint: 'Multipliers come from the upstream model table issued for this account: x0.00 means free. The same list feeds the model picker, where the name carries “free” or “×0.29”.',
        refreshModels: 'Refresh price table',
        modelsRefreshed: 'Price table refreshed',
        modelsEmpty: 'The upstream model table is unavailable right now ({reason})',
        modelsFreeCount: '{total} models, {free} of them free',
        free: 'free',
        thinking: 'thinking',
        sectionCn: 'Domestic accounts',
        sectionIntl: 'Overseas accounts',
        accountCount: 'accounts',
        emptyCn: 'No domestic account yet — press “Add domestic account” above.',
        emptyIntl: 'No overseas account yet — press “Add international account” above.',
        contractWarn: 'Host contract mismatch: {items} (running degraded, not an error)',
        chainTitle: 'Model fallback order',
        chainHint: 'Pick 3–4 models; they are tried top to bottom. When one is disabled upstream (retired model / not allowed on this account / rate limited) the next one takes over; when the whole chain is disabled on the active account, the next account takes over and starts again from model 1.',
        chainEmpty: 'No model picked yet — choose the first one below.',
        chainAdd: 'Add a model',
        chainPick: 'Choose a model…',
        chainClose: 'Close the picker',
        noCredit: 'no credit cost',
        chainFull: 'Already 4',
        chainSave: 'Save order',
        chainUp: 'Move up (higher priority)',
        chainDown: 'Move down',
        chainRemove: 'Remove from chain',
        chainBlocked: 'disabled today',
        chainPicked: 'already in the chain',
        chainUnblock: 'Clear today\'s disables',
        chainUnblocked: 'Cleared today\'s model disables',
        hbLabel: 'credits',
        hbTitle: 'Active account {name}: {credits} credits\nAll {count} accounts: {total}\nClick to refresh',
        hbLow: 'Active account {name} has {credits}, under the floor {floor}',
        hbError: 'Cannot read balance: {reason}',
        hbLoading: 'loading…',
        hbRefreshed: 'Balance refreshed: {credits}',
        hbSettingsHint: 'Open the WorkBuddy account panel',
        panelClose: 'Close',
      },
    }

    /** 所有类名带 `wbk-` 前缀：永远不碰别人的样式。 */
    const CSS = `
.wbk-root { display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary); font-size: 12px; }
.wbk-sub { color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 1.55; max-width: 70ch; }
.wbk-card { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2)); border-radius: 9px; padding: 11px 12px; }
.wbk-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.wbk-between { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.wbk-title { font-size: 13px; font-weight: 600; margin: 0 0 3px; }
.wbk-btn { font: inherit; font-size: 11.5px; padding: 4px 9px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-button-elevated-fill, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-label-primary); cursor: pointer; transition: background .12s, border-color .12s, box-shadow .12s; }
.wbk-btn:hover { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-button-tool-bar-fill, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-brand-text, var(--dsw-alias-label-primary)); }
.wbk-btn:active { transform: translateY(.5px); }
.wbk-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.wbk-btn:disabled { opacity: .5; cursor: default; filter: grayscale(.3); }
.wbk-btn-primary { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); border-color: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); color: #fff; font-weight: 600; }
.wbk-btn-primary:hover { filter: brightness(1.08); border-color: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); }
.wbk-btn-danger { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.wbk-tag { font-size: 10px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.wbk-tag-active { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.wbk-tag-warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.wbk-total { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding-right: 14px; }
.wbk-account { display: flex; flex-direction: column; gap: 6px; padding: 9px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.wbk-account:first-child { border-top: none; }
.wbk-name { font-weight: 600; }
.wbk-meta { color: var(--dsw-alias-label-secondary); font-size: 11.5px; display: flex; gap: 10px; flex-wrap: wrap; }
.wbk-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.wbk-kv { display: inline-flex; align-items: baseline; gap: 4px; white-space: nowrap; }
.wbk-kv b { font-weight: 600; color: var(--dsw-alias-label-primary); }
.wbk-msg { font-size: 11.5px; }
.wbk-msg-ok { color: var(--dsw-alias-state-success-primary); }
.wbk-msg-err { color: var(--dsw-alias-state-error-primary); }
.wbk-msg-warn { color: var(--dsw-alias-state-warn-primary); }
.wbk-link { color: var(--dsw-alias-brand-primary); word-break: break-all; font-size: 11.5px; }
.wbk-field { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11.5px; }
.wbk-input { font: inherit; font-size: 11.5px; padding: 4px 7px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.wbk-input:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 0; border-color: var(--dsw-alias-brand-primary); }
.wbk-textarea { width: 100%; box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; padding: 8px 10px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); resize: vertical; }
.wbk-check { display: flex; align-items: center; gap: 6px; font-size: 11.5px; }
/* 浮层胶囊：shell.overlay 里 position:fixed，坐标由 HB_POS 定死 */
.wbk-float { position: fixed; max-width: none; overflow: visible; z-index: 60;
  cursor: grab; touch-action: none; display: inline-flex; align-items: center; gap: 4px; user-select: none; }
/* 拖动中：手型 + 全局禁选中，免得拖拽时把聊天内容刷蓝。 */
.wbk-float-dragging { cursor: grabbing; }
.wbk-float-dragging * { cursor: grabbing !important; user-select: none !important; }
.wbk-hb { font: inherit; display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-button-elevated-fill, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-label-secondary); cursor: pointer; white-space: nowrap; font-variant-numeric: tabular-nums; }
.wbk-hb:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-button-tool-bar-fill, var(--dsw-alias-bg-layer-1)); }
.wbk-hb:disabled { cursor: default; opacity: .7; }
.wbk-hb-num { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.wbk-hb-unit { font-size: 11px; color: var(--dsw-alias-label-caption); }
.wbk-hb-low { border-color: var(--dsw-alias-state-warn-primary); }
.wbk-hb-low .wbk-hb-num { color: var(--dsw-alias-state-warn-primary); }
.wbk-hb-err { color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.wbk-hb-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); flex: none; }
.wbk-hb-dot-busy { background: var(--dsw-alias-state-warn-primary); }
.wbk-panel-mask { position: fixed; inset: 0; z-index: 90; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.28)); backdrop-filter: var(--dsw-mask-blur, blur(2px)); }
.wbk-panel { display: flex; flex-direction: column; width: min(820px, calc(100vw - 48px)); max-height: min(760px, calc(100vh - 96px)); overflow: hidden; border-radius: var(--dsw-radius-panel, 14px); border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2, #fff); box-shadow: var(--dsw-elevation-prominent, 0 24px 64px rgba(0,0,0,.22)); }
.wbk-panel-head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.wbk-panel-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.wbk-panel-close { font: inherit; flex: none; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid transparent; border-radius: var(--dsw-radius-sm, 6px); background: 0 0; color: var(--dsw-alias-label-secondary); font-size: 16px; line-height: 1; cursor: pointer; transition: background .12s, color .12s, border-color .12s; }
.wbk-panel-close:hover { background: var(--dsw-alias-button-ghost-active-fill, var(--dsw-alias-bg-layer-1)); border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.wbk-panel-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 16px; }
.wbk-root-embedded { gap: 12px; }
.wbk-chain-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 13px; }
.wbk-chain-row:first-child { border-top: none; }
.wbk-chain-idx { width: 14px; flex: none; color: var(--dsw-alias-label-caption); font-size: 10.5px; font-variant-numeric: tabular-nums; text-align: right; }
.wbk-chain-name { flex: none; font-weight: 600; }
.wbk-chain-id { flex: 1; min-width: 0; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wbk-chain-btn { padding: 1px 6px; font-size: 11px; line-height: 16px; min-width: 0; }
.wbk-select { max-width: 100%; }
.wbk-model-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 11.5px; line-height: 17px; }
.wbk-model-badge { flex: none; display: inline-flex; align-items: center; justify-content: center; min-width: 30px; height: 16px; padding: 0 4px; border-radius: 3px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-caption); font-size: 10px; line-height: 1; font-variant-numeric: tabular-nums; box-sizing: border-box; }
.wbk-model-badge-free { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.wbk-model-id { flex: none; min-width: 118px; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.wbk-model-name { flex: none; min-width: 84px; color: var(--dsw-alias-label-primary); font-size: 11.5px; }
.wbk-model-ctx { flex: none; color: var(--dsw-alias-label-caption); font-size: 10.5px; }
.wbk-model-think { flex: none; color: var(--dsw-alias-label-caption); font-size: 10.5px; }
.wbk-chain-list { border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; padding: 4px 10px; background: var(--dsw-alias-bg-layer-1); }
.wbk-chain-line { display: flex; align-items: center; gap: 8px; padding: 4px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.wbk-chain-line:first-child { border-top: none; }
.wbk-chain-line .wbk-model-row { flex: 1; min-width: 0; padding: 0; }
.wbk-model-actions { flex: none; display: inline-flex; align-items: center; gap: 4px; }
.wbk-model-blocked .wbk-model-id { opacity: .6; }
.wbk-model-picker { max-height: 268px; overflow-y: auto; overscroll-behavior: contain; margin-top: 8px; padding: 4px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); }
.wbk-model-pick { font: inherit; width: 100%; box-sizing: border-box; border: 0; background: 0 0; border-radius: 6px; padding: 3px 6px; text-align: left; cursor: pointer; color: inherit; }
.wbk-model-pick:hover { background: var(--dsw-alias-button-ghost-active-fill, var(--dsw-alias-bg-layer-2)); }
.wbk-model-pick-on { opacity: .45; cursor: default; }
.wbk-model-pick:disabled { cursor: default; }
.wbk-model-pick:disabled:hover { background: 0 0; }
.wbk-model-add { flex: none; margin-left: auto; color: var(--dsw-alias-label-caption); font-size: 12px; }
.wbk-model-pick:hover .wbk-model-add { color: var(--dsw-alias-brand-primary); }
.wbk-chain-toolbar { margin-top: 12px; }
.wbk-chain-actions { margin-top: 10px; }
.wbk-gate { margin: 4px 0 8px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.wbk-gate-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.wbk-gate-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.wbk-gate-hint { margin: 2px 0 6px; }
.wbk-gate-input { width: 92px; }
.wbk-gate-warn { color: var(--dsw-alias-state-warn-primary); margin: 6px 0 0; }
.wbk-contract-warn { color: var(--dsw-alias-state-warn-primary); border-left: 2px solid var(--dsw-alias-state-warn-primary); padding-left: 8px; margin: 4px 0 8px; }
.wbk-hb-gear { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; margin-left: 2px; border-radius: 50%; font-size: 11px; line-height: 1; cursor: pointer; opacity: .8; transition: opacity .12s, transform .12s, background .12s; }
.wbk-hb-gear:hover, .wbk-hb-gear:focus-visible { opacity: 1; background: var(--dsw-alias-button-ghost-active-fill, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-brand-text, var(--dsw-alias-label-primary)); outline: none; }
`

    /**
     * 模型选择器的排序：
     *   0. 免费（free=true）
     *   1. DeepSeek 系列（deepseek-v3 / v4 / v4.1 / v4-pro …）
     *   2. 其余有明确单价的行，按单价升序
     *   3. 倍率未知（没有 credits 字段）和最底下的已知 0 价行
     *
     * 「未知倍率」永远沉到最下面 —— 那些是视频 / 图像模型，本来就不是聊天可选，
     * 混在最上面会把免费模型挤下去。
     */
    function pickerRank(row) {
      if (row?.free === true) return 0
      const id = String(row?.id ?? '').toLowerCase()
      const price = Number(row?.credits)
      const known = Number.isFinite(price) && price > 0
      // DeepSeek 排免费之后、其它收费之前；未知倍率的 DeepSeek 一样落在最下面
      if (id.startsWith('deepseek') && known === true) return 1
      if (known === true) return 2
      return 3
    }

    function sortModelsForPicker(rows) {
      return [...(rows ?? [])].sort((a, b) => {
        const byRank = pickerRank(a) - pickerRank(b)
        if (byRank !== 0) return byRank
        const pa = Number(a?.credits)
        const pb = Number(b?.credits)
        const byPrice = (Number.isFinite(pa) ? pa : 999) - (Number.isFinite(pb) ? pb : 999)
        if (byPrice !== 0) return byPrice
        return String(a?.id ?? '').localeCompare(String(b?.id ?? ''))
      })
    }

    /**
     * 一行模型信息：`[免费|×单价]  id  name  ctxK  可思考`。
     * 「模型与积分」清单和「模型轮换顺序」的选择器共用这一套排版。
     */
    function renderModelRow(row, t, options) {
      const opts = options ?? {}
      const price = row.credits === undefined || row.credits === null ? '?' : row.credits
      const cells = [
        h('span', { className: row.free === true ? 'wbk-model-badge wbk-model-badge-free' : 'wbk-model-badge' },
          row.free === true ? t('free') : '×' + price),
        h('span', { className: 'wbk-model-id' }, row.id ?? ''),
        h('span', { className: 'wbk-model-name' }, row.name ?? row.id ?? ''),
        row.contextWindow === undefined || row.contextWindow === null
          ? null
          : h('span', { className: 'wbk-model-ctx' }, Math.round(row.contextWindow / 1000) + 'K'),
        row.thinking === true ? h('span', { className: 'wbk-model-think' }, t('thinking')) : null,
      ].filter(Boolean)
      if (opts.trailing !== undefined && opts.trailing !== null) cells.push(opts.trailing)
      const className = ['wbk-model-row', opts.blocked === true ? 'wbk-model-blocked' : '', opts.className ?? '']
        .filter(part => part !== '')
        .join(' ')
      return h(opts.tag ?? 'div', { className, key: opts.key ?? row.id }, ...cells)
    }

    async function call(path, options = {}) {
      const response = await fetch(API + path, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: 'no-store',
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
      return payload
    }

    function parseHours(text, fallback) {
      const list = String(text ?? '')
        .split(/[,，\s]+/)
        .map(part => Number.parseInt(part, 10))
        .filter(value => Number.isFinite(value) && value >= 0 && value <= 23)
      return list.length > 0 ? [...new Set(list)].sort((a, b) => a - b) : fallback
    }
    /**
     * 账号池变更广播：面板里切号 / 删号 / 导入 / 签到 / 刷余额之后，
     * 胶囊要重新拉 /state 才能显示**新当前账号**的余额。
     * 面板和胶囊是 shell.overlay 上两个独立注册项，只能靠这个模块级信号串起来。
     */
    const accountsChanged = (() => {
      let version = 0
      const listeners = new Set()
      return {
        version: () => version,
        notify() {
          version += 1
          for (const fn of listeners) {
            try { fn(version) } catch {}
          }
        },
        subscribe(fn) {
          listeners.add(fn)
          return () => { listeners.delete(fn) }
        },
      }
    })()


    function SettingsPage(props) {
      const t = props.t ?? (key => key)
      const [state, setState] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [busy, setBusy] = useState(undefined)
      const [message, setMessage] = useState(undefined)
      const [login, setLogin] = useState(undefined)
      const [models, setModels] = useState(undefined)
      const [hours, setHours] = useState('')
      const [activityHours, setActivityHours] = useState('')
      // ⚠️ 所有 hook 必须在下面的提前 return 之前声明完：React 按调用顺序匹配 hook，
      // 若某个 useState 落在 `return` 之后，首次渲染（state 未就绪提前返回）少跑一个 hook，
      // 数据到齐后再渲染又多一个 → Minified React error #310，整个设置页白屏。
      const [importDraft, setImportDraft] = useState(undefined)
      // 功能 1 的草稿：undefined = 未编辑（显示生效值）；编辑中才用草稿值。
      const [chainDraft, setChainDraft] = useState(undefined)
      const [pickerOpen, setPickerOpen] = useState(false)
      const [gateDraft, setGateDraft] = useState(undefined)
      const pollRef = useRef(undefined)
      // 面板随时会被关掉（SettingsPage 卸载），async 回调 await 之后不能再往里写状态。
      const mounted = useRef(true)

      const load = useCallback(async () => {
        try {
          const next = await call('/state')
          if (mounted.current !== true) return
          setState(next)
          setError(undefined)
          setHours((next.settings?.checkinHours ?? []).join(','))
          setActivityHours((next.settings?.activityHours ?? []).join(','))
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
        // 价格表是附加信息：读不到也不该把整页变成「加载失败」。
        try {
          const rows = await call('/models')
          if (mounted.current !== true) return
          setModels(rows)
        } catch {
          /* 保持 undefined，页面显示占位 */
        }
      }, [])

      useEffect(() => {
        void load()
        return () => {
          mounted.current = false
          if (pollRef.current !== undefined) clearInterval(pollRef.current)
        }
      }, [load])

      const act = useCallback(
        async (path, body, label) => {
          setBusy(label)
          setMessage(undefined)
          try {
            const payload = await call(path, { body: body ?? {} })
            accountsChanged.notify()
            if (mounted.current !== true) return payload
            if (payload?.accounts !== undefined) setState(current => ({ ...(current ?? {}), ...payload }))
            else await load()
            const rows = payload?.result?.results
            if (Array.isArray(rows) && rows.length > 0) {
              const failed = rows.filter(row => row.ok !== true)
              setMessage({
                tone: failed.length === 0 ? 'ok' : failed.length === rows.length ? 'err' : 'warn',
                text: failed.length === 0
                  ? t('resultOk', { message: rows.map(row => `${row.name}: ${row.message}`).join('；') })
                  : t('resultPartial', { message: failed.map(row => `${row.name}: ${row.message}`).join('；') }),
              })
            }
            return payload
          } catch (cause) {
            if (mounted.current === true) setMessage({ tone: 'err', text: t('saveFailed', { reason: cause instanceof Error ? cause.message : String(cause) }) })
            return undefined
          } finally {
            if (mounted.current === true) setBusy(undefined)
          }
        },
        [load, t],
      )

      const startLogin = useCallback(async route => {
        setBusy('login')
        setMessage(undefined)
        try {
          const started = await call('/login', { body: { route } })
          if (mounted.current !== true) return
          setLogin({ ...started })
          if (pollRef.current !== undefined) clearInterval(pollRef.current)
          pollRef.current = setInterval(async () => {
            try {
              const status = await call(`/login/status?state=${encodeURIComponent(started.state)}`)
              if (mounted.current !== true) {
                clearInterval(pollRef.current)
                pollRef.current = undefined
                return
              }
              if (status.status === 'done') {
                clearInterval(pollRef.current)
                pollRef.current = undefined
                setLogin(undefined)
                setMessage({ tone: 'ok', text: t('loginDone') })
                await load()
              } else if (status.status === 'failed') {
                clearInterval(pollRef.current)
                pollRef.current = undefined
                setLogin(undefined)
                setMessage({ tone: 'err', text: t('loginFailed', { reason: status.message ?? status.status }) })
              } else if (status.url !== undefined && status.url !== login?.url) {
                setLogin(current => ({ ...(current ?? {}), ...status }))
              }
            } catch {
              /* 轮询失败就等下一轮 */
            }
          }, 1500)
        } catch (cause) {
          if (mounted.current === true) setMessage({ tone: 'err', text: t('loginFailed', { reason: cause instanceof Error ? cause.message : String(cause) }) })
        } finally {
          if (mounted.current === true) setBusy(undefined)
        }
      }, [load, login?.url, t])

      if (error !== undefined) {
        return h('div', { className: 'wbk-root' },
          h('div', { className: 'wbk-msg wbk-msg-err' }, `${t('loadFailed')}：${error}`),
          h('div', null, h('button', { className: 'wbk-btn', onClick: () => void load() }, t('retry'))))
      }
      if (state === undefined) return h('div', { className: 'wbk-root' }, t('loading'))

      const accounts = state.accounts ?? []
      const settings = state.settings ?? {}
      // 两条路由的**实际注册名**由 Host 下发（routeNames 改名后跟着变）；按钮仍用平台名点名。
      const routeNames = state.routeNames ?? {}
      const cnAvailable = routeNames.codebuddy !== undefined
      const intlAvailable = routeNames.workbuddy !== undefined
      // 功能 2：账号分栏——国内一栏、海外一栏，各栏独立显示「当前」与操作。
      const cnAccounts = accounts.filter(account => account.route !== 'workbuddy')
      const intlAccounts = accounts.filter(account => account.route === 'workbuddy')

      const saveChain = async () => {
        const modelsList = chainDraft ?? (state.chain?.models ?? [])
        const payload = await act('/settings', { modelChain: modelsList, modelChainEnabled: modelsList.length > 0 }, 'chain')
        if (mounted.current !== true) return
        if (payload !== undefined) setChainDraft(undefined)
      }

      const saveGate = async () => {
        const raw = gateDraft
        const floor = Math.max(0, Math.round(Number(raw === undefined ? (state.creditFloor ?? 0) : raw)))
        const payload = await act('/settings', { creditFloor: floor }, 'gate')
        if (mounted.current !== true) return
        if (payload === undefined) return
        setGateDraft(undefined)
        setMessage({ tone: 'ok', text: floor > 0 ? t('gateSaved', { floor }) : t('gateOff') })
      }

      /**
       * 积分闸门控件：用户自己填阈值，低于它就换号；0 = 关闭。
       * 显示当前生效值 + 有多少号踩线。
       */
      const gateCard = rows => {
        const floor = state.creditFloor ?? 0
        const draft = gateDraft
        const current = draft === undefined ? String(floor) : draft
        const below = rows.filter(account => {
          const credits = Number(account.credits)
          return Number.isFinite(credits) && floor > 0 && credits < floor
        })
        return h('div', { className: 'wbk-gate' },
          h('div', { className: 'wbk-gate-head' },
            h('span', { className: 'wbk-gate-title' }, t('gateTitle')),
            floor > 0
              ? h('span', { className: 'wbk-tag' }, t('gateOn', { floor }))
              : h('span', { className: 'wbk-tag wbk-tag-warn' }, t('gateOffTag'))),
          h('p', { className: 'wbk-sub wbk-gate-hint' }, t('gateHint')),
          h('div', { className: 'wbk-field' },
            h('span', null, t('gateLabel')),
            h('input', {
              className: 'wbk-input wbk-gate-input',
              type: 'number',
              min: 0,
              step: 1,
              value: current,
              onChange: event => setGateDraft(event.target.value),
            }),
            h('button', {
              className: 'wbk-btn wbk-btn-primary',
              disabled: busy !== undefined || gateDraft === undefined,
              onClick: () => void saveGate(),
            }, busy === 'gate' ? t('working') : t('gateSave')),
            gateDraft === undefined
              ? null
              : h('button', { className: 'wbk-btn', onClick: () => setGateDraft(undefined) }, t('cancel'))),
          floor > 0 && below.length > 0
            ? h('p', { className: 'wbk-sub wbk-gate-warn' }, t('gateBelow', { count: below.length, names: below.map((a, i) => displayName(a, i)).join('、') }))
            : null)
      }


      /**
       * 一个账号的卡片行（功能 2：两栏共用同一渲染器，只有外层分组不同）。
       * 阈值踩线时标出来（那正是它会被换掉的原因），被禁模型也逐个点名。
       */
      const accountRow = (account, index) => {
        const name = displayName(account, index)
        const floor = state.creditFloor ?? 0
        const credits = Number(account.credits)
        const belowFloor = floor > 0 && Number.isFinite(credits) && credits < floor
        const blocked = Object.keys(account.modelBlocked ?? {})
        return h('div', { className: 'wbk-account', key: account.id },
          h('div', { className: 'wbk-between' },
            h('div', { className: 'wbk-row' },
              h('span', { className: 'wbk-name' }, name),
              account.active === true ? h('span', { className: 'wbk-tag wbk-tag-active' }, t('active')) : null,
              account.hasRefreshToken !== true ? h('span', { className: 'wbk-tag wbk-tag-warn' }, 'no refresh token') : null,
              belowFloor === true ? h('span', { className: 'wbk-tag wbk-tag-warn' }, t('lowCredit', { floor })) : null,
              blocked.length > 0 ? h('span', { className: 'wbk-tag wbk-tag-warn' }, t('accountBlocked', { models: blocked.join('、') })) : null),
            h('div', { className: 'wbk-row' },
              account.active === true
                ? null
                : h('button', { className: 'wbk-btn', disabled: busy !== undefined, onClick: () => void act('/activate', { id: account.id }, 'activate') }, t('setActive')),
              h('button', { className: 'wbk-btn', disabled: busy !== undefined, onClick: () => void act('/checkin', { id: account.id }, 'checkin') }, t('checkinNow')),
              h('button', { className: 'wbk-btn', disabled: busy !== undefined, onClick: () => void act('/growth', { id: account.id }, 'growth') }, t('refreshGrowth')),
              h('button', { className: 'wbk-btn', disabled: busy !== undefined, onClick: () => void act('/credits', { id: account.id }, 'credits') }, t('credits')),
              h('button', { className: 'wbk-btn', disabled: busy !== undefined, onClick: () => void act('/refresh', { id: account.id }, 'refresh') }, t('refreshToken')),
              h('button', {
                className: 'wbk-btn wbk-btn-danger',
                disabled: busy !== undefined,
                onClick: () => {
                  if (window.confirm(t('removeConfirm', { name })) === true) {
                    void act('/remove', { id: account.id }, 'remove')
                  }
                },
              }, t('remove')))),
          h('div', { className: 'wbk-meta' },
            // 成长指标：连登 / 兑换 / 抽奖 / 活跃 / 余额。账号 UID 不展示。
            h('span', { className: 'wbk-kv' },
              h('b', null, t('growthStreak')), ' ', account.streakDays === undefined ? t('growthNone') : `${account.streakDays} 天`),
            h('span', { className: (account.lastRedeem?.ok === true ? 'wbk-kv wbk-msg-ok' : 'wbk-kv') },
              h('b', null, t('growthRedeem')), ' ',
              account.lastRedeem === undefined
                ? t('growthNeverRun')
                : (account.lastRedeem.message ?? (account.lastRedeem.count > 0 ? `已兑 ${account.lastRedeem.count} 档` : t('growthNoTier')))),
            h('span', { className: (account.lastLottery?.drawn > 0 ? 'wbk-kv wbk-msg-ok' : 'wbk-kv') },
              h('b', null, t('growthLottery')), ' ',
              account.lastLottery === undefined
                ? t('growthNeverRun')
                : (account.lastLottery.message ?? (account.lastLottery.chances > 0 ? `${account.lastLottery.drawn}/${account.lastLottery.chances}` : t('growthNoChance')))),
            h('span', { className: (account.lastActivity?.ok === true ? 'wbk-kv wbk-msg-ok' : 'wbk-kv') },
              h('b', null, t('growthActivity')), ' ',
              account.lastActivity === undefined
                ? t('growthNeverRun')
                : (account.lastActivity.ok === true ? t('growthReported') : t('growthNotReported'))),
            h('span', { className: 'wbk-kv' },
              h('b', null, t('growthCredits')), ' ', account.credits === undefined ? t('growthNone') : account.credits),
            h('span', { className: account.daily?.checkin !== undefined ? 'wbk-msg-ok' : '' },
              `${t('todayCheckin')}：${account.daily?.checkin !== undefined ? t('yes') : t('no')}`)))
      }

      const submitImport = async () => {
        const text = String(importDraft ?? '').trim()
        if (text === '') return
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch (cause) {
          setMessage({ tone: 'err', text: t('importBadJson', { reason: cause instanceof Error ? cause.message : String(cause) }) })
          return
        }
        setImportDraft(undefined)
        setMessage({ tone: 'ok', text: t('working') })
        try {
          const payload = await call('/import', { body: parsed })
          if (mounted.current !== true) return
          const skipped = payload?.skipped ?? []
          setMessage({
            tone: skipped.length === 0 ? 'ok' : 'warn',
            text: t(skipped.length === 0 ? 'importDone' : 'importPartial', {
              imported: payload?.imported ?? 0,
              created: payload?.created ?? 0,
              skipped: skipped.map(row => `${row.name}：${row.reason}`).join('；'),
            }),
          })
          await load()
        } catch (cause) {
          setMessage({ tone: 'err', text: t('importFailed', { reason: cause instanceof Error ? cause.message : String(cause) }) })
        }
      }

      // 导出：形状与导入一致，导出的文件可以粘回「导入 JSON」或拷给别家网关 / 做备份。
      const doExport = async () => {
        setMessage(undefined)
        try {
          const payload = await call('/export')
          if (mounted.current !== true) return
          const text = JSON.stringify(payload, undefined, 2)
          const name = 'workbuddy-accounts.json'
          try {
            const file = new File([text], name, { type: 'application/json' })
            if (navigator.canShare?.({ files: [file] }) === true) {
              await navigator.share({ files: [file], title: name })
              setMessage({ tone: 'ok', text: t('exportDone') })
              return
            }
          } catch { /* 分享不可用就退回下载 */ }
          const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = name
          anchor.click()
          // revoke 必须晚于下载真正开始：同步 revoke 会让部分内核把这次下载掐掉。
          setTimeout(() => URL.revokeObjectURL(url), 30_000)
          await navigator.clipboard?.writeText(text).catch(() => {})
          setMessage({ tone: 'ok', text: t('exportDone') })
        } catch (cause) {
          setMessage({ tone: 'err', text: t('exportFailed', { reason: cause instanceof Error ? cause.message : String(cause) }) })
        }
      }

      return h('div', { className: 'wbk-root' },
        h('div', null,
          h('p', { className: 'wbk-title' }, t('title')),
          h('p', { className: 'wbk-sub' }, t('sub')),
          // 宿主契约自检：有对不上的就摆出来（不影响使用，只是提示降级）
          (() => {
            const broken = hostContractReport().filter(row => row.ok !== true)
            if (broken.length === 0) return null
            return h('p', { className: 'wbk-sub wbk-contract-warn' },
              t('contractWarn', { items: broken.map(row => row.name).join('、') }))
          })(),
        // 总积分按平台分列：国内是国内的，国际是国际的。
        // `known < accounts` 时标成「部分」——没刷过余额的账号不能按 0 冒充总额。
        (() => {
          const totals = state.totals ?? {}
          const buckets = [
            ['codebuddy', t('routeCn')],
            ['workbuddy', t('routeIntl')],
          ].filter(([key]) => totals[key] !== undefined)
          if (buckets.length === 0) return null
          return h('div', { className: 'wbk-card wbk-row' }, buckets.map(([key, label]) => {
            const bucket = totals[key] ?? {}
            const partial = (bucket.known ?? 0) < (bucket.accounts ?? 0)
            return h('span', { className: 'wbk-total', key },
              h('b', null, label),
              ' ',
              bucket.known > 0 ? bucket.credits : '—',
              ' ',
              t('credit'),
              bucket.accounts !== undefined ? `（${bucket.known ?? 0}/${bucket.accounts}）` : '',
              partial ? h('span', { className: 'wbk-tag wbk-tag-warn' }, t('partialTotals')) : null)
          }))
        })()),

        h('div', { className: 'wbk-card wbk-between' },
          h('div', { className: 'wbk-row' },
            h('button', {
              className: 'wbk-btn wbk-btn-primary',
              disabled: busy !== undefined || cnAvailable !== true,
              onClick: () => void startLogin('codebuddy'),
            }, busy === 'login' ? t('loginStarting') : t('loginCn')),
            h('button', {
              className: 'wbk-btn',
              disabled: busy !== undefined || intlAvailable !== true,
              title: intlAvailable === true ? undefined : t('routeDisabled'),
              onClick: () => void startLogin('workbuddy'),
            }, busy === 'login' ? t('loginStarting') : t('loginIntl')),
            h('button', {
              className: 'wbk-btn',
              disabled: busy !== undefined,
              title: t('importPrompt'),
              onClick: () => setImportDraft(importDraft === undefined ? '' : undefined),
            }, t('import')),
            h('button', {
              className: 'wbk-btn',
              disabled: busy !== undefined || accounts.length === 0,
              title: t('exportHint'),
              onClick: () => void doExport(),
            }, t('export')),
            h('button', {
              className: 'wbk-btn',
              disabled: busy !== undefined || accounts.length === 0,
              onClick: () => void act('/checkin', {}, 'checkin'),
            }, busy === 'checkin' ? t('working') : t('checkinAll')),
            h('button', {
              className: 'wbk-btn',
              disabled: busy !== undefined || accounts.length === 0,
              onClick: () => void act('/credits', {}, 'credits'),
            }, busy === 'credits' ? t('working') : t('credits'))),
          h('span', { className: 'wbk-tag' }, (state.now?.date ?? '') + ' ' + String(state.now?.hour ?? '').padStart(2, '0') + ':00')),
        h('p', { className: 'wbk-sub wbk-msg' }, t('noteIntl')),

        login !== undefined
          ? h('div', { className: 'wbk-card' },
              h('p', { className: 'wbk-title' }, t('loginWaiting')),
              h('p', { className: 'wbk-sub' }, t('loginHint')),
              login.url !== undefined ? h('a', { className: 'wbk-link', href: login.url, target: '_blank', rel: 'noreferrer' }, login.url) : null,
              h('div', { className: 'wbk-row' },
                login.url !== undefined
                  ? h('button', { className: 'wbk-btn', onClick: () => window.open(login.url, '_blank', 'noopener') }, t('openLink'))
                  : null,
                login.url !== undefined
                  ? h('button', {
                      className: 'wbk-btn',
                      onClick: () => {
                        void navigator.clipboard?.writeText(login.url)
                        setMessage({ tone: 'ok', text: t('copied') })
                      },
                    }, t('copyLink'))
                  : null,
                h('button', { className: 'wbk-btn', onClick: () => { void call('/login/cancel', { body: { state: login.state } }); setLogin(undefined) } }, t('cancel'))))
          : null,

        // 导入面板：Electron 渲染端没有 window.prompt（点了会 unhandledrejection），
        // 所以粘贴框直接开在页面里。
        importDraft !== undefined
          ? h('div', { className: 'wbk-card' },
              h('p', { className: 'wbk-title' }, t('import')),
              h('p', { className: 'wbk-sub' }, t('importPrompt')),
              h('textarea', {
                className: 'wbk-textarea',
                rows: 8,
                spellcheck: false,
                placeholder: '{"accounts":[{"route":"codebuddy","auth":{"accessToken":"…"},"account":{"uid":"…","nickname":"…"}}]}',
                value: importDraft,
                onChange: event => setImportDraft(event.target.value),
              }),
              h('div', { className: 'wbk-row' },
                h('button', {
                  className: 'wbk-btn wbk-btn-primary',
                  disabled: busy !== undefined || String(importDraft).trim() === '',
                  onClick: () => void submitImport(),
                }, t('importGo')),
                h('button', { className: 'wbk-btn', onClick: () => setImportDraft(undefined) }, t('cancel'))))
          : null,

        message !== undefined
          ? h('p', { className: `wbk-msg ${message.tone === 'ok' ? 'wbk-msg-ok' : message.tone === 'warn' ? 'wbk-msg-warn' : 'wbk-msg-err'}` }, message.text)
          : null,

        // ── 模型轮换链：自选 3–4 个模型，按顺序 fallback；链在该号上被禁完就自动换号 ──
        (() => {
          const chainState = state.chain ?? {}
          const saved = Array.isArray(chainState.models) ? chainState.models : []
          const chain = chainDraft ?? saved
          const rows = models?.rows ?? []
          const known = new Map(rows.map(row => [row.id, row]))
          const blocked = new Set()
          for (const account of accounts) {
            for (const key of Object.keys(account.modelBlocked ?? {})) blocked.add(key)
          }
          const move = (index, delta) => {
            const next = [...chain]
            const to = index + delta
            if (to < 0 || to >= next.length) return
            const tmp = next[index]
            next[index] = next[to]
            next[to] = tmp
            setChainDraft(next)
          }
          const add = id => {
            if (id === "" || chain.includes(id) === true || chain.length >= 4) return
            setChainDraft([...chain, id])
          }
          const remove = id => setChainDraft(chain.filter(item => item !== id))
          const pickerRows = sortModelsForPicker(rows)

          return h('div', { className: 'wbk-card' },
            h('p', { className: 'wbk-title' }, t('chainTitle')),
            h('p', { className: 'wbk-sub' }, t('chainHint')),

            // 已选：按顺序列出来，↑↓ 调序、× 移除
            chain.length === 0
              ? h('p', { className: 'wbk-sub' }, t('chainEmpty'))
              : h('div', { className: 'wbk-chain-list' }, chain.map((id, index) => {
                const row = known.get(id) ?? { id: id, name: id }
                const isBlocked = blocked.has(id)
                return h('div', { className: 'wbk-chain-line', key: id },
                  h('span', { className: 'wbk-chain-idx' }, String(index + 1)),
                  renderModelRow(row, t, {
                    key: id + "-row",
                    blocked: isBlocked,
                    trailing: isBlocked === true
                      ? h('span', { className: 'wbk-tag wbk-tag-warn' }, t('chainBlocked'))
                      : null,
                  }),
                  h('span', { className: 'wbk-model-actions' },
                    h('button', {
                      className: 'wbk-btn wbk-chain-btn',
                      disabled: index === 0,
                      title: t('chainUp'),
                      onClick: () => move(index, -1),
                    }, '↑'),
                    h('button', {
                      className: 'wbk-btn wbk-chain-btn',
                      disabled: index === chain.length - 1,
                      title: t('chainDown'),
                      onClick: () => move(index, 1),
                    }, '↓'),
                    h('button', {
                      className: 'wbk-btn wbk-btn-danger wbk-chain-btn',
                      title: t('chainRemove'),
                      onClick: () => remove(id),
                    }, '×')))
              })),

            // 选择器：和「模型与积分」同一套排版，免费置顶，点一行就加进链
            h('div', { className: 'wbk-between wbk-chain-toolbar' },
              h('span', { className: 'wbk-sub' }, t('chainAdd')),
              h('button', {
                className: 'wbk-btn',
                disabled: chain.length >= 4,
                onClick: () => setPickerOpen(value => value !== true),
              }, chain.length >= 4 ? t('chainFull') : (pickerOpen === true ? t('chainClose') : t('chainPick')))),

            pickerOpen !== true || chain.length >= 4
              ? null
              : h('div', { className: 'wbk-model-picker' },
                pickerRows.length === 0
                  ? h('p', { className: 'wbk-sub' }, t('loading'))
                  : pickerRows.map(row => {
                    const inChain = chain.includes(row.id) === true
                    const full = inChain !== true && chain.length >= 4
                    return h('button', {
                      type: 'button',
                      key: 'pick-' + row.id,
                      className: 'wbk-model-row wbk-model-pick' + (inChain === true ? ' wbk-model-pick-on' : ''),
                      disabled: inChain === true || full,
                      title: inChain === true ? t('chainPicked') : undefined,
                      onClick: () => add(row.id),
                    },
                    h('span', { className: row.free === true ? 'wbk-model-badge wbk-model-badge-free' : 'wbk-model-badge' },
                      row.free === true ? t('free') : '×' + (row.credits === undefined || row.credits === null ? '?' : row.credits)),
                    h('span', { className: 'wbk-model-id' }, row.id),
                    h('span', { className: 'wbk-model-name' }, row.name ?? row.id),
                    row.contextWindow === undefined || row.contextWindow === null
                      ? null
                      : h('span', { className: 'wbk-model-ctx' }, Math.round(row.contextWindow / 1000) + 'K'),
                    row.thinking === true ? h('span', { className: 'wbk-model-think' }, t('thinking')) : null,
                    h('span', { className: 'wbk-model-add' }, inChain === true ? '✓' : (full === true ? '' : '+')))
                  })),

            h('div', { className: 'wbk-row wbk-chain-actions' },
              h('button', {
                className: 'wbk-btn wbk-btn-primary',
                disabled: busy !== undefined || chainDraft === undefined,
                onClick: () => void saveChain(),
              }, busy === 'chain' ? t('working') : t('chainSave')),
              h('button', {
                className: 'wbk-btn',
                disabled: busy !== undefined,
                onClick: () => {
                  setBusy('unblock')
                  void call('/unblock', { body: {} })
                    .then(payload => {
                      setState(current => ({ ...current, ...payload }))
                      setMessage({ tone: 'ok', text: t('chainUnblocked') })
                      accountsChanged.notify()
                    })
                    .catch(cause => setMessage({ tone: 'err', text: t('saveFailed', { reason: cause instanceof Error ? cause.message : String(cause) }) }))
                    .finally(() => setBusy(undefined))
                },
              }, busy === 'unblock' ? t('working') : t('chainUnblock'))))
        })(),

        // ── 功能 2：国内一栏、海外一栏；每栏各自显示当前与操作 ──────────────
        (() => {
          const sections = [['codebuddy', t('sectionCn'), cnAccounts], ['workbuddy', t('sectionIntl'), intlAccounts]]
          if (accounts.length === 0) {
            return h('div', { className: 'wbk-card' },
              h('p', { className: 'wbk-title' }, t('accounts')),
              h('p', { className: 'wbk-sub' }, t('empty')))
          }
          return sections.map(([key, label, rows]) => h('div', { className: 'wbk-card', key },
            h('div', { className: 'wbk-between' },
              h('p', { className: 'wbk-title' }, label),
              h('span', { className: 'wbk-tag' }, rows.length + ' ' + t('accountCount'))),
            key === 'codebuddy' ? gateCard(rows) : null,
            rows.length === 0
              ? h('p', { className: 'wbk-sub' }, key === 'workbuddy' ? t('emptyIntl') : t('emptyCn'))
              : rows.map((account, index) => accountRow(account, index))))
        })(),

        h('div', { className: 'wbk-card' },
          h('div', { className: 'wbk-between' },
            h('div', null,
              h('p', { className: 'wbk-title' }, t('models')),
              h('p', { className: 'wbk-sub' }, t('modelsHint'))),
            h('button', {
              className: 'wbk-btn',
              disabled: busy !== undefined,
              onClick: () => {
                setBusy('models')
                void call('/models?refresh=1')
                  .then(payload => { setModels(payload); setMessage({ tone: 'ok', text: t('modelsRefreshed') }) })
                  .catch(cause => setMessage({ tone: 'err', text: t('saveFailed', { reason: cause instanceof Error ? cause.message : String(cause) }) }))
                  .finally(() => setBusy(undefined))
              },
            }, busy === 'models' ? t('working') : t('refreshModels'))),
          models === undefined
            ? h('p', { className: 'wbk-sub' }, t('loading'))
            : (models.rows ?? []).length === 0
              ? h('p', { className: 'wbk-sub' }, t('modelsEmpty', { reason: models.error ?? '—' }))
              : h('div', null,
                  h('p', { className: 'wbk-sub' }, t('modelsFreeCount', {
                    free: (models.rows ?? []).filter(row => row.free === true).length,
                    total: (models.rows ?? []).length,
                  })),
                  sortModelsForPicker(models.rows)
                    .slice(0, 14)
                    .map(row => h('div', { className: 'wbk-model-row', key: row.id },
                      h('span', { className: row.free === true ? 'wbk-model-badge wbk-model-badge-free' : 'wbk-model-badge' },
                        row.free === true ? t('free') : '×' + (row.credits ?? '?')),
                      h('span', { className: 'wbk-model-id' }, row.id),
                      h('span', { className: 'wbk-model-name' }, row.name ?? ''),
                      row.contextWindow !== undefined && row.contextWindow !== null
                        ? h('span', { className: 'wbk-model-ctx' }, Math.round(row.contextWindow / 1000) + 'K')
                        : null,
                      row.thinking === true ? h('span', { className: 'wbk-model-think' }, t('thinking')) : null)))),

        h('div', { className: 'wbk-card' },
          h('p', { className: 'wbk-title' }, t('daily')),
          h('div', { className: 'wbk-field' },
            h('label', { className: 'wbk-check' },
              h('input', {
                type: 'checkbox',
                checked: settings.autoCheckin !== false,
                onChange: event => setState(current => ({ ...current, settings: { ...current.settings, autoCheckin: event.target.checked } })),
              }),
              t('autoCheckin'))),
          h('div', { className: 'wbk-field' },
            h('label', { className: 'wbk-check' },
              h('input', {
                type: 'checkbox',
                checked: settings.autoActivity !== false,
                onChange: event => setState(current => ({ ...current, settings: { ...current.settings, autoActivity: event.target.checked } })),
              }),
              t('autoActivity'))),
          h('div', { className: 'wbk-field' },
            h('label', { className: 'wbk-check' },
              h('input', {
                type: 'checkbox',
                checked: settings.autoGrowth !== false,
                onChange: event => setState(current => ({ ...current, settings: { ...current.settings, autoGrowth: event.target.checked } })),
              }),
              t('autoGrowth'))),
          h('div', { className: 'wbk-field' },
            h('label', { className: 'wbk-check' },
              h('input', {
                type: 'checkbox',
                checked: settings.autoRedeem !== false,
                onChange: event => setState(current => ({ ...current, settings: { ...current.settings, autoRedeem: event.target.checked } })),
              }),
              t('autoRedeem'))),
          h('div', { className: 'wbk-field' },
            h('span', null, t('hours')),
            h('input', { className: 'wbk-input', value: hours, onChange: event => setHours(event.target.value) })),
          h('div', { className: 'wbk-field' },
            h('span', null, t('activityHours')),
            h('input', { className: 'wbk-input', value: activityHours, onChange: event => setActivityHours(event.target.value) })),
          h('div', { className: 'wbk-row' },
            h('button', {
              className: 'wbk-btn',
              disabled: busy !== undefined,
              onClick: () => void act('/settings', {
                autoCheckin: settings.autoCheckin !== false,
                autoActivity: settings.autoActivity !== false,
                autoGrowth: settings.autoGrowth !== false,
                autoRedeem: settings.autoRedeem !== false,
                checkinHours: parseHours(hours, settings.checkinHours ?? [9, 21]),
                activityHours: parseHours(activityHours, settings.activityHours ?? [10]),
              }, 'settings').then(payload => { if (payload !== undefined) setMessage({ tone: 'ok', text: t('saved') }) }),
            }, t('save')))))
    }

    function localeTag(ctx) {
      try {
        const snapshot = typeof ctx.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx.locale?.getSnapshot?.()
        const value = snapshot?.active ?? ctx.locale?.locale
        return typeof value === 'string' ? value : document.documentElement.lang || 'zh'
      } catch {
        return 'zh'
      }
    }

    /**
     * 给 `t()` 补上 `{message}` 这类占位替换：字典里带了参数，读取时不能把它们原样吐出来。
     */
    function withParams(t) {
      return (key, params) => {
        const raw = t(key)
        if (typeof raw !== 'string' || params === undefined) return raw
        return raw.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''))
      }
    }

    /**
     * 余额胶囊（`shell.overlay` 里 position:fixed）。
     * 只在聊天视图里显示：会话切到别的 tab（轨迹等）、开设置页、或空白会话时自动隐藏。
     * 位置基线是 HB_POS（538,660）：输入框被撑高（多行 / 附件 / dock）时胶囊按高度增量上移，
     * 缩回单行自动落回原位 —— 始终不被输入框压住，其余时间不动。
     * 点胶囊 = 刷新余额（打一次上游 `/credits`）；点 ⚙ = 展开账号列表快速切号。
     * 数据每 5 秒拉一次 `/state`（纯本地 JSON，不打上游；页面在后台时暂停）。
     */
    /** 基线坐标：用户没拖过时胶囊待在这儿。 */
    const HB_POS = { x: 538, y: 660 }
    const HB_CAPSULE_H = 26
    /** 用户手动摆好的位置存这里；有值就完全接管，不再跟输入框走。 */
    const HB_POS_KEY = "dsh-workbuddy:capsule-pos"

    function loadSavedPos() {
      try {
        const raw = window.localStorage?.getItem(HB_POS_KEY)
        if (typeof raw !== "string" || raw === "") return undefined
        const parsed = JSON.parse(raw)
        if (Number.isFinite(parsed?.x) && Number.isFinite(parsed?.y)) return { x: Math.round(parsed.x), y: Math.round(parsed.y) }
      } catch {
        /* 隐私模式 / 存储被禁：当作没存过 */
      }
      return undefined
    }

    function savePos(pos) {
      try {
        window.localStorage?.setItem(HB_POS_KEY, JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }))
      } catch {
        /* 存储不可用：本次会话仍可拖，只是不持久 */
      }
    }

    function clearSavedPos() {
      try {
        window.localStorage?.removeItem(HB_POS_KEY)
      } catch {
        /* ignore */
      }
    }

    /**
     * 输入框那一整块（宿主的 `conversation.composer` 座位）。
     * 多行输入 / 附件 / dock 变高时它的 top 会往上走，胶囊跟着走。
     */
    function composerRect() {
      if (typeof document === 'undefined') return undefined
      const seat = document.querySelector('[data-composer-seat]')
      if (seat === null) return undefined
      const rect = seat.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return undefined
      return rect
    }

    function clampPos(pos) {
      const width = window.innerWidth || 1280
      const height = window.innerHeight || 800
      return {
        x: Math.min(Math.max(4, pos.x), Math.max(4, width - 96)),
        y: Math.min(Math.max(4, pos.y), Math.max(4, height - 34)),
      }
    }

    /**
     * 输入框「没被撑高」时的高度，作为增量基准。
     * 取观测到的最小值 —— 单行输入就是最小值，附件 / 多行 / dock 只会把它撑高。
     */
    let composerBaseHeight

    /**
     * 胶囊该待的位置 = 基线 HB_POS + 输入框撑高的增量（往上让）。
     *
     * - 单行输入：高度 == 基准 → 增量 0 → 胶囊就在 HB_POS（用户定下的位置，不会自己跑）
     * - 多行 / 附件 / dock 把输入框撑高 H：胶囊上移 H，始终不被输入框压住
     * - 缩回单行：增量归 0 → 胶囊自动落回 HB_POS
     * - 找不到输入框（宿主改结构）：直接用 HB_POS
     */
    /**
     * 胶囊位置：
     * - 用户拖过（存了位置）→ **完全固定**，不再跟输入框，窗口变化只做防出界
     * - 没拖过 → 基线 HB_POS + 输入框撑高的增量（老行为）
     */
    function anchorPos(pinned) {
      if (pinned !== undefined) return clampPos(pinned)
      const rect = composerRect()
      if (rect === undefined) return clampPos(HB_POS)
      const height = Math.round(rect.height)
      if (composerBaseHeight === undefined || height < composerBaseHeight) composerBaseHeight = height
      const grow = Math.max(0, height - composerBaseHeight)
      return clampPos({ x: HB_POS.x, y: HB_POS.y - grow })
    }

    /**
     * 账号对外显示的名字。**绝不暴露 UID / 内部 id**：
     *   1. 昵称有实义字符 → 用昵称
     *   2. 昵称只有空白（有些号昵称是一串空格）→ 用「账号 + 序号」
     *   3. 都没有 → 「未命名账号」
     * 序号按池内顺序给，同一次渲染内稳定。
     */
    function displayName(account, index) {
      const nick = typeof account?.nickname === 'string' ? account.nickname.trim() : ''
      if (nick !== '') return nick
      if (Number.isInteger(index)) return '账号 ' + (index + 1)
      return '未命名账号'
    }

    /**
     * 现在是不是「聊天界面」。
     *
     * 两条宿主契约各管一件事，**任何一条找不到都退化成「显示」而不是「隐藏」**——
     * 宿主升级改了 DOM 标记时，胶囊宁可多显示，也不要人间蒸发：
     *   · `[data-shortcut-modal="settings"]` 在 → 设置页开着 → 隐藏
     *   · `[data-chat-flow]` 找不到（宿主换了标记）→ 认为仍在聊天页 → 显示
     */
    /**
     * 宿主契约自检：插件用到的 DOM 标记有没有变。
     *
     * 这些标记是从 app.asar 里侦查出来的，不属于任何公开契约；宿主升级可能改掉。
     * 改了不会崩（各条都有降级路径），但会「静默失灵」，所以把结论显式摆到面板上，
     * 让升级后一眼能看见「哪条契约对不上」，而不是猜「胶囊怎么不见了」。
     *
     * @returns {Array<{name: string, ok: boolean, effect: string}>}
     */
    /**
     * 胶囊/刷新要盯的账号 = 最近激活的那个 active。
     * 每个路由各有一个 active；find(a => a.active === true) 命中的是数组顺序
     * 第一个——切了国内当前后它仍返回海外那个，缓存 key 不变 → 界面不刷新，
     * 点刷新刷的还是错账号。lastActiveAt 由 activate() 打时间戳。
     */
    function mostRecentActive(rows) {
      const actives = (rows ?? []).filter(row => row.active === true)
      return [...actives].sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0]
    }

    function hostContractReport() {
      if (typeof document === 'undefined') return []
      const checks = [
        {
          name: '[data-composer-seat]',
          ok: document.querySelector('[data-composer-seat]') !== null,
          effect: '胶囊跟随输入框（缺失时退回固定坐标 538,660）',
        },
        {
          name: '[data-chat-flow]',
          ok: document.querySelector('[data-chat-flow]') !== null,
          effect: '只在聊天页显示（缺失时恒为显示）',
        },
        (() => {
          // 弹窗没开时无法校验（元素本来就不存在），别误报；只有「弹窗开着但值不是
          // settings」才是真契约变更——那才是胶囊会浮到设置页上的场景。
          const modal = document.querySelector('[data-shortcut-modal]')
          const value = modal === null ? undefined : modal.getAttribute('data-shortcut-modal')
          const ok = modal === null || value === 'settings'
          return {
            name: ok || modal === null
              ? '[data-shortcut-modal="settings"]'
              : `[data-shortcut-modal="settings"]（宿主实际值 "${value}"）`,
            ok,
            effect: '设置弹窗开着时隐藏胶囊（弹窗没开时不校验，视为通过）',
          }
        })(),
      ]
      return checks
    }

    function isChatSurface() {
      if (typeof document === 'undefined') return false
      // 宿主任何 modal 弹窗（不管值是什么）开着都隐藏胶囊——值改名也不失灵。
      if (document.querySelector('[data-shortcut-modal]') !== null) return false
      const chat = document.querySelector('[data-chat-flow]')
      if (chat === null) return true          // 契约变了：别藏起来，宁可多显示
      if (typeof chat.checkVisibility === 'function') {
        return chat.checkVisibility({ checkVisibilityCSS: true, checkOpacity: false })
      }
      return chat.getClientRects().length > 0
    }
    /**
     * 面板开关：模块级状态，胶囊上的 ⚙ 和面板座位共享同一个值。
     * 两个座位都挂在 shell.overlay 上，但它们是各自独立的注册项，所以用这个小 store 串起来。
     */
    const panelStore = (() => {
      let open = false
      const listeners = new Set()
      return {
        get: () => open,
        set(next) {
          const value = next === true
          if (open === value) return
          open = value
          for (const fn of listeners) {
            try { fn(value) } catch {}
          }
        },
        subscribe(fn) {
          listeners.add(fn)
          return () => { listeners.delete(fn) }
        },
      }
    })()

    function usePanelOpen() {
      const [value, setValue] = useState(() => panelStore.get())
      useEffect(() => {
        const unsubscribe = panelStore.subscribe(next => setValue(next))
        return () => { unsubscribe() }
      }, [])
      return value
    }

    /**
     * 账号管理面板：点胶囊上的 ⚙ 直接弹出来，不用绕道宿主的设置页。
     * 内容就是设置页那一套（同一个 SettingsPage 组件），只是换了外框。
     * 关闭：点遮罩 / 右上角 × / Esc。
     */
    function AccountPanel(props) {
      const t = props.t ?? (key => key)
      const open = usePanelOpen()

      useEffect(() => {
        if (open !== true) return undefined
        const onKey = event => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            panelStore.set(false)
          }
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [open])

      if (open !== true) return null

      return h('div', {
        className: 'wbk-panel-mask',
        role: 'presentation',
        onClick: () => panelStore.set(false),
      },
      h('div', {
        className: 'wbk-panel',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('title'),
        onClick: event => event.stopPropagation(),
      },
      h('div', { className: 'wbk-panel-head' },
        h('span', { className: 'wbk-panel-title' }, t('title')),
        h('button', {
          type: 'button',
          className: 'wbk-panel-close',
          title: t('panelClose'),
          'aria-label': t('panelClose'),
          onClick: () => panelStore.set(false),
        }, '\u00d7')),
      h('div', { className: 'wbk-panel-body' },
        h(SettingsPage, { t, onClose: () => panelStore.set(false) }))))
    }


    function HeaderBalance(props) {
      const tp = props.t ?? (key => key)
      const [view, setView] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [busy, setBusy] = useState(false)
      // 用户摆好的位置（localStorage）优先；有值就固定，不再跟输入框走。
      const [pinned, setPinned] = useState(() => loadSavedPos())
      const [pos, setPos] = useState(() => anchorPos(loadSavedPos()))
      const [dragging, setDragging] = useState(false)
      const panelOpen = usePanelOpen()
      const [onChat, setOnChat] = useState(() => isChatSurface())
      const alive = useRef(true)
      const lastKey = useRef('')
      const posRef = useRef(pos)
      posRef.current = pos

      // ref 镜像：sync 回调是 effect 闭包，读不到最新 state。
      const pinnedRef = useRef(pinned)
      pinnedRef.current = pinned
      const dragRef = useRef(undefined)

      /** 拖动结束后统一落位：写 state + 写 localStorage（松手即固定）。 */
      const dropAt = useCallback(next => {
        if (alive.current !== true) return
        const placed = clampPos(next)
        dragRef.current = undefined
        setDragging(false)
        setPinned(placed)
        pinnedRef.current = placed
        setPos(placed)
        savePos(placed)
      }, [])

      /** 双击胶囊 = 回到默认位（清掉固定，恢复跟随输入框）。 */
      const resetPos = useCallback(() => {
        clearSavedPos()
        dragRef.current = undefined
        setDragging(false)
        setPinned(undefined)
        pinnedRef.current = undefined
        composerBaseHeight = undefined
        setPos(anchorPos(undefined))
      }, [])

      /** 指针按下即可拖：移动超过 3px 才算拖动（否则是点击刷新）。 */
      const onPointerDown = useCallback(event => {
        if (event.button !== undefined && event.button !== 0) return
        const origin = { x: event.clientX, y: event.clientY }
        const base = { x: pos.x, y: pos.y }
        dragRef.current = { origin, base, moved: false, id: event.pointerId }
        try {
          event.currentTarget.setPointerCapture?.(event.pointerId)
        } catch {
          /* 某些宿主会拒；不影响 document 级监听 */
        }
      }, [pos.x, pos.y])

      /** 拖拽期间的移动/松手挂在 window 上：指针甩出胶囊也不丢。 */
      useEffect(() => {
        const move = event => {
          const drag = dragRef.current
          if (drag === undefined) return
          const dx = event.clientX - drag.origin.x
          const dy = event.clientY - drag.origin.y
          if (drag.moved !== true && Math.abs(dx) + Math.abs(dy) < 3) return
          if (drag.moved !== true) {
            drag.moved = true
            setDragging(true)
          }
          const next = clampPos({ x: drag.base.x + dx, y: drag.base.y + dy })
          setPos(next)
        }
        const up = () => {
          const drag = dragRef.current
          if (drag === undefined) return
          if (drag.moved === true) {
            // 位置以当前 state 为准：读 ref 里的最新渲染值。
            dropAt(posRef.current)
          } else {
            dragRef.current = undefined
          }
        }
        window.addEventListener('pointermove', move, true)
        window.addEventListener('pointerup', up, true)
        window.addEventListener('pointercancel', up, true)
        return () => {
          window.removeEventListener('pointermove', move, true)
          window.removeEventListener('pointerup', up, true)
          window.removeEventListener('pointercancel', up, true)
        }
      }, [dropAt])

      const read = useCallback(async () => {
        const payload = await call('/state')
        if (alive.current !== true) return
        // 5 秒一轮，值没变就别触发重渲染（比的是「当前账号 + 它的余额 + 号池总数」）
        const active = mostRecentActive(payload?.accounts)
        const key = active === undefined
          ? '—'
          : active.id + ':' + String(active.credits) + ':' + String(active.creditsAt) + ':' + (payload.accounts?.length ?? 0)
        if (key !== lastKey.current) {
          lastKey.current = key
          setView(payload)
        }
        setError(undefined)
      }, [])

      // 面板里切了号 / 删了号 / 签了到 → 立刻重拉（不用等下一轮 5 秒）
      useEffect(() => {
        const unsubscribe = accountsChanged.subscribe(() => {
          read().catch(() => {})
        })
        return () => { unsubscribe() }
      }, [read])

      useEffect(() => {
        alive.current = true
        read().catch(reason => { if (alive.current === true) setError(reason?.message ?? String(reason)) })
        // 每 5 秒刷一次余额。/state 是纯本地 JSON（不打上游），成本可忽略；
        // 页面在后台时停摆，切回前台立刻补一次，避免空转。
        const tick = () => {
          if (typeof document !== 'undefined' && document.hidden === true) return
          read().catch(() => {})
        }
        const timer = setInterval(tick, 5_000)
        const onVisible = () => {
          if (typeof document !== 'undefined' && document.hidden !== true) read().catch(() => {})
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        const onResize = () => { setPos(anchorPos()) }
        window.addEventListener('resize', onResize)
        return () => {
          alive.current = false
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
          window.removeEventListener('resize', onResize)
        }
      }, [read])

      // 跟着输入框走：ResizeObserver 订 composer 座位（多行输入 / 附件 / dock 都会改它的高度），
      // 再订它的祖先滚动容器（窗口缩放、侧栏收展也会改位置）。找不到宿主就退回轮询兜底。
      useEffect(() => {
        let raf = 0
        let ro
        let last = ''
        const sync = () => {
          raf = 0
          if (alive.current !== true) return
          const next = anchorPos(pinnedRef.current)
          const key = next.x + ',' + next.y
          if (key === last) return
          last = key
          setPos(next)
        }
        const schedule = () => {
          if (raf !== 0) return
          raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(sync) : setTimeout(sync, 16)
        }

        const seat = typeof document === 'undefined' ? null : document.querySelector('[data-composer-seat]')
        if (seat !== null && typeof ResizeObserver !== 'undefined') {
          ro = new ResizeObserver(schedule)
          ro.observe(seat)
          let parent = seat.parentElement
          for (let depth = 0; depth < 3 && parent !== null; depth += 1) {
            ro.observe(parent)
            parent = parent.parentElement
          }
        }
        if (seat !== null) seat.addEventListener('transitionend', schedule, true)
        window.addEventListener('scroll', schedule, true)
        // 兜底：以上都失灵时每 500ms 校一次（只读一个 rect，代价可忽略）
        const poll = setInterval(schedule, 500)
        schedule()

        return () => {
          if (raf !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf)
          if (ro !== undefined) ro.disconnect()
          if (seat !== null) seat.removeEventListener('transitionend', schedule, true)
          window.removeEventListener('scroll', schedule, true)
          clearInterval(poll)
        }
      }, [])

      // 跟随「当前是不是聊天界面」：视图切换 / 设置页开关 / 会话切换都会改 DOM。
      // MutationObserver 只订 childList（视图挂载/卸载、portal 出现）+ 两个标记属性，
      // 不订 class/style —— 聊天流式渲染会疯狂改 class，订上就成性能坑。变化后合并到一帧再判。
      useEffect(() => {
        let queued = 0
        const apply = () => {
          queued = 0
          if (alive.current !== true) return
          const next = isChatSurface()
          setOnChat(current => (current === next ? current : next))
        }
        const schedule = () => {
          if (queued !== 0) return
          queued = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(apply)
            : setTimeout(apply, 16)
        }
        apply()
        if (typeof MutationObserver === 'undefined') return undefined
        const observer = new MutationObserver(schedule)
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-chat-flow', 'data-shortcut-modal'],
        })
        return () => {
          if (queued !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(queued)
          observer.disconnect()
        }
      }, [])


      const refresh = useCallback(async () => {
        setBusy(true)
        try {
          const active = mostRecentActive(view?.accounts)
          await call('/credits', { body: active === undefined ? {} : { id: active.id } })
          await read()
        } catch (reason) {
          setError(reason?.message ?? String(reason))
        } finally {
          if (alive.current === true) setBusy(false)
        }
      }, [view, read])


      const accounts = view?.accounts ?? []
      // 每个路由各有一个 active；胶囊跟「最近激活」的那个走——刚切完号立刻对。
      const activeAccounts = accounts.filter(account => account.active === true)
      const active = mostRecentActive(accounts)
      // 合计跟着当前账号的平台走：切到国际号就显示国际合计，不是永远国内。
      const total = (active === undefined ? undefined : view?.totals?.[active.route === 'workbuddy' ? 'workbuddy' : 'codebuddy']?.credits)
        ?? view?.totals?.codebuddy?.credits
      const credits = typeof active?.credits === 'number' ? active.credits : undefined
      const floor = view?.creditFloor
      const low = typeof credits === 'number' && typeof floor === 'number' && floor > 0 && credits < floor
      const shown = typeof credits === 'number' ? Math.round(credits) : '—'

      const hint = [
        tp('hbTitle', { name: active?.nickname ?? '—', credits: shown, count: accounts.length, total: Math.round(total ?? 0) }),
        // 跨路由各有当前账号时逐个点名，别让人猜「这数字是谁的」。
        ...activeAccounts
          .filter(row => row.id !== active?.id)
          .map(row => {
            const label = row.route === 'workbuddy' ? '国际' : '国内'
            const value = Number.isFinite(Number(row.credits)) ? Math.round(Number(row.credits)) : '—'
            return `当前（${label}）${row.nickname ?? row.uid ?? row.id}：${value} 积分`
          }),
        low === true ? tp('hbLow', { name: active?.nickname ?? '—', credits: shown, floor }) : undefined,
        error === undefined ? undefined : tp('hbError', { reason: error }),
      ].filter(Boolean).join('\n')

      // 不在聊天界面就整块不渲染（连带菜单一起消失）
      if (onChat !== true || panelOpen === true) return null

      if (view === undefined) {
        if (error === undefined) return null
        return h('div', { className: 'wbk-float', style: { left: pos.x + 'px', top: pos.y + 'px' } },
          h('span', { className: 'wbk-hb-err', title: tp('hbError', { reason: error }) }, tp('hbError', { reason: error })))
      }

      return h('div', {
        className: dragging === true ? 'wbk-float wbk-float-dragging' : 'wbk-float',
        style: { left: pos.x + 'px', top: pos.y + 'px' },
        title: hint,
        // 拖动：按下即抓，移动超过 3px 才算拖（否则照旧是点击刷新）。
        onPointerDown,
        // 双击 = 回到默认位并解除固定（恢复跟随输入框）。
        onDoubleClick: event => {
          event.stopPropagation()
          resetPos()
        },
      },
      h('span', {
        className: low === true ? 'wbk-hb wbk-hb-low' : 'wbk-hb',
        role: 'button',
        tabIndex: 0,
        // 拖动刚结束的 pointerup 不该触发刷新：看 dragRef 是否刚清掉移动标记。
        onClick: () => {
          if (dragRef.current?.moved === true) return
          void refresh()
        },
        onKeyDown: event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            void refresh()
          }
        },
      },
      h('span', { className: busy ? 'wbk-hb-dot wbk-hb-dot-busy' : 'wbk-hb-dot' }),
      h('span', { className: 'wbk-hb-num' }, busy ? tp('hbLoading') : String(shown)),
      h('span', { className: 'wbk-hb-unit' }, tp('hbLabel')),
      h('span', {
        className: 'wbk-hb-gear',
        role: 'button',
        tabIndex: 0,
        title: tp('hbSettingsHint'),
        onClick: event => {
          event.stopPropagation()
          panelStore.set(panelStore.get() !== true)
        },
        onKeyDown: event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            panelStore.set(panelStore.get() !== true)
          }
        },
      }, '⚙')))
    }


    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'dsh-workbuddy: dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-workbuddy')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-workbuddy: styles')

      // 座位一：设置页里追加一页。列表式槽位，纯追加，不遮蔽宿主或其它插件。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'workbuddy',
        order: 36,
        label: () => t('title'),
        locale: NS,
      }, props => h(SettingsPage, { ...props, t: Object.assign(withParams(t), { locale: localeTag(ctx) }) })))

      // 座位二：可拖动的余额胶囊。挂 shell.overlay（root 级 list，position:fixed），
      // 不再受 header 布局约束 —— 拖到哪就是哪，坐标存 localStorage。
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'workbuddy-balance',
        order: 10,
        locale: NS,
      }, props => h(HeaderBalance, { ...props, t: withParams(t) })))

      // 座位三：账号管理面板。点胶囊上的 ⚙ 弹出来，直接管账号，不用开宿主设置页。
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'workbuddy-panel',
        order: 20,
        locale: NS,
      }, props => h(AccountPanel, { ...props, t: withParams(t) })))
    }

    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  },
})
