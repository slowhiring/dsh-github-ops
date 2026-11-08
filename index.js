/**
 * dsh-github —— 让 DSH 直接操作使用者的 GitHub
 * ============================================================================
 * 为什么要有它：使用者说"创建一个能直接操作我的 github、管理我的代码仓库的插件"。
 * 「管理代码仓库」拆开就是三件事，这个插件各给一条路：
 *   1. **仓库层面的管理**（建/删/看/列）         → GitHub REST：github_repo
 *   2. **文件层面的改动**（读/写/列目录，直接进仓库）→ GitHub Contents API：github_file
 *   3. **本地真的改代码再推上去**（clone/status/diff/log/commit/push/pull）→ 本机 git：github_git
 * 外加 github_pr / github_issue / github_search —— 开 PR、提 issue、搜仓库，才算"管得动"。
 *
 * 三条设计约束：
 *   - **token 的归宿是 credential store，不是配置。** 走 ctx.get('credentials')，
 *     记录地址 `dsh-github/token`（kind='api-key'）。配置是公开的、可能被导出/分享的，
 *     而 token 一旦写进配置就等于泄露。取不到 credential store 时退到环境变量，
 *     再退到本进程内存（只是这一次能用，会明说）。
 *   - **不导出 Config。** 这个插件一个顶层静态 import 都没加（不用 schemastery），
 *     原因见 dsh-bili-scroll 的实测：可选 peer 解析失败会让整条插件不激活。
 *     apiBase / 克隆目录这种偏好用环境变量（GITHUB_API_URL / DSH_GITHUB_DIR）兜底。
 *   - **任何会改东西的动作都要能看见。** 返回的是给人/模型看的文本，不是裸 JSON：
 *     谁、哪个仓库、改了什么，一句话说得清。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const name = 'dsh-github-ops'
export const inject = ['tools']

/** credential store 里的地址：`<scope>/<id>`。运行时它就是个字符串（branded type 只在编译期存在）。 */
const CRED_KEY = 'dsh-github/token'
const DEFAULT_API = 'https://api.github.com'
/** 单次工具返回的文本上限：够看清，又不至于把上下文灌满。 */
const MAX_TEXT = 20000

/* ------------------------------------------------------------------ *
 * 运行时偏好（只读环境变量，不碰 Config）
 * ------------------------------------------------------------------ */

function apiBase() {
  const raw = (process.env.GITHUB_API_URL || '').trim() || DEFAULT_API
  return raw.replace(/\/+$/, '')
}

function reposRoot() {
  const raw = (process.env.DSH_GITHUB_DIR || '').trim()
  return raw ? resolve(raw) : join(homedir(), 'dsh-github')
}

/* ------------------------------------------------------------------ *
 * 文本小工具
 * ------------------------------------------------------------------ */

const L = (...lines) => lines.filter((x) => x !== undefined && x !== null && x !== '').join('\n')

function cap(text, max = MAX_TEXT) {
  const s = String(text ?? '')
  return s.length <= max ? s : `${s.slice(0, max)}\n… （截断，还有 ${s.length - max} 个字符）`
}

function day(iso) {
  if (!iso) return '-'
  const s = String(iso)
  return s.length >= 10 ? s.slice(0, 10) : s
}

function short(s, max = 200) {
  const t = String(s ?? '').replace(/\r\n/g, '\n').trim()
  return t.length <= max ? t : `${t.slice(0, max)}…`
}

/* ------------------------------------------------------------------ *
 * 错误
 * ------------------------------------------------------------------ */

class GhError extends Error {
  constructor(message, status, extra = {}) {
    super(message)
    this.name = 'GhError'
    this.status = status
    Object.assign(this, extra)
  }
}

function notAuthenticated() {
  return new GhError(
    '还没有连上 GitHub：找不到可用的 token。',
    0,
    { code: 'no-token' },
  )
}

const NO_TOKEN_HINT = L(
  '解决办法：请使用者给一个有 `repo` 权限的 GitHub token',
  '（GitHub → Settings → Developer settings → Personal access tokens → Fine-grained 或 Classic，勾 repo），',
  '然后调用 `github_auth`，action=login，token=<那串字符>。存好之后所有 github_* 工具都能用。',
)

function describeFailure(label, error) {
  if (error instanceof GhError) {
    const lines = [`${label} 失败：${error.message}`]
    if (error.code === 'no-token') lines.push(NO_TOKEN_HINT)
    else if (error.status === 401) lines.push('这个 token 无效或已过期 → 用 `github_auth` action=login 重新存一次。')
    else if (error.status === 403) lines.push('权限不足或被限流。检查 token 的 scopes（Classic 需要 repo；Fine-grained 需要 Contents/Pull requests/Issues 读写），或者稍后再试。')
    else if (error.status === 404) lines.push('仓库/资源不存在，或者这个 token 看不到它（私有仓库要给 token 授权）。')
    else if (error.status === 422) {
      const extra = error.body && error.body.errors ? ` ${JSON.stringify(error.body.errors).slice(0, 400)}` : ''
      lines.push(`参数被 GitHub 拒了。${extra}`.trim())
    } else if (error.code === 'network') lines.push('网络或代理问题：确认这台机器能访问 github.com / api.github.com。')
    return lines.join('\n')
  }
  const msg = error && error.message ? error.message : String(error)
  return `${label} 失败：${msg}`
}

/** execute 永远不 throw —— 失败也当一段可读的话回去，模型才知道下一步干什么。 */
function guarded(label, fn) {
  return async (args, exec) => {
    try {
      return { text: cap(await fn(args || {}, exec)) }
    } catch (error) {
      return { text: cap(describeFailure(label, error)) }
    }
  }
}

/* ------------------------------------------------------------------ *
 * token 的取与存
 * ------------------------------------------------------------------ */

