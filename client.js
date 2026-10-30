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
        sub: '国内账号在这里登录，可登录多个；模型调用使用「当前账号」，被上游拒绝时自动轮换。凭据只落在本机 ~/.dsh-workbuddy/。',
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
        refreshToken: '刷新凭据',
        working: '进行中…',
        uid: 'UID',
        credit: '积分',
        streak: '连登',
        todayCheckin: '今日签到',
        yes: '已签',
        no: '未签',
        never: '未记录',
        lastResult: '上次结果：{message}',
        at: '{time}',
        daily: '每日自动积分',
        autoCheckin: '每天自动签到',
        autoActivity: '每天自动上报活跃（点亮连登）',
        autoGrowth: '顺带兑换连登档位与抽奖',
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
        neverRan: '今天还没跑',
        lowCredit: '低于 {floor}，已停用聊天',
        floorNote: '积分闸门：已知余额低于 {floor} 的账号自动跳过并切换；全部低于则停止使用（签到回血后自动恢复）。改配置里的 creditFloor，0 关闭。',
        routeCn: '国内',
        routeIntl: '海外',
        usageLast: '上次消耗 {credit} 积分（{model}）',
        packages: '积分包：{list}',
        models: '模型与积分',
        modelsHint: '倍率来自上游按账号权限下发的模型表：x0.00 就是免费，其余按倍率折算积分。列表同步进模型选择器，名字后面直接带「免费」或「×0.29」。',
        refreshModels: '刷新价格表',
        modelsRefreshed: '价格表已刷新',
        modelsEmpty: '暂时读不到上游模型表（{reason}）',
        modelsFreeCount: '共 {total} 个模型，其中 {free} 个免费',
        free: '免费',
        thinking: '可思考',
      },
      en: {
        'meta.title': 'WorkBuddy accounts',
        'meta.description': 'Sign in and manage several CodeBuddy / WorkBuddy accounts from Settings: switch the active one, read credits, and collect daily points automatically.',
        title: 'WorkBuddy accounts',
        sub: 'Sign in here — several accounts are fine. Model calls use the active account and rotate automatically when upstream refuses it. Credentials stay on this machine under ~/.dsh-workbuddy/.',
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
        refreshToken: 'Refresh token',
        working: 'Working…',
        uid: 'UID',
        credit: 'Credits',
        streak: 'Streak',
        todayCheckin: 'Today',
        yes: 'Collected',
        no: 'Not yet',
        never: 'No record',
        lastResult: 'Last result: {message}',
        at: '{time}',
        daily: 'Daily points',
        autoCheckin: 'Collect daily points automatically',
        autoActivity: 'Report daily activity (lights the streak)',
        autoGrowth: 'Also redeem streak tiers and draw the lottery',
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
        neverRan: 'Not run yet today',
        lowCredit: 'below {floor}, chat disabled',
        floorNote: 'Credit floor: accounts whose known balance is under {floor} are skipped and the pool rotates; when all are under, the route stops (check-in still restores them). Set config.creditFloor; 0 disables.',
        routeCn: 'Domestic',
        routeIntl: 'Overseas',
        usageLast: 'Last call used {credit} credits ({model})',
        packages: 'Credit packs: {list}',
        models: 'Models and credits',
        modelsHint: 'Multipliers come from the upstream model table issued for this account: x0.00 means free. The same list feeds the model picker, where the name carries “free” or “×0.29”.',
        refreshModels: 'Refresh price table',
        modelsRefreshed: 'Price table refreshed',
        modelsEmpty: 'The upstream model table is unavailable right now ({reason})',
        modelsFreeCount: '{total} models, {free} of them free',
        free: 'free',
        thinking: 'thinking',
      },
    }

    /** 所有类名带 `wbk-` 前缀：永远不碰别人的样式。 */
    const CSS = `
.wbk-root { display: flex; flex-direction: column; gap: 18px; color: var(--dsw-alias-label-primary); }
.wbk-sub { color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.6; max-width: 68ch; }
.wbk-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 10px; padding: 14px; }
.wbk-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.wbk-between { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.wbk-title { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
.wbk-btn { font: inherit; font-size: 13px; padding: 5px 10px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; }
.wbk-btn:hover { border-color: var(--dsw-alias-brand-primary); }
.wbk-btn:disabled { opacity: .55; cursor: default; }
.wbk-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; }
.wbk-btn-danger { color: var(--dsw-alias-state-error-primary); }
.wbk-tag { font-size: 11px; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.wbk-tag-active { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.wbk-tag-warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.wbk-account { display: flex; flex-direction: column; gap: 8px; padding: 12px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.wbk-account:first-child { border-top: none; }
.wbk-name { font-weight: 600; }
.wbk-meta { color: var(--dsw-alias-label-secondary); font-size: 12.5px; display: flex; gap: 12px; flex-wrap: wrap; }
.wbk-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.wbk-msg { font-size: 12.5px; }
.wbk-msg-ok { color: var(--dsw-alias-state-success-primary); }
.wbk-msg-err { color: var(--dsw-alias-state-error-primary); }
.wbk-msg-warn { color: var(--dsw-alias-state-warn-primary); }
.wbk-link { color: var(--dsw-alias-brand-primary); word-break: break-all; font-size: 12.5px; }
.wbk-field { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; }
.wbk-input { font: inherit; font-size: 13px; padding: 5px 8px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.wbk-textarea { width: 100%; box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; padding: 8px 10px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); resize: vertical; }
.wbk-check { display: flex; align-items: center; gap: 8px; font-size: 13px; }
`

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
      const pollRef = useRef(undefined)

      const load = useCallback(async () => {
        try {
          const next = await call('/state')
          setState(next)
          setError(undefined)
          setHours((next.settings?.checkinHours ?? []).join(','))
          setActivityHours((next.settings?.activityHours ?? []).join(','))
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
        // 价格表是附加信息：读不到也不该把整页变成「加载失败」。
        try {
          setModels(await call('/models'))
        } catch {
          /* 保持 undefined，页面显示占位 */
        }
      }, [])

      useEffect(() => {
        void load()
        return () => {
          if (pollRef.current !== undefined) clearInterval(pollRef.current)
        }
      }, [load])

      const act = useCallback(
        async (path, body, label) => {
          setBusy(label)
          setMessage(undefined)
          try {
            const payload = await call(path, { body: body ?? {} })
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
            setMessage({ tone: 'err', text: t('saveFailed', { reason: cause instanceof Error ? cause.message : String(cause) }) })
            return undefined
          } finally {
            setBusy(undefined)
          }
        },
        [load, t],
      )

      const startLogin = useCallback(async route => {
        setBusy('login')
        setMessage(undefined)
        try {
          const started = await call('/login', { body: { route } })
          setLogin({ ...started })
          if (pollRef.current !== undefined) clearInterval(pollRef.current)
          pollRef.current = setInterval(async () => {
            try {
              const status = await call(`/login/status?state=${encodeURIComponent(started.state)}`)
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
          setMessage({ tone: 'err', text: t('loginFailed', { reason: cause instanceof Error ? cause.message : String(cause) }) })
        } finally {
          setBusy(undefined)
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

      const [importDraft, setImportDraft] = useState(undefined)

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
          h('p', { className: 'wbk-sub' }, t('sub'))),

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
          h('span', { className: 'wbk-tag' }, t('uid') + '：' + (state.now?.date ?? '') + ' ' + String(state.now?.hour ?? '').padStart(2, '0') + ':00')),
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

        h('div', { className: 'wbk-card' },
          h('p', { className: 'wbk-title' }, t('accounts')),
          // 有闸门时说明一次规则，用户看见「低于 X 自动切」不是猜的。
          (state.creditFloor ?? 0) > 0 ? h('p', { className: 'wbk-sub' }, t('floorNote', { floor: state.creditFloor })) : null,
          accounts.length === 0 ? h('p', { className: 'wbk-sub' }, t('empty')) : null,
          accounts.map(account => h('div', { className: 'wbk-account', key: account.id },
            h('div', { className: 'wbk-between' },
              h('div', { className: 'wbk-row' },
                h('span', { className: 'wbk-name' }, account.nickname ?? account.uid ?? account.id),
                account.active === true ? h('span', { className: 'wbk-tag wbk-tag-active' }, t('active')) : null,
                account.hasRefreshToken !== true ? h('span', { className: 'wbk-tag wbk-tag-warn' }, 'no refresh token') : null),
              h('div', { className: 'wbk-row' },
                account.active === true
                  ? null
                  : h('button', { className: 'wbk-btn', disabled: busy !== undefined, onClick: () => void act('/activate', { id: account.id }, 'activate') }, t('setActive')),
                h('button', { className: 'wbk-btn', disabled: busy !== undefined, onClick: () => void act('/checkin', { id: account.id }, 'checkin') }, t('checkinNow')),
                h('button', { className: 'wbk-btn', disabled: busy !== undefined, onClick: () => void act('/credits', { id: account.id }, 'credits') }, t('credits')),
                h('button', { className: 'wbk-btn', disabled: busy !== undefined, onClick: () => void act('/refresh', { id: account.id }, 'refresh') }, t('refreshToken')),
                h('button', {
                  className: 'wbk-btn wbk-btn-danger',
                  disabled: busy !== undefined,
                  onClick: () => {
                    if (window.confirm(t('removeConfirm', { name: account.nickname ?? account.uid ?? account.id })) === true) {
                      void act('/remove', { id: account.id }, 'remove')
                    }
                  },
                }, t('remove')))),
            h('div', { className: 'wbk-meta' },
              h('span', { className: 'wbk-tag' }, account.route === 'workbuddy' ? t('routeIntl') : t('routeCn')),
              h('span', { className: 'wbk-mono' }, `${t('uid')} ${account.uid ?? '—'}`),
              h('span', null, `${t('credit')} ${account.credits === undefined ? '—' : account.credits}`),
              // 余额低于闸门：模型车道已经不再用它（签到照常）。
              account.creditLow === true ? h('span', { className: 'wbk-tag wbk-tag-warn' }, t('lowCredit', { floor: state.creditFloor ?? '?' })) : null,
              h('span', null, `${t('streak')} ${account.streakDays ?? '—'}`),
              h('span', { className: account.daily?.checkin !== undefined ? 'wbk-msg-ok' : '' },
                `${t('todayCheckin')}：${account.daily?.checkin !== undefined ? t('yes') : t('no')}`)),
            // 上一次调用真实扣掉的积分（上游末帧 usage.credit，免费模型就是 0）。
            account.lastUsage
              ? h('div', { className: 'wbk-msg wbk-sub' },
                  `${t('usageLast', { model: account.lastUsage.model ?? '—', credit: account.lastUsage.credit ?? '?' })}`
                  + (account.lastUsage.inputTokens !== undefined
                    ? ` · ${account.lastUsage.inputTokens}→${account.lastUsage.outputTokens ?? 0} tok`
                    : ''))
              : null,
            // 积分按资源包到期作废：还剩多少 + 哪个包先到期，一起显示。
            (account.creditPackages ?? []).length > 0
              ? h('div', { className: 'wbk-msg wbk-sub' },
                  t('packages', {
                    list: (account.creditPackages ?? [])
                      .map(row => `${row.name ?? '资源包'} ${row.remain}${row.expiresAt ? `（到 ${String(row.expiresAt).slice(0, 10)}）` : ''}`)
                      .join(' · '),
                  }))
              : null,
            account.lastCheckin
              ? h('div', { className: account.lastCheckin.ok === true ? 'wbk-msg wbk-msg-ok' : 'wbk-msg wbk-msg-err' },
                  t('lastResult', { message: account.lastCheckin.message ?? '—' }))
              : h('div', { className: 'wbk-msg wbk-sub' }, t('neverRan'))))),

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
                  [...(models.rows ?? [])]
                    .sort((a, b) => (a.credits ?? 99) - (b.credits ?? 99))
                    .slice(0, 14)
                    .map(row => h('div', { className: 'wbk-meta', key: row.id },
                      h('span', { className: row.free === true ? 'wbk-tag wbk-tag-active' : 'wbk-tag' }, row.free === true ? t('free') : `×${row.credits ?? '?'}`),
                      h('span', { className: 'wbk-mono' }, row.id),
                      h('span', null, row.name ?? ''),
                      row.contextWindow !== undefined ? h('span', null, `${Math.round(row.contextWindow / 1000)}K`) : null,
                      row.thinking === true ? h('span', null, t('thinking')) : null)))),

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

      // 唯一的座位：设置页里追加一页。列表式槽位，纯追加，不遮蔽宿主或其它插件。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'workbuddy',
        order: 36,
        label: () => t('title'),
        locale: NS,
      }, props => h(SettingsPage, { ...props, t: Object.assign(withParams(t), { locale: localeTag(ctx) }) })))
    }

    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  },
})