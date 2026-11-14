<p align="center">
  <img src="icon.png" width="88" height="88" alt="dsh-github-ops">
</p>

<h1 align="center">dsh-github-ops</h1>

<p align="center">
  让 DeepSeek Harness <b>真正动手</b>操作 GitHub：建仓库、写文件、<br>
  clone / commit / push 真实代码、开 PR、提 issue —— 不只是只读浏览。
</p>

<p align="center">
  <a href="https://github.com/slowhiring/dsh-github-ops/releases/latest"><img src="https://img.shields.io/github/v/release/slowhiring/dsh-github-ops?label=release" alt="release"></a>
  <img src="https://img.shields.io/badge/tools-7-blue.svg" alt="tools">
  <img src="https://img.shields.io/badge/deps-0-brightgreen.svg" alt="deps">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="license"></a>
</p>

<p align="center">
  <a href="https://github.com/slowhiring/dsh-github-ops">GitHub</a> ·
  <a href="https://gitee.com/lei-zefan/dsh-github-ops">Gitee 镜像</a> ·
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin">DSH 插件市场</a>
</p>

---

## 装它

```bash
# 1. 装（预构建包，29 KB，不需要构建、没有依赖）
dsh plugin add https://github.com/slowhiring/dsh-github-ops/releases/latest/download/dsh-github-ops-1.0.0.tgz

# 2. 重启 DSH —— 7 个工具立刻出现在工具列表里

# 3. 连上你的账号（token 存进 DSH credential store，不进配置文件）
github_auth action=login token=ghp_xxxxxxxx
```

也可以从源码装：`dsh plugin add github:slowhiring/dsh-github-ops`，或等它在
[插件市场](https://awesome-dsh-plugin.com/p/slowhiring/dsh-github-ops/) 里出现后点一下安装。

## 它和已有的 GitHub 插件差在哪

市面上已有的 GitHub 插件基本是**只读**的：搜仓库、读文件、看 issue。

这个插件是**可写可管理**的。三个层次都通：

| 你想干的事 | 走哪条路 | 工具 |
| --- | --- | --- |
| 建 / 删 / 看 / 列出仓库 | GitHub REST API | `github_repo` |
| 直接改仓库里的某个文件 | GitHub Contents API | `github_file` |
| **把本地真实代码 clone 下来、改、提交、推上去** | 你机器上的 `git` | `github_git` |

外加 `github_pr` / `github_issue` / `github_search`，以及管 token 的 `github_auth`。

## 用起来是什么样

```text
你：把 D:\work\my-app 这个项目传到我 GitHub 上
它：github_repo create name=my-app → github_git clone → 拷贝文件
    github_git commit message="初始提交" → github_git push
    仓库：https://github.com/you/my-app
```

```text
你：给 my-app 加个 CI，跑完给我开个 PR
它：github_file write .github/workflows/ci.yml → github_git checkout -b ci
    github_git commit → github_git push → github_pr create ...
```

```text
你：这几个 issue 里哪个还没人管？挑一个修了
它：github_issue list state=open → github_issue view 42
    github_git clone → 改代码 → commit → push → github_pr create
```

## 连上你的账号

插件不会、也不能替你生成 token。去
**GitHub → Settings → Developer settings → Personal access tokens** 建一个，然后：

```text
github_auth action=login token=ghp_xxxxxxxx
```

推荐 **fine-grained token**（可只授权某几个仓库），需要的能力：

| 能力 | 用来做什么 |
| --- | --- |
| Contents: Read & write | `github_file` 读写、`github_git` 推送 |
| Metadata: Read | 列出 / 查看仓库 |
| Pull requests: Read & write | `github_pr` 建 PR / 合并 / 评论 |
| Issues: Read & write | `github_issue` 建 issue / 评论 / 关闭 |
| Administration: Read & write | 只在**创建或删除**仓库时需要 |

经典 token 的话，`repo` + `workflow` 基本够用。存好之后 `github_auth action=status` 会告诉你
连的是谁、token 从哪来（credential store / 环境变量 / 本次会话）、`git` 是否可用。

```text
GitHub：@yourname（Your Name）· token 来源：credential store（dsh-github/token）
可选 scope：repo, workflow
git：git version 2.55.0.windows.5
```

## 七个工具

### `github_auth`
`status` 看状态 · `login` 保存 token · `logout` 清掉已保存的 token。

### `github_repo`
`list` · `view` · `create` · `delete`
删除必须原样复述 `owner/name` 到 `confirm` 参数里 —— 防手滑，也防模型自作主张。

### `github_file`
`read` · `list` · `write`
`write` 会自动取已有文件的 sha 做更新，不用先读一遍；`message` 就是提交信息。

### `github_git`（真实 git，跑在你自己机器上）
`clone` · `status` · `diff` · `log` · `commit` · `push` · `pull` · `fetch` · `checkout` · `branch`

- `clone` 默认落到 `~/dsh-github/<owner>/<name>`（`DSH_GITHUB_DIR` 可改）。
- `commit` 默认 `git add -A` 后提交；`push` / `pull` 自动带上 token 认证。
- 认证走**一次性 header**，`origin` 的 URL 里不会出现 token。

### `github_pr`
`list` · `view` · `create` · `merge` · `comment`

### `github_issue`
`list` · `view` · `comments` · `create` · `comment` · `close` · `reopen`

### `github_search`
`repos` · `code` · `issues` —— 支持 GitHub 搜索语法，如 `language:rust stars:>500`。

## 安全边界（重要）

- **token 存 DSH credential store**，记录地址 `dsh-github/token`；取不到 store 才退回环境变量
  `GITHUB_TOKEN` / `GH_TOKEN`，再退回本进程内存（此时会明确告诉你"只在本会话有效"）。
- token **不会**写进插件配置（配置可能被导出、分享、贴进 issue）。
- token **不会**进 git remote URL；git 只用一次性的 `http.https://github.com/.extraheader`。
- 工具输出里出现的任何 token 形态都会被抹成 `***`。
- 删仓库要求重复确认；其余写操作都是人看得见的一步，不做后台批量动作。

## 环境变量（都可选）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_GITHUB_DIR` | `~/dsh-github` | `github_git clone` 的落点 |
| `GITHUB_API_URL` | `https://api.github.com` | GitHub Enterprise / 代理端点 |
| `GITHUB_TOKEN` / `GH_TOKEN` | — | 没有 credential store 时的兜底 |

## 兼容性

- DSH Desktop / `dsh` CLI，host 侧插件（`export function apply(ctx)` + `export const inject = ['tools']`）。
- 需要系统里装了 `git`（只有 `github_git` 用到；纯 REST 那几个工具不需要）。
- 无 peer 依赖、无构建、无 postinstall —— 装完即用。

## 开发

```bash
git clone https://github.com/slowhiring/dsh-github-ops
cd dsh-github-ops
dsh plugin add "$PWD"     # 或 dsh plugin add github:slowhiring/dsh-github-ops
```

`index.js` 是一个文件，语义按工具分段；改完重启 DSH 生效。

## License

MIT © 2026 slowhiring