function credentialStore(ctx) {
  try {
    const svc = ctx.get('credentials')
    if (svc && typeof svc.readRecord === 'function' && typeof svc.modifyRecord === 'function') return svc
  } catch {
    /* 没有就是没有：不列进 inject，免得宿主没这个服务时整条插件装不上 */
  }
  return undefined
}

function createAuth(ctx) {
  /** 本次进程内 login 存下的 token（credential store 不可用时的兜底） */
  let sessionToken = ''
  /** 这个 session token 有没有同时写进 credential store */
  let sessionStored = false

  return {
    async resolve() {
      if (sessionToken) return { token: sessionToken, source: 'session', persisted: sessionStored }
      const store = credentialStore(ctx)
      if (store) {
        try {
          const record = await store.readRecord(CRED_KEY)
          const key = record && record.kind === 'api-key' ? record.key : ''
          if (key) return { token: key, source: 'credential-store' }
        } catch {
          /* 读坏了就当没配 */
        }
      }
      const env = (process.env.GITHUB_TOKEN || '').trim() || (process.env.GH_TOKEN || '').trim()
      if (env) return { token: env, source: 'env' }
      return undefined
    },
    async require() {
      const found = await this.resolve()
      if (!found || !found.token) throw notAuthenticated()
      return found
    },
    async save(token) {
      sessionToken = token
      const store = credentialStore(ctx)
      if (!store) return { stored: false }
      try {
        await store.modifyRecord(CRED_KEY, () => ({ kind: 'api-key', key: token }))
        sessionStored = true
        return { stored: true }
      } catch {
        return { stored: false }
      }
    },
    async clear() {
      sessionToken = ''
      sessionStored = false
      const store = credentialStore(ctx)
      if (!store || typeof store.deleteRecord !== 'function') return { cleared: false }
      try {
        await store.deleteRecord(CRED_KEY)
        return { cleared: true }
      } catch {
        return { cleared: false }
      }
    },
  }
}

/* ------------------------------------------------------------------ *
 * GitHub REST
 * ------------------------------------------------------------------ */

function encPath(p) {
  return String(p || '')
    .split('/')
    .filter((seg) => seg !== '')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

async function request(auth, spec) {
  const { method = 'GET', path, query, body, accept } = spec
  const who = await auth.require()
  const url = new URL(apiBase() + path)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue
      url.searchParams.set(k, String(v))
    }
  }
  const headers = {
    accept: accept || 'application/vnd.github+json',
    'user-agent': 'dsh-github-plugin',
    'x-github-api-version': '2022-11-28',
    authorization: `Bearer ${who.token}`,
  }
  if (body !== undefined) headers['content-type'] = 'application/json'

  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    })
  } catch (error) {
    throw new GhError(`请求 ${url.origin} 时网络出错：${error && error.message ? error.message : error}`, 0, { code: 'network' })
  }

  const text = await res.text()
  let data = text
  const ctype = res.headers.get('content-type') || ''
  if (text && ctype.includes('json')) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!res.ok) {
    const message = data && data.message ? data.message : short(text, 300) || `HTTP ${res.status}`
    const limited = res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0'
    throw new GhError(limited ? `${message}（已限流，${res.headers.get('x-ratelimit-reset') || '稍后'} 重置）` : message, res.status, {
      body: data,
      headers: res.headers,
    })
  }

  return { data, headers: res.headers, status: res.status }
}

/** 把 body 序列化进 JSON —— 有些字段（如 labels）是数组，字符串化会让 GitHub 误读。 */
function pick(obj, keys) {
  const out = {}
  for (const key of keys) if (obj[key] !== undefined) out[key] = obj[key]
  return out
}

function parseRepo(input) {
  const raw = String(input || '')
    .trim()
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(raw)
  if (!m) return undefined
  return { owner: m[1], name: m[2], full: `${m[1]}/${m[2]}` }
}

function needRepo(args) {
  const parsed = parseRepo(args.repo)
  if (!parsed) {
    throw new GhError('需要 repo 参数，格式是 "owner/name"，例如 "octocat/Hello-World"。', 0)
  }
  return parsed
}

/* ------------------------------------------------------------------ *
 * 本机 git
 * ------------------------------------------------------------------ */

function gitEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GCM_INTERACTIVE: 'never',
  }
}

/**
 * 认证：不放 URL 里（URL 会进 reflog / 报错信息 / 终端历史），
 * 而是这次命令专用的 http.<url>.extraheader。GitHub 认 Basic + x-access-token。
 */
function authConfigArgs(token) {
  if (!token) return []
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')
  return ['-c', `http.https://github.com/.extraheader=Authorization: Basic ${basic}`]
}

function redact(text, token) {
  const s = String(text || '')
  if (!token) return s
  return s.split(token).join('***')
}

