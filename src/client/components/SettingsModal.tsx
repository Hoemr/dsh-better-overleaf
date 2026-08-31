/**
 * The settings modal: account connection (browser login, pasted cookie, git
 * token, with the how-to text folded away) plus the auto-sync policy. All the
 * explanation that used to fill the first screen lives behind <details>
 * disclosures in here.
 */
import { useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { OverleafAutoSyncPolicy, OverleafLoginResult } from '../../types.ts'
import { BORDER, LABEL_2, LABEL_3, OK, button, input, meta, pill, primary, row } from './tokens.ts'

export type LoginChannel = 'auto' | 'default' | 'msedge' | 'chrome' | 'custom' | 'real'

export interface SettingsModalProps {
  loggedIn: boolean
  gitConfigured: boolean
  busy: boolean
  policy: OverleafAutoSyncPolicy
  manualLogin: OverleafLoginResult | null
  latexmkAvailable: boolean
  onClose: () => void
  onLogin: (channel: LoginChannel, customPath: string) => void
  onSaveCookie: (cookie: string) => void
  onSaveGitToken: (token: string) => void
  onPolicyChange: (policy: OverleafAutoSyncPolicy) => void
}

/** Modal backdrop + centered dialog shell (backdrop click closes). */
function shell(children: ReactElement, onClose: () => void): ReactElement {
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'var(--dsw-alias-overlay, rgba(0,0,0,0.45))',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
      onClick={event => { if (event.target === event.currentTarget) onClose() }}
    >
      {children}
    </div>
  )
}

/** One folded how-to block. */
function Details({ summary, children }: { summary: string; children: ReactNode }): ReactElement {
  return (
    <details style={{ fontSize: 12, color: LABEL_2 }}>
      <summary style={{ cursor: 'pointer', userSelect: 'none' }}>{summary}</summary>
      <div style={{ paddingTop: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>{children}</div>
    </details>
  )
}

/** Field row used across the modal. */
function Field({ label, children }: { label: string; children: ReactElement }): ReactElement {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: LABEL_2 }}>
      {label}
      {children}
    </label>
  )
}

