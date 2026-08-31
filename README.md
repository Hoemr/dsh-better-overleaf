# dsh-better-overleaf

Overleaf integration for DeepSeek Harness (DSH), built on
[dsh-better-sidebar](https://www.npmjs.com/package/dsh-better-sidebar)'s
workbench. One Overleaf project ↔ one local git mirror under
`<workspace>/overleaf/<name>/`, so the sidebar's explorer, editor, image/PDF
previewers, Git panel, and conversation file references (`@`-mention) operate
on Overleaf content directly.

## How it works

```
Overleaf project ──┬── git bridge (git.overleaf.com/<id>)   ← two-way pull/push
                   └── website zip snapshot (cookie auth)   ← pull-only fallback
        │
        ▼
<workspace>/overleaf/<name>/   ← real git repo + .overleaf.json binding
        │
        ▼
dsh-better-sidebar workbench   ← explorer / editor / preview / Git panel / @引用
```

- **host** (`src/index.ts` → `lib/index.js`): provides `ctx.overleaf` and the
  loopback-only `/overleaf/*` JSON routes (status / projects / bindings /
  login / cookie / bind / unbind / sync).
- **client** (`src/client/index.ts` → `lib/client.js`): registers the
  `Overleaf` tab with dsh-better-sidebar when that optional peer is mounted;
  without it the plugin stays dormant but harmless (hot-pluggable).

Credentials never enter the browser bundle or route payloads: the host resolves
`OVERLEAF_COOKIE` and `OVERLEAF_GIT_TOKEN` through `ctx.credentials`.

## Login

Direct-CDP login launches an installed Chromium-family browser with a loopback
CDP port; after you log in, the session cookie is captured browser-side and
stored host-side. No Playwright download, no ChromeDriver.

**Persistent profile (default)** — the login window uses a dedicated dsh
profile at `~/.dsh/plugin-data/dsh-better-overleaf/browser-profile`. You enter your
credentials (or link Google OAuth) **once**; every later login opens that
profile already authenticated and captures the cookie without typing anything.
Set `loginProfile: temporary` to wipe the profile after each attempt instead.

Third-party Chromium browsers (CentBrowser, Brave, Vivaldi, …) are supported:

- `browserPath` — set it in config, or pick 指定浏览器路径 in the tab, to point
  at any Chromium-family executable directly; it is tried first.
- `browserChannel: auto` tries the Windows default browser first (registry
  lookup), then common install paths.
- `browserChannel: real` (advanced) launches your daily browser with its REAL
  profile so saved accounts apply — requires that browser fully closed first
  (a running instance swallows the debug-port flag), and newer Chrome builds
  refuse CDP on the default profile entirely.
- Manual fallback: copy the httpOnly `overleaf_session2` cookie from
  DevTools → Application → Cookies (`document.cookie` cannot see it); saved
  values are verified against Overleaf before being stored.

## Install

```sh
dsh plugin --profile desktop add dsh-better-sidebar@0.13.1    # or @0.14+ on DSH rc.8
dsh plugin --profile desktop add dsh-better-overleaf@0.2.1
# then restart the app so the host halves mount; hard-refresh the web view

# dev flow:
# dsh plugin --profile desktop add link:D:/Coding/dsh-better-overleaf
```

If pnpm reports ignored build scripts for `node-pty`, set
`allowBuilds: { node-pty: true }` in the profile's `pnpm-workspace.yaml`
(the terminal feature needs it; everything else works without it).

## Config

```yaml
- insert:
    - id: overleaf
      name: dsh-better-overleaf
      config:
        transport: auto          # auto | git | api
        baseUrl: https://www.overleaf.com
        gitOrigin: https://git.overleaf.com
        browserChannel: auto     # auto | default | msedge | chrome
        browserPath: ''          # explicit executable, tried first
        playwrightHeadless: false
        loginTimeoutMs: 600000
```

`transport: auto` prefers git whenever `OVERLEAF_GIT_TOKEN` is stored; pulls
degrade to API snapshots when only a cookie exists. The API transport cannot
push (website endpoints are read-only for content); pushing requires the git
bridge credential (account password, or the Git-integration token for SSO
accounts).

## Sync semantics

| Transport | Pull | Push | Notes |
|---|---|---|---|
| `git` | ✅ `pull --ff-only` | ✅ `push HEAD` | full history; better-sidebar Git panel shows real diffs |
| `api` | ✅ zip snapshot → wipe & commit | ❌ | refuses when the mirror has uncommitted changes |

Binding writes `.overleaf.json` inside the mirror and excludes it via
`.git/info/exclude`; unbind removes only the binding file, never your files.

## Status / roadmap

Done: project list/switch, mirror bind/unbind, git clone/pull/push, API
snapshot pull, direct-CDP login with custom browser path, manual cookie
fallback, loopback-only routes, hot-pluggable optional peer.

Ideas welcome: agent-facing pull/push tool (so the model can sync itself),
API push via folder/file upload endpoints, PDF compile preview.