async function git(dir, argv, options = {}) {
  const { token, timeout = 180000 } = options
  try {
    const { stdout, stderr } = await run('git', argv, {
      cwd: dir,
      env: gitEnv(),
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
    return { ok: true, stdout: redact(stdout, token), stderr: redact(stderr, token) }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { ok: false, enoent: true, stdout: '', stderr: '', message: '这台机器上找不到 git 命令（PATH 里没有）。' }
    }
    if (error && error.code === 'EPERM') {
      return { ok: false, enoent: true, stdout: '', stderr: '', message: '宿主进程不允许启动子进程（spawn EPERM），这个环境里用不了本地 git。' }
    }
    const stdout = redact(error && error.stdout, token)
    const stderr = redact(error && error.stderr, token)
    const killed = error && (error.killed || error.signal)
    return {
      ok: false,
      code: error && error.code,
      stdout,
      stderr,
      message: killed ? 'git 超时或被中断。' : short(stderr || (error && error.message) || String(error), 1200),
    }
  }
}

function gitDirFor(args) {
  if (args.path) {
    const dir = resolve(String(args.path))
    if (!existsSync(dir)) throw new GhError(`目录不存在：${dir}`, 0)
    return dir
  }
  const parsed = needRepo(args)
  const dir = join(reposRoot(), parsed.owner, parsed.name)
  if (!existsSync(dir)) {
    throw new GhError(
      L(
        `本地还没有 ${parsed.full} 的克隆：${dir}`,
        `先用 github_git action=clone repo="${parsed.full}" 拉一份，或者传 path=<已有仓库目录>。`,
      ),
      0,
    )
  }
  return dir
}

async function isGitRepo(dir) {
  const probe = await git(dir, ['rev-parse', '--git-dir'])
  return probe.ok
}

/* ------------------------------------------------------------------ *
 * 格式化
 * ------------------------------------------------------------------ */

function repoLine(r) {
  const vis = r.private ? 'private' : 'public'
  const star = r.stargazers_count ? ` ★${r.stargazers_count}` : ''
  const branch = r.default_branch ? ` ${r.default_branch}` : ''
  const desc = (r.description || '').trim()
  const head = `${r.full_name} [${vis}${star}${branch}] 更新 ${day(r.updated_at)}`
  return desc ? `${head}\n    ${short(desc, 140)}` : head
}

function issueLine(i) {
  const labels = Array.isArray(i.labels)
    ? i.labels
        .map((l) => (typeof l === 'string' ? l : l && l.name))
        .filter(Boolean)
        .slice(0, 4)
        .join(', ')
    : ''
  const kind = i.pull_request ? '[PR] ' : ''
  return `${kind}#${i.number} [${i.state}] ${short(i.title, 120)}${labels ? `  {${labels}}` : ''}  ${day(i.updated_at)}`
}

/* ------------------------------------------------------------------ *
 * 工具定义
 * ------------------------------------------------------------------ */

const TEXT_OUTPUT = {
  schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  render: (_args, value) => [{ type: 'text', text: value && typeof value.text === 'string' ? value.text : '' }],
}

function authTool(auth) {
  return {
    name: 'github_auth',
    description: L(
      '连接/检查/断开 GitHub 账号。action=status（默认）报告当前用的是哪个账号、token 从哪来、还剩多少额度；',
      'action=login 把使用者给的 token 存进 DSH 的 credential store（这是唯一该存 token 的地方）；action=logout 删掉它。',
      '所有 github_* 工具都依赖这一步；没连上时它们的报错会提示先跑 action=login。',
    ),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'login', 'logout'],
          description: 'status=查看当前连接（默认）；login=保存 token；logout=清除已保存的 token。',
        },
        token: {
          type: 'string',
          description: 'GitHub personal access token。action=login 时必填；其他情况不用给。不要在回复里复述它。',
        },
      },
      required: ['action'],
    },
    execute: guarded('github_auth', async (args) => {
      const action = args.action || 'status'

      if (action === 'login') {
        const token = String(args.token || '').trim()
        if (!token) throw new GhError('action=login 需要 token 参数（可以叫使用者去 GitHub 生成一个，勾 repo 权限）。', 0)
        // 先验一遍再存：存一个死 token 只会让后面每个工具都莫名其妙
        const who = await request(
          { require: async () => ({ token }) },
          { path: '/user' },
        )
        const saved = await auth.save(token)
        const scopes = who.headers.get('x-oauth-scopes') || ''
        return L(
          `已连接到 GitHub：@${who.data.login}${who.data.name ? `（${who.data.name}）` : ''}`,
          saved.stored
            ? 'token 已存进 profile 的 credential store（记录 `dsh-github/token`），下次开新会话也还在。'
            : '⚠️ 这个宿主没有可用的 credential store，token 只留在本进程内存里，重启 DSH 后要重新 login（或者设环境变量 GITHUB_TOKEN）。',
          scopes ? `scopes：${scopes}` : 'scopes：未上报（Fine-grained token 一般不报，正常）',
        )
      }

      if (action === 'logout') {
        const found = await auth.resolve()
        const result = await auth.clear()
        return L(
          found && found.source === 'env'
            ? 'credential store 里没有 token；环境变量里的那个我删不掉 —— 要断开请改环境变量 GITHUB_TOKEN / GH_TOKEN。'
            : '已清除保存的 GitHub token。',
          result.cleared ? '' : '（没有可写的 credential store，或本来就没存过。）',
        )
      }

      // status
      const found = await auth.resolve()
      const probe = await git(process.cwd(), ['--version'], { timeout: 10000 })
      const gitLine = probe.ok ? `git：${probe.stdout.trim()}` : `git：${probe.message}`
      if (!found) {
        return L('GitHub：未连接（没有 token）。', NO_TOKEN_HINT, gitLine)
      }
      try {
        const who = await request(auth, { path: '/user' })
        const scopes = who.headers.get('x-oauth-scopes') || ''
        const remain = who.headers.get('x-ratelimit-remaining')
        const limit = who.headers.get('x-ratelimit-limit')
        const u = who.data
        return L(
          `GitHub：已连接 @${u.login}${u.name ? `（${u.name}）` : ''}`,
          `token 来源：${found.source === 'credential-store' ? 'credential store（dsh-github/token）' : found.source === 'session' ? (found.persisted ? '本次会话内 login 的（已写入 credential store，重启后仍在）' : '本次会话内 login 的（未能写入 credential store，只在本会话有效）') : '环境变量'}`,
          scopes ? `scopes：${scopes}` : 'scopes：未上报（Fine-grained token 一般不报，正常）',
          remain && limit ? `API 额度：${remain}/${limit}` : '',
          `公开仓库：${u.public_repos ?? '-'}　私有仓库：${u.total_private_repos ?? '-'}`,
          `本地克隆目录：${reposRoot()}`,
          gitLine,
        )
      } catch (error) {
        return L(`GitHub：token 存在（来源 ${found.source}）但校验失败。`, describeFailure('github_auth', error))
      }
    }),
  }
}