/** The settings dialog. */
export function SettingsModal(props: SettingsModalProps): ReactElement {
  const [channel, setChannel] = useState<LoginChannel>('auto')
  const [customPath, setCustomPath] = useState('')
  const [cookieDraft, setCookieDraft] = useState('')
  const [gitTokenDraft, setGitTokenDraft] = useState('')
  const [policy, setPolicy] = useState<OverleafAutoSyncPolicy>(props.policy)

  useEffect(() => {
    setPolicy(props.policy)
  }, [props.policy])
  useEffect(() => {
    try {
      const storedChannel = globalThis.localStorage?.getItem('dsh-better-overleaf:browser-channel')
      if (storedChannel === 'auto' || storedChannel === 'default' || storedChannel === 'msedge'
        || storedChannel === 'chrome' || storedChannel === 'custom' || storedChannel === 'real') {
        setChannel(storedChannel)
      }
      setCustomPath(globalThis.localStorage?.getItem('dsh-better-overleaf:browser-path') ?? '')
    } catch {
      // Storage blocked; defaults are fine.
    }
  }, [])

  const persist = (key: string, value: string): void => {
    try { globalThis.localStorage?.setItem(key, value) } catch { /* in-memory only */ }
  }

  const updatePolicy = (patch: Partial<OverleafAutoSyncPolicy>): void => {
    const next = { ...policy, ...patch }
    setPolicy(next)
    props.onPolicyChange(next)
  }

  return shell(
    <div
      style={{
        width: 460, maxWidth: '100%', maxHeight: '86%', overflowY: 'auto',
        background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'inherit',
        border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16,
        display: 'flex', flexDirection: 'column', gap: 14, boxSizing: 'border-box',
      }}
      className="dov-list"
    >
      <div style={{ ...row, justifyContent: 'space-between' }}>
        <strong style={{ fontSize: 15 }}>Overleaf 设置</strong>
        <button onClick={props.onClose} style={{ ...button, border: 'none', fontSize: 16, color: LABEL_3 }} className="dov-btn">✕</button>
      </div>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ ...row, justifyContent: 'space-between' }}>
          <strong style={{ fontSize: 13 }}>连接 Overleaf</strong>
          <span style={{ ...row, gap: 5 }}>
            <span style={{ ...pill, ...(props.loggedIn ? { color: OK } : { color: LABEL_2 }) }}>
              {props.loggedIn ? '✓ 网页会话' : '未登录'}
            </span>
            <span style={{ ...pill, ...(props.gitConfigured ? { color: OK } : { color: LABEL_2 }) }}>
              {props.gitConfigured ? '✓ Git 令牌' : '无 Git 令牌'}
            </span>
          </span>
        </div>

        <div style={row}>
          <Field label="登录浏览器">
            <select
              value={channel}
              onChange={event => {
                const next = event.target.value as LoginChannel
                setChannel(next)
                persist('dsh-better-overleaf:browser-channel', next)
              }}
              disabled={props.busy}
              style={{ ...input, width: 200 }}
              className="dov-select"
            >
              <option value="auto">自动探测（推荐）</option>
              <option value="custom">指定浏览器路径</option>
              <option value="default">系统默认浏览器</option>
              <option value="msedge">Microsoft Edge</option>
              <option value="chrome">Google Chrome</option>
              <option value="real">真实浏览器配置（高级）</option>
            </select>
          </Field>
          {channel === 'custom' && (
            <Field label="浏览器路径">
              <input
                value={customPath}
                onChange={event => { setCustomPath(event.target.value); persist('dsh-better-overleaf:browser-path', event.target.value) }}
                placeholder="D:/.../CentBrowser.exe"
                disabled={props.busy}
                style={{ ...input, width: 200 }}
                className="dov-input"
              />
            </Field>
          )}
          <button
            onClick={() => { props.onLogin(channel, customPath) }}
            disabled={props.busy || (channel === 'custom' && customPath.trim() === '')}
            style={{ ...button, ...primary, alignSelf: 'flex-end' }}
            className="dov-btn dov-btn-primary"
          >
            打开浏览器登录
          </button>
        </div>

        {props.manualLogin?.kind === 'manual' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderRadius: 8, background: 'var(--dsw-alias-bg-skeleton, rgba(219,168,50,0.10))' }}>
            <span style={{ ...meta, color: LABEL_2 }}>{props.manualLogin.instructions}</span>
            <textarea
              value={cookieDraft}
              onChange={event => { setCookieDraft(event.target.value) }}
              placeholder="overleaf_session2=MTA0..."
              disabled={props.busy}
              style={{ ...input, resize: 'vertical', minHeight: 56 }}
              className="dov-input"
            />
            <button
              onClick={() => { props.onSaveCookie(cookieDraft); setCookieDraft('') }}
              disabled={props.busy || cookieDraft.trim() === ''}
              style={{ ...button, ...primary, alignSelf: 'flex-start' }}
              className="dov-btn dov-btn-primary"
            >
              保存 cookie
            </button>
          </div>
        )}

        <Details summary="浏览器登录说明（免费账号）">
          <span>登录一次后长期免密：使用独立的浏览器配置，弹窗里也可以用 Google 登录。</span>
          <span>「真实浏览器配置」直接复用日常浏览器的登录状态，但需要先完全退出该浏览器。</span>
          <span>其它浏览器：F12 → 网络/应用 → Cookie → 复制 <code>overleaf_session2</code> 的值粘贴到上方输入框。</span>
        </Details>

        <Details summary="Git 令牌（可选，Overleaf 付费功能）">
          <span>Overleaf → 账户设置 → Git integration 中生成令牌并粘贴保存。</span>
          <span>有令牌：走官方 git bridge，完整历史与变基合并。无令牌：免费账号用网页端点拉取和推送，同样双向可用；推送以本地内容为准。</span>
          <div style={row}>
            <input
              type="password"
              value={gitTokenDraft}
              onChange={event => { setGitTokenDraft(event.target.value) }}
              placeholder="粘贴 git-integration token"
              disabled={props.busy}
              style={{ ...input, flex: 1, minWidth: 180, width: 'auto' }}
              className="dov-input"
            />
            <button
              onClick={() => { props.onSaveGitToken(gitTokenDraft); setGitTokenDraft('') }}
              disabled={props.busy || gitTokenDraft.trim() === ''}
              style={{ ...button, ...primary }}
              className="dov-btn dov-btn-primary"
            >
              保存
            </button>
          </div>
        </Details>

        <Details summary="本地编译说明">
          <span>「编译预览」使用本机 latexmk（TeX Live / MiKTeX）直接编译镜像目录，无需回 Overleaf 网页。</span>
          <span>当前状态：{props.latexmkAvailable ? '已检测到 latexmk ✓' : '未检测到 latexmk'}</span>
        </Details>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <strong style={{ fontSize: 13 }}>自动同步</strong>
        <div style={row}>
          <Field label="自动拉取">
            <select
              value={policy.autoPullInterval}
              onChange={event => { updatePolicy({ autoPullInterval: event.target.value as OverleafAutoSyncPolicy['autoPullInterval'] }) }}
              disabled={props.busy}
              style={{ ...input, width: 160 }}
              className="dov-select"
            >
              <option value="off">关闭（仅手动）</option>
              <option value="5m">每 5 分钟</option>
              <option value="15m">每 15 分钟</option>
              <option value="30m">每 30 分钟</option>
              <option value="1h">每 1 小时</option>
            </select>
          </Field>
        </div>
        <label style={{ ...row, gap: 6, fontSize: 12, color: LABEL_2, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={policy.autoPush}
            onChange={event => { updatePolicy({ autoPush: event.target.checked }) }}
            disabled={props.busy}
          />
          拉取后自动推送本地提交
          <span style={{ ...meta, color: LABEL_3 }}>(AI 正在修改时可能推送半成品，谨慎开启)</span>
        </label>
        <label style={{ ...row, gap: 6, fontSize: 12, color: LABEL_2, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={policy.autoCommitLocal}
            onChange={event => { updatePolicy({ autoCommitLocal: event.target.checked }) }}
            disabled={props.busy}
          />
          同步前自动提交本地未保存的修改
        </label>
        <span style={{ ...meta, color: LABEL_3 }}>
          自动同步在后台运行，不需要打开 Overleaf 标签页；有未提交修改且未开启自动提交时会跳过并提醒。
        </span>
      </section>
    </div>,
    props.onClose,
  )
}
