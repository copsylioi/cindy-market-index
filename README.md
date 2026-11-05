# cindy-market-index

Cindy「GitHub插件与技能市场」插件使用的预建索引。GitHub Actions 每天抓取一次 GitHub 上的 Cindy 插件和 Agent Skills，生成 `index/` 目录下的分片 JSON。插件只需读这些文件，不用在每台设备上逐个搜索、读取仓库。

## 收录规则

- **Cindy 插件**：`topic:cindy-plugin`、名称或简介含 "cindy plugin"、代码搜索到合法 `ghost.json` 的仓库，以及几个已知的插件合集。
- **Agent Skills**：话题 `agent-skills`、`agent-skill`、`claude-skills`、`claude-code-skills`、`codex-skills`、`claude-code-plugins`、`antigravity-skills`，星数 ≥ 20。
- 每个仓库读取一次 Git 文件树来判断类型：
  - 含 `ghost.json` 的是插件。合集会拆成子插件，并读取各子插件的清单。
  - 含 `SKILL.md` 的是技能。每个 `SKILL.md` 单独成为一条记录，名称和简介取自它的 frontmatter。同名技能只保留路径最短的一份。不同仓库里名称和简介都相同的技能，只保留星数最高的仓库那份；每个仓库最多收录 100 个技能，整个索引最多 5 万个。
  - 两者都没有的是资源清单。只收录星数 ≥ 100 的。

## 文件格式

- `index/meta.json`：生成时间、统计数据，以及每个分片的文件名和内容哈希 `h`。
- `index/shard-00.json` … `shard-31.json`：分片文件，按仓库名哈希分配，结构为 `{ "repos": [...], "skills": [...] }`。
  - repo：`f` 仓库全名，`d` 简介，`s` 星数，`u` 最近推送时间，`t` topics，`o` 所有者 id，`b` 默认分支，`src` 来源（`cindy` 或 `skill`），`k` 类型（`plugin` / `skill` / `both` / `list`），`sk` 技能数，`pd` 单插件所在目录，`subs` 合集里的子插件，`m` 清单摘要（`id`、`n` 名称、`d` 简介、`v` 版本、`tc` 工具数）。
  - skill：`r` 所属仓库，`p` 技能目录，`n` 名称，`d` 简介。

插件先读 `meta.json`，只重新下载哈希变了的分片。

## 运行

- **自动运行**：每天北京时间 03:17 运行一次。也可以在 Actions 页面选择 *Build index* → *Run workflow* 手动触发。
- **令牌**：需要在仓库 Secrets 里配置 `GH_TOKEN`，只读的 Personal Access Token 即可。它只用于读取 GitHub；提交索引用的是 workflow 自带的 `GITHUB_TOKEN`。
- **本地试跑**（Node 18+）：`QUICK=1 LIMIT=10 node scripts/build-index.mjs`。不设 `GH_TOKEN` 时使用匿名额度，只读取少量文件。
- **其它环境变量**：`MIN_STARS`（默认 20）、`LIST_MIN_STARS`（默认 100）、`MAX_REPOS`（默认 4000）、`MAX_SKILLS_PER_REPO`（默认 100）、`MAX_SKILLS`（默认 50000）、`MAX_SKILL_DIRS`（每个仓库最多读取的 SKILL.md，默认 300）、`OUT_DIR`（默认 `index`）、`FORCE=1`。

## 保护机制

- 仓库没有新推送时，沿用上一版的结果。
- 读取单个仓库临时失败时，保留它在上一版中的条目。
- 新索引的仓库数比上一版少一半以上时，运行中止，不写入。确认没有问题的话，可以在手动运行时填 `force=1`。