function repoTool(auth) {
  return {
    name: 'github_repo',
    description: L(
      '管理 GitHub 仓库本身：action=list 列出某人/自己名下的仓库，view 看一个仓库的详情，',
      'create 新建仓库，delete 删除仓库（必须用 confirm 参数复述一遍 owner/name 才会真删）。',
      '看/改仓库里的文件用 github_file；把本地代码推上去用 github_git。',
    ),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'view', 'create', 'delete'], description: '要做什么。' },
        repo: { type: 'string', description: '仓库，格式 "owner/name"（view / delete 必填）。' },
        owner: {
          type: 'string',
          description: 'list/create 时的归属：用户名或组织名。留空 = 当前登录账号自己。',
        },
        name: { type: 'string', description: 'create 时的仓库名（不含 owner，只允许字母数字 . _ -）。' },
        description: { type: 'string', description: 'create 时的仓库简介。' },
        private: { type: 'boolean', description: 'create 时是否私有，默认 false（公开）。' },
        autoInit: { type: 'boolean', description: 'create 时是否初始化 README，默认 true。' },
        limit: { type: 'integer', description: 'list 返回几条，默认 30，最多 100。' },
        confirm: { type: 'string', description: 'delete 时必须原样写一遍 "owner/name"，否则拒绝执行。' },
      },
      required: ['action'],
    },
    execute: guarded('github_repo', async (args) => {
      const action = args.action || 'list'

      if (action === 'list') {
        const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100)
        const owner = String(args.owner || '').trim()
        const me = (await request(auth, { path: '/user' })).data.login
        let items
        let scope
        if (!owner || owner.toLowerCase() === String(me).toLowerCase()) {
          items = (await request(auth, { path: '/user/repos', query: { per_page: limit, sort: 'updated', affiliation: 'owner,collaborator,organization_member' } })).data
          scope = `@${me} 名下（含协作/组织）`
        } else {
          try {
            items = (await request(auth, { path: `/orgs/${encodeURIComponent(owner)}/repos`, query: { per_page: limit, type: 'all' } })).data
            scope = `组织 ${owner}`
          } catch (error) {
            if (!(error instanceof GhError) || error.status !== 404) throw error
            items = (await request(auth, { path: `/users/${encodeURIComponent(owner)}/repos`, query: { per_page: limit, sort: 'updated' } })).data
            scope = `用户 ${owner}（公开仓库）`
          }
        }
        if (!Array.isArray(items) || items.length === 0) return `没有仓库。范围：${scope}`
        const shown = items.slice(0, limit)
        return L(
          `${scope}，${items.length} 个${items.length >= limit ? `（只取了前 ${limit} 个，要更多就加 limit）` : ''}：`,
          ...shown.map(repoLine),
        )
      }

      if (action === 'view') {
        const repo = needRepo(args)
        const r = (await request(auth, { path: `/repos/${repo.full}` })).data
        const perms = r.permissions
          ? Object.entries(r.permissions)
              .filter(([, v]) => v === true)
              .map(([k]) => k)
              .join(', ')
          : ''
        return L(
          `${r.full_name} [${r.private ? '私有' : '公开'}${r.archived ? ' · 已归档' : ''}${r.fork ? ' · fork' : ''}]`,
          r.description ? `简介：${short(r.description, 400)}` : '',
          `默认分支：${r.default_branch}　语言：${r.language || '-'}　体积：${Math.round((r.size || 0) / 1024)} MB`,
          `★ ${r.stargazers_count ?? 0}　fork ${r.forks_count ?? 0}　watchers ${r.subscribers_count ?? 0}　open issues ${r.open_issues_count ?? 0}`,
          `最近推送：${day(r.pushed_at)}　创建：${day(r.created_at)}`,
          perms ? `我的权限：${perms}` : '',
          `克隆：${r.clone_url}`,
          `网页：${r.html_url}`,
        )
      }

      if (action === 'create') {
        const name = String(args.name || '').trim()
        if (!/^[A-Za-z0-9._-]+$/.test(name)) {
          throw new GhError('name 只能用字母、数字、点、下划线、短横线。', 0)
        }
        const owner = String(args.owner || '').trim()
        const payload = pick(
          {
            name,
            description: args.description,
            private: args.private === true,
            auto_init: args.autoInit !== false,
          },
          ['name', 'description', 'private', 'auto_init'],
        )
        const me = (await request(auth, { path: '/user' })).data.login
        const isOrg = owner && owner.toLowerCase() !== String(me).toLowerCase()
        const created = (await request(auth, {
          method: 'POST',
          path: isOrg ? `/orgs/${encodeURIComponent(owner)}/repos` : '/user/repos',
          body: payload,
        })).data
        return L(
          `已创建仓库 ${created.full_name}（${created.private ? '私有' : '公开'}${payload.auto_init ? '，带 README' : '，空仓库'}）。`,
          `默认分支：${created.default_branch || '-'}`,
          `克隆：${created.clone_url}`,
          `下一步可以直接 github_git action=clone repo="${created.full_name}" 拉下来写代码。`,
        )
      }

      if (action === 'delete') {
        const repo = needRepo(args)
        const confirm = String(args.confirm || '').trim()
        if (confirm.toLowerCase() !== repo.full.toLowerCase()) {
          throw new GhError(
            `删除仓库不可撤销。确认要删的话，把 confirm 参数写成 "${repo.full}" 再调一次。`,
            0,
          )
        }
        await request(auth, { method: 'DELETE', path: `/repos/${repo.full}` })
        return `已删除 ${repo.full}。`
      }

      throw new GhError(`不认识的 action：${action}`, 0)
    }),
  }
}

function fileTool(auth) {
  return {
    name: 'github_file',
    description: L(
      '直接读写 GitHub 仓库里的文件（走 Contents API，不需要先 clone）。',
      'action=read 读一个文件（默认默认分支），list 列目录，write 新建/覆盖一个文件并提交（自动带上已有文件的 sha，可指定 branch）。',
      '适合改 README、加配置、动单个文件；要大改一堆文件请用 github_git 克隆到本地。',
    ),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['read', 'list', 'write'], description: '读 / 列目录 / 写。' },
        repo: { type: 'string', description: '仓库 "owner/name"。' },
        path: { type: 'string', description: '仓库内路径，例如 "src/index.js"；list 时是目录（留空 = 根目录）。' },
        ref: { type: 'string', description: '分支名或 commit sha；留空 = 仓库默认分支。' },
        content: { type: 'string', description: 'write 时的文件全文（纯文本，不要 base64）。' },
        message: { type: 'string', description: 'write 时的提交信息，默认 "Update <path>"。' },
        branch: { type: 'string', description: 'write 时提交到哪个分支，默认默认分支。' },
      },
      required: ['action', 'repo'],
    },
    execute: guarded('github_file', async (args) => {
      const action = args.action || 'read'
      const repo = needRepo(args)
      const ref = String(args.ref || '').trim() || undefined

      if (action === 'read') {
        const path = encPath(args.path)
        if (!path) throw new GhError('read 需要 path。', 0)
        const res = await request(auth, { path: `/repos/${repo.full}/contents/${path}`, query: { ref } })
        if (Array.isArray(res.data)) {
          return L(`${repo.full}:${path} 是个目录，用 action=list 看内容。`, ...res.data.slice(0, 100).map((e) => `- ${e.type} ${e.name}`))
        }
        const entry = res.data
        const encoded = String(entry.content || '').replace(/\n/g, '')
        const text = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : ''
        const tooBig = entry.size > 1000000 || !encoded
        return L(
          `${repo.full}:${entry.path}  (${entry.size} bytes, blob ${String(entry.sha).slice(0, 10)})`,
          tooBig && !text ? '（GitHub 对超过 1MB 的文件不返回内容，请 clone 到本地看）' : '',
          '---',
          text,
        )
      }

      if (action === 'list') {
        const path = encPath(args.path)
        const res = await request(auth, { path: `/repos/${repo.full}/contents/${path}`, query: { ref } })
        const items = Array.isArray(res.data) ? res.data : [res.data]
        if (items.length === 0) return `${repo.full}:${path || '/'} 是空的。`
        return L(
          `${repo.full}:${path || '/'}（${items.length} 项${ref ? `，ref=${ref}` : ''}）`,
          ...items.map((e) => `- ${e.type === 'dir' ? 'dir' : 'file'} ${e.name}${e.type === 'file' ? ` (${e.size} B)` : ''}`),
        )
      }

      if (action === 'write') {
        const path = encPath(args.path)
        if (!path) throw new GhError('write 需要 path。', 0)
        if (typeof args.content !== 'string') throw new GhError('write 需要 content（文件全文）。', 0)
        const branch = String(args.branch || '').trim() || undefined
        let sha
        try {
          const existing = await request(auth, { path: `/repos/${repo.full}/contents/${path}`, query: { ref: branch || ref } })
          if (!Array.isArray(existing.data)) sha = existing.data.sha
        } catch (error) {
          if (!(error instanceof GhError) || error.status !== 404) throw error
        }
        const body = pick(
          {
            message: String(args.message || '').trim() || `${sha ? 'Update' : 'Create'} ${path}`,
            content: Buffer.from(args.content, 'utf8').toString('base64'),
            branch,
            sha,
          },
          ['message', 'content', 'branch', 'sha'],
        )
        const res = await request(auth, { method: 'PUT', path: `/repos/${repo.full}/contents/${path}`, body })
        return L(
          `已${sha ? '更新' : '新建'} ${repo.full}:${path}（${args.content.length} 字符）`,
          `提交：${String(res.data.commit && res.data.commit.sha).slice(0, 10)} ${body.message}`,
          res.data.content && res.data.content.html_url ? `网页：${res.data.content.html_url}` : '',
        )
      }

      throw new GhError(`不认识的 action：${action}`, 0)
    }),
  }
}

function gitTool(auth) {
  return {
    name: 'github_git',
    description: L(
      '在这台机器上用真正的 git 操作仓库：clone / status / diff / log / commit / push / pull / checkout / branch。',
      'clone 默认落在 DSH_GITHUB_DIR（默认 ~/dsh-github）下的 <owner>/<name>；push/pull 会自动带上 token 认证（https）。',
      'commit 会把所有改动 git add -A 后提交；涉及多文件、要跑构建的活都走这条。',
    ),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['clone', 'status', 'diff', 'log', 'commit', 'push', 'pull', 'fetch', 'checkout', 'branch'],
          description: '要执行的 git 动作。',
        },
        repo: { type: 'string', description: '仓库 "owner/name"。clone 时必填；其他动作用来定位默认目录。' },
        path: { type: 'string', description: '直接指定本地仓库目录（优先级高于 repo）。' },
        dir: { type: 'string', description: 'clone 的目标目录，留空 = <reposDir>/<owner>/<name>。' },
        message: { type: 'string', description: 'commit 的提交信息。' },
        branch: { type: 'string', description: 'push/pull/checkout 用的分支名；checkout 时可配合 create。' },
        create: { type: 'boolean', description: 'checkout 时是否新建分支（git checkout -b）。' },
        strategy: { type: 'string', enum: ['ff-only', 'merge', 'rebase'], description: 'pull 的策略，默认 ff-only（不让它悄悄产生合并提交）。' },
        stat: { type: 'boolean', description: 'diff 时只看统计（默认 true）；false 给完整 diff。' },
        count: { type: 'integer', description: 'log 显示几条，默认 15。' },
        all: { type: 'boolean', description: 'commit 时是否 git add -A，默认 true。' },
      },
      required: ['action'],
    },
    execute: guarded('github_git', async (args) => {
      const action = args.action || 'status'
      const who = await auth.resolve()
      const token = who && who.token
      const cfg = authConfigArgs(token)

      if (action === 'clone') {
        const repo = needRepo(args)
        const dest = args.dir ? resolve(String(args.dir)) : join(reposRoot(), repo.owner, repo.name)
        if (existsSync(dest) && (await isGitRepo(dest))) {
          throw new GhError(`目标目录已经是个 git 仓库了：${dest}`, 0)
        }
        await mkdir(dirname(dest), { recursive: true })
        const url = `https://github.com/${repo.full}.git`
        const res = await git(dirname(dest), [...cfg, 'clone', '--origin', 'origin', url, dest])
        if (!res.ok) throw new GhError(`git clone 失败：${res.message}`, 0)
        return L(
          `已克隆 ${repo.full} → ${dest}`,
          `（认证走一次性 header，origin 里没有 token）`,
          short(res.stderr, 300),
          `下一步：github_git action=status path="${dest}"`,
        )
      }

      const dir = gitDirFor(args)
      if (!(await isGitRepo(dir))) throw new GhError(`${dir} 不是 git 仓库。`, 0)
      const here = `${dir}`

      if (action === 'status') {
        const res = await git(dir, ['status', '--porcelain=v1', '--branch'])
        if (!res.ok) throw new GhError(res.message, 0)
        const lines = res.stdout.trim().split('\n').filter(Boolean)
        return L(`仓库：${here}`, lines.length ? res.stdout.trim() : '工作区干净，没有改动。')
      }

      if (action === 'diff') {
        const argv = args.stat === false ? ['diff'] : ['diff', '--stat']
        const res = await git(dir, argv)
        if (!res.ok) throw new GhError(res.message, 0)
        return L(`仓库：${here}`, res.stdout.trim() || '没有未提交的改动。')
      }

      if (action === 'log') {
        const n = Math.min(Math.max(Number(args.count) || 15, 1), 100)
        const res = await git(dir, ['log', `-n`, String(n), '--date=short', '--pretty=format:%h %ad %an %s'])
        if (!res.ok) throw new GhError(res.message, 0)
        return L(`仓库：${here}`, res.stdout.trim() || '（还没有提交）')
      }

      if (action === 'branch') {
        const res = await git(dir, ['branch', '-vv'])
        if (!res.ok) throw new GhError(res.message, 0)
        return L(`仓库：${here}`, res.stdout.trim())
      }

      if (action === 'checkout') {
        const branch = String(args.branch || '').trim()
        if (!branch) throw new GhError('checkout 需要 branch。', 0)
        const res = await git(dir, args.create ? ['checkout', '-b', branch] : ['checkout', branch])
        if (!res.ok) throw new GhError(`git checkout 失败：${res.message}`, 0)
        return L(`仓库：${here}`, short(`${res.stdout}${res.stderr}`, 600))
      }

      if (action === 'commit') {
        const message = String(args.message || '').trim()
        if (!message) throw new GhError('commit 需要 message。', 0)
        if (args.all !== false) {
          const staged = await git(dir, ['add', '-A'])
          if (!staged.ok) throw new GhError(`git add 失败：${staged.message}`, 0)
        }
        const res = await git(dir, ['commit', '-m', message])
        if (!res.ok) {
          if (/nothing to commit|no changes added/i.test(res.message)) {
            return L(`仓库：${here}`, '没有需要提交的改动（工作区干净）。')
          }
          throw new GhError(`git commit 失败：${res.message}`, 0)
        }
        const head = await git(dir, ['log', '-1', '--pretty=format:%h %s'])
        return L(`仓库：${here}`, `已提交：${head.stdout.trim()}`, short(`${res.stdout}`, 400))
      }

      if (action === 'push') {
        let branch = String(args.branch || '').trim()
        if (!branch) {
          const cur = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
          if (!cur.ok) throw new GhError(cur.message, 0)
          branch = cur.stdout.trim()
        }
        const upstream = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
        const argv = upstream.ok ? ['push', 'origin', branch] : ['push', '-u', 'origin', branch]
        const res = await git(dir, [...cfg, ...argv])
        if (!res.ok) {
          throw new GhError(
            L(`git push 失败：${res.message}`, /Authentication failed|could not read Username/i.test(`${res.stderr}`) ? '看起来是认证没过：确认 token 还有效、且对这个仓库有写权限。' : ''),
            0,
          )
        }
        return L(`仓库：${here}`, `已推送 ${branch} → origin`, short(`${res.stdout}${res.stderr}`, 800))
      }

      if (action === 'fetch') {
        const res = await git(dir, [...cfg, 'fetch', '--all', '--prune'])
        if (!res.ok) throw new GhError(`git fetch 失败：${res.message}`, 0)
        return L(`仓库：${here}`, short(`${res.stdout}${res.stderr}`, 800) || '已 fetch（没有新东西）。')
      }

      if (action === 'pull') {
        const mode = args.strategy || 'ff-only'
        const argv = mode === 'merge' ? ['pull', '--no-rebase'] : mode === 'rebase' ? ['pull', '--rebase'] : ['pull', '--ff-only']
        const res = await git(dir, [...cfg, ...argv])
        if (!res.ok) {
          throw new GhError(
            L(
              `git pull 失败：${res.message}`,
              /Not possible to fast-forward|divergent/i.test(`${res.stderr}${res.stdout}`)
                ? '本地和远端分叉了。先 action=diff / log 看清楚，再决定 merge 还是 rebase（也可以传 strategy=merge）。'
                : '',
            ),
            0,
          )
        }
        return L(`仓库：${here}`, short(`${res.stdout}${res.stderr}`, 1000) || '已是最新。')
      }

      throw new GhError(`不认识的 action：${action}`, 0)
    }),
  }
}

function prTool(auth) {
  return {
    name: 'github_pr',
    description: L(
      'Pull request：action=list 列 PR，view 看详情（含改动量和可合并状态），create 从 head 分支开向 base 分支，',
      'merge 合并（merge/squash/rebase），comment 在 PR 下发评论。PR 只对同一仓库内的分支，跨 fork 的 head 写成 "user:branch"。',
    ),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'view', 'create', 'merge', 'comment'], description: '要做什么。' },
        repo: { type: 'string', description: '仓库 "owner/name"。' },
        number: { type: 'integer', description: 'PR 编号（view/merge/comment 必填）。' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'list 的状态筛选，默认 open。' },
        title: { type: 'string', description: 'create 的标题。' },
        body: { type: 'string', description: 'create 的描述 / comment 的正文。' },
        head: { type: 'string', description: 'create 的来源分支名。' },
        base: { type: 'string', description: 'create 的目标分支名（比如 main）。' },
        draft: { type: 'boolean', description: 'create 时是否为草稿 PR。' },
        method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'merge 的合并方式，默认 merge。' },
        limit: { type: 'integer', description: 'list 返回几条，默认 20。' },
      },
      required: ['action', 'repo'],
    },
    execute: guarded('github_pr', async (args) => {
      const action = args.action || 'list'
      const repo = needRepo(args)
      const number = Number(args.number) || 0

      if (action === 'list') {
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
        const items = (await request(auth, {
          path: `/repos/${repo.full}/pulls`,
          query: { state: args.state || 'open', per_page: limit, sort: 'updated', direction: 'desc' },
        })).data
        if (!Array.isArray(items) || items.length === 0) return `${repo.full}：没有 ${args.state || 'open'} 状态的 PR。`
        return L(
          `${repo.full}：${items.length} 个 PR`,
          ...items.map((p) => `#${p.number} [${p.state}${p.draft ? ' · draft' : ''}] ${short(p.title, 110)}\n    ${p.head ? `${p.head.ref}→${p.base.ref}` : ''} by ${p.user ? p.user.login : '?'}  ${day(p.updated_at)}`),
        )
      }

      if (action === 'view') {
        if (!number) throw new GhError('view 需要 number。', 0)
        const p = (await request(auth, { path: `/repos/${repo.full}/pulls/${number}` })).data
        return L(
          `#${p.number} ${p.title}`,
          `${repo.full}　${p.head ? `${p.head.ref} → ${p.base.ref}` : ''}　by ${p.user ? p.user.login : '?'}`,
          `状态：${p.state}${p.merged ? `（已合并 ${day(p.merged_at)}）` : ''}${p.draft ? ' · draft' : ''}　可合并：${p.mergeable === null ? '计算中' : p.mergeable ? '是' : '否'}（${p.mergeable_state || '-'}）`,
          `改动：+${p.additions ?? '?'} −${p.deletions ?? '?'}，${p.changed_files ?? '?'} 个文件　提交 ${p.commits ?? '?'}　评论 ${p.comments ?? 0}`,
          `创建：${day(p.created_at)}　更新：${day(p.updated_at)}`,
          p.html_url ? `网页：${p.html_url}` : '',
          p.body ? `\n---\n${short(p.body, 2000)}` : '',
        )
      }

      if (action === 'create') {
        const title = String(args.title || '').trim()
        const head = String(args.head || '').trim()
        const base = String(args.base || '').trim()
        if (!title || !head || !base) throw new GhError('create 需要 title、head、base。', 0)
        const p = (await request(auth, {
          method: 'POST',
          path: `/repos/${repo.full}/pulls`,
          body: pick({ title, head, base, body: args.body, draft: args.draft === true }, ['title', 'head', 'base', 'body', 'draft']),
        })).data
        return L(`已创建 PR #${p.number}：${p.title}`, `${head} → ${base}`, p.html_url || '')
      }

      if (action === 'merge') {
        if (!number) throw new GhError('merge 需要 number。', 0)
        const res = await request(auth, {
          method: 'PUT',
          path: `/repos/${repo.full}/pulls/${number}/merge`,
          body: pick({ merge_method: args.method || 'merge', commit_title: args.title, commit_message: args.body }, ['merge_method', 'commit_title', 'commit_message']),
        })
        return L(`PR #${number} 已合并（${args.method || 'merge'}）：${res.data.message || 'ok'}`)
      }

      if (action === 'comment') {
        if (!number) throw new GhError('comment 需要 number。', 0)
        if (!String(args.body || '').trim()) throw new GhError('comment 需要 body。', 0)
        const c = (await request(auth, {
          method: 'POST',
          path: `/repos/${repo.full}/issues/${number}/comments`,
          body: { body: args.body },
        })).data
        return `已在 PR #${number} 下评论：${c.html_url || ''}`
      }

      throw new GhError(`不认识的 action：${action}`, 0)
    }),
  }
}

function issueTool(auth) {
  return {
    name: 'github_issue',
    description: L(
      'Issue：action=list 列（可按 state/labels 过滤），view 看详情，comments 看评论，create 新建，',
      'comment 发评论，close / reopen 开关。注意 GitHub 的 issues 列表里也会混进 PR（会标 [PR]）。',
    ),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'view', 'comments', 'create', 'comment', 'close', 'reopen'], description: '要做什么。' },
        repo: { type: 'string', description: '仓库 "owner/name"。' },
        number: { type: 'integer', description: 'issue 编号（view/comments/comment/close/reopen 必填）。' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'list 的状态筛选，默认 open。' },
        labels: { type: 'string', description: 'list 的标签过滤，多个用逗号分隔。' },
        title: { type: 'string', description: 'create 的标题。' },
        body: { type: 'string', description: 'create 的正文 / comment 的正文。' },
        limit: { type: 'integer', description: 'list 返回几条，默认 20。' },
      },
      required: ['action', 'repo'],
    },
    execute: guarded('github_issue', async (args) => {
      const action = args.action || 'list'
      const repo = needRepo(args)
      const number = Number(args.number) || 0

      if (action === 'list') {
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
        const items = (await request(auth, {
          path: `/repos/${repo.full}/issues`,
          query: { state: args.state || 'open', labels: args.labels, per_page: limit, sort: 'updated', direction: 'desc' },
        })).data
        if (!Array.isArray(items) || items.length === 0) return `${repo.full}：没有匹配的 issue。`
        return L(`${repo.full}：${items.length} 条`, ...items.map(issueLine))
      }

      if (action === 'view') {
        if (!number) throw new GhError('view 需要 number。', 0)
        const i = (await request(auth, { path: `/repos/${repo.full}/issues/${number}` })).data
        return L(
          `${i.pull_request ? '[PR] ' : ''}#${i.number} ${i.title}`,
          `${repo.full}　状态：${i.state}　by ${i.user ? i.user.login : '?'}　评论 ${i.comments ?? 0}　创建 ${day(i.created_at)} 更新 ${day(i.updated_at)}`,
          i.labels && i.labels.length ? `标签：${i.labels.map((l) => l.name).join(', ')}` : '',
          i.html_url ? `网页：${i.html_url}` : '',
          i.body ? `\n---\n${short(i.body, 3000)}` : '',
        )
      }

      if (action === 'comments') {
        if (!number) throw new GhError('comments 需要 number。', 0)
        const items = (await request(auth, { path: `/repos/${repo.full}/issues/${number}/comments`, query: { per_page: 30 } })).data
        if (!Array.isArray(items) || items.length === 0) return `#${number} 还没有评论。`
        return L(
          `#${number}：${items.length} 条评论`,
          ...items.map((c) => `— ${c.user ? c.user.login : '?'}（${day(c.created_at)}）\n${short(c.body, 800)}`),
        )
      }

      if (action === 'create') {
        const title = String(args.title || '').trim()
        if (!title) throw new GhError('create 需要 title。', 0)
        const labels = String(args.labels || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const i = (await request(auth, {
          method: 'POST',
          path: `/repos/${repo.full}/issues`,
          body: pick({ title, body: args.body, labels: labels.length ? labels : undefined }, ['title', 'body', 'labels']),
        })).data
        return L(`已创建 issue #${i.number}：${i.title}`, i.html_url || '')
      }

      if (action === 'comment') {
        if (!number) throw new GhError('comment 需要 number。', 0)
        if (!String(args.body || '').trim()) throw new GhError('comment 需要 body。', 0)
        const c = (await request(auth, { method: 'POST', path: `/repos/${repo.full}/issues/${number}/comments`, body: { body: args.body } })).data
        return `已在 #${number} 下评论：${c.html_url || ''}`
      }

      if (action === 'close' || action === 'reopen') {
        if (!number) throw new GhError(`${action} 需要 number。`, 0)
        const i = (await request(auth, {
          method: 'PATCH',
          path: `/repos/${repo.full}/issues/${number}`,
          body: { state: action === 'close' ? 'closed' : 'open' },
        })).data
        return `#${i.number} 现在是 ${i.state}。`
      }

      throw new GhError(`不认识的 action：${action}`, 0)
    }),
  }
}

function searchTool(auth) {
  return {
    name: 'github_search',
    description: L(
      '在 GitHub 上搜：kind=repos 搜仓库、code 搜代码（需要 token 有 code 权限）、issues 搜 issue/PR。',
      'query 支持 GitHub 的搜索语法，例如 "language:typescript stars:>100"、"repo:owner/name TODO"。',
    ),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['repos', 'code', 'issues'], description: '搜什么，默认 repos。' },
        query: { type: 'string', description: '搜索词，支持 GitHub 搜索语法。' },
        limit: { type: 'integer', description: '返回几条，默认 10，最多 30。' },
      },
      required: ['kind', 'query'],
    },
    execute: guarded('github_search', async (args) => {
      const kind = args.kind || 'repos'
      const query = String(args.query || '').trim()
      if (!query) throw new GhError('需要 query。', 0)
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 30)
      const path = kind === 'code' ? '/search/code' : kind === 'issues' ? '/search/issues' : '/search/repositories'
      const res = await request(auth, { path, query: { q: query, per_page: limit } })
      const items = res.data.items || []
      if (items.length === 0) return `没搜到：${query}（${kind}）`
      const total = res.data.total_count ?? items.length
      const body =
        kind === 'repos'
          ? items.map(repoLine)
          : kind === 'issues'
            ? items.map((i) => `${issueLine(i)}\n    ${i.repository_url ? i.repository_url.replace('https://api.github.com/repos/', '') : ''}`)
            : items.map((c) => `${c.repository ? c.repository.full_name : '?'}:${c.path}\n    ${c.html_url || ''}`)
      return L(`共 ${total} 个结果（显示 ${items.length} 个）：${query}`, ...body)
    }),
  }
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

export function apply(ctx) {
  const auth = createAuth(ctx)
  const defs = [authTool(auth), repoTool(auth), fileTool(auth), gitTool(auth), prTool(auth), issueTool(auth), searchTool(auth)]

  ctx.effect(() => {
    const disposers = defs.map((def) => ctx.tools.register({ ...def, output: TEXT_OUTPUT }))
    return () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          /* 卸载时静默 */
        }
      }
    }
  })
}
