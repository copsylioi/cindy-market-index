#!/usr/bin/env node
/**
 * Cindy 插件市场索引构建（Node 18+，无第三方依赖）
 *
 * 1. 搜索 GitHub：Cindy 插件（topic、关键词、ghost.json 代码搜索、种子）和 Agent Skills 话题
 *    （按星数分段查询，绕过搜索接口单次最多 1000 条的限制）。
 * 2. 每个仓库读一次 Git Trees 判断类型：ghost.json → 插件（单个或合集），SKILL.md → 技能，都没有 → 资源清单。
 * 3. 用 GraphQL 批量读取 ghost.json 和 SKILL.md（frontmatter 的 name / description）。
 * 4. 按仓库名哈希分 16 片写到 index/；meta.json 记录每片的哈希，插件只下载有变化的分片。
 *    仓库没有新推送时沿用上一版的结果，所以日常运行只处理有变化的仓库。
 * 环境变量见 README.md。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const env = process.env;
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const TOKEN = env.GH_TOKEN || '';
const OUT = env.OUT_DIR || 'index';
const MIN_STARS = num(env.MIN_STARS, 20);
const LIST_MIN_STARS = num(env.LIST_MIN_STARS, 100);
const MAX_REPOS = num(env.MAX_REPOS, 4000);
const LIMIT = num(env.LIMIT, 0);
const QUICK = env.QUICK === '1';
const MAX_BLOBS = num(env.MAX_BLOBS, TOKEN ? Infinity : 30);
const FORCE = env.FORCE === '1';
export const SHARDS = 16;
const DESC_MAX = 300;
const MAX_SKILLS_PER_REPO = 3000;
const MAX_SUBS = 40;
export const SKILL_TOPICS = ['agent-skills', 'agent-skill', 'claude-skills', 'claude-code-skills', 'codex-skills', 'claude-code-plugins', 'antigravity-skills'];
const CINDY_SEEDS = ['makecindy/cindy-official-plugins', 'otaku-say/cindy-plugins', 'nanaco666/cindy-community-plugins',
  'AquaHydro/cindy-marketplace', 'mutsuki14/cindy-plugins', 'lengjingxu/cindy-personal-workbench', 'linvisxie/cindy-qoder-bridge'];
const SKILL_SEEDS = ['anthropics/skills', 'sickn33/agentic-awesome-skills', 'VoltAgent/awesome-agent-skills', 'addyosmani/agent-skills'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[index]', ...a);
export const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const safeJson = (t) => { try { return JSON.parse(String(t).replace(/^\uFEFF/, '')); } catch { return null; } };
const baseName = (p) => String(p || '').split('/').pop();
const stats = { rest: 0, search: 0, code: 0, graphql: 0, retries: 0 };

// ---------- GitHub API：限流时按 retry-after / reset 等待 ----------
async function gh(path, { method = 'GET', body, kind = 'rest', timeout = 60000 } = {}) {
  const url = path.startsWith('https://') ? path : 'https://api.github.com' + path;
  const headers = { 'User-Agent': 'cindy-market-index', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  if (body) headers['Content-Type'] = 'application/json';
  for (let attempt = 1; attempt <= 6; attempt++) {
    let res, text;
    try {
      res = await fetch(url, { method, body, headers, signal: AbortSignal.timeout(timeout) });
      text = await res.text();
    } catch {
      stats.retries++; await sleep(2000 * attempt); continue;
    }
    stats[kind]++;
    if (res.status === 403 || res.status === 429) {
      const ra = Number(res.headers.get('retry-after')) || 0;
      const left = res.headers.get('x-ratelimit-remaining');
      const reset = Number(res.headers.get('x-ratelimit-reset')) || 0;
      if (ra || left === '0' || /rate limit/i.test(text)) {
        const wait = ra ? ra * 1000 : (left === '0' && reset ? reset * 1000 - Date.now() + 2000 : 60000 * attempt);
        if (!TOKEN && wait > 60000) throw new Error('匿名额度用尽，' + Math.ceil(wait / 60000) + ' 分钟后恢复');
        if (wait > 30 * 60000) throw new Error('GitHub 额度用尽，需要等 ' + Math.ceil(wait / 60000) + ' 分钟');
        log('限流，等待 ' + Math.ceil(wait / 1000) + ' 秒：' + path.slice(0, 90));
        stats.retries++; await sleep(Math.max(1000, wait)); continue;
      }
    }
    if (res.status >= 500) { stats.retries++; await sleep(3000 * attempt); continue; }
    return { status: res.status, data: safeJson(text) };
  }
  return { status: 0, data: null };
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = null; log('任务失败：' + e.message); }
    }
  }));
  return out;
}

// ---------- 搜索：超过 1000 条时按星数区间二分 ----------
async function searchPage(q, page) {
  await sleep(TOKEN ? 2200 : 6500);
  const r = await gh('/search/repositories?q=' + encodeURIComponent(q) + '&sort=stars&order=desc&per_page=100&page=' + page, { kind: 'search' });
  return r.status === 200 && r.data ? r.data : null;
}
export async function searchRepos(q, minStars) {
  const out = [];
  async function band(lo, hi) {
    const qq = q + ' stars:' + (hi === Infinity ? '>=' + lo : lo + '..' + hi);
    const first = await searchPage(qq, 1);
    if (!first) { log('搜索失败：' + qq); return; }
    const total = first.total_count || 0;
    if (total > 1000 && !QUICK) {
      const top = hi === Infinity ? Math.max(lo, ...(first.items || []).map((i) => i.stargazers_count || 0)) : hi;
      if (top > lo) {
        const mid = Math.min(top - 1, Math.max(lo, Math.floor(Math.sqrt(Math.max(lo, 1) * top))));
        await band(mid + 1, hi);
        await band(lo, mid);
        return;
      }
    }
    out.push(...(first.items || []));
    const pages = QUICK ? 1 : Math.min(10, Math.ceil(Math.min(total, 1000) / 100));
    for (let p = 2; p <= pages; p++) {
      const d = await searchPage(qq, p);
      if (!d || !(d.items || []).length) break;
      out.push(...d.items);
    }
  }
  await band(minStars, Infinity);
  return out;
}

// 代码搜索 ghost.json：找没打 topic 的 Cindy 插件（需要 Token，每分钟 10 次）
async function codeSearchGhost() {
  if (!TOKEN) return [];
  const names = new Set();
  for (const q of ['filename:ghost.json minCindyVersion', 'filename:ghost.json schemaVersion tools']) {
    for (let page = 1; page <= 10; page++) {
      await sleep(6500);
      const r = await gh('/search/code?q=' + encodeURIComponent(q) + '&per_page=100&page=' + page, { kind: 'code' });
      const items = r.status === 200 && r.data ? r.data.items || [] : [];
      for (const it of items) if (it.repository && it.path.split('/').length <= 4) names.add(it.repository.full_name);
      if (items.length < 100) break;
    }
  }
  log('代码搜索到含 ghost.json 的仓库 ' + names.size + ' 个');
  return [...names];
}

function looksLikeCindyPlugin(it) {
  const hay = ((it.description || '') + ' ' + (it.topics || []).join(' ')).toLowerCase();
  return /plugin|插件|skill|extension|扩展|market|市场|agent/.test(hay) || (it.topics || []).includes('cindy');
}

// ---------- 仓库结构识别（与插件 main.js 的 analyzeTree 规则一致） ----------
const SKIP_DIR_RE = /(^|\/)(node_modules|\.git|\.github|vendor|dist|target|__pycache__|fixtures?|tests?|__tests__|testdata)(\/|$)/i;
export function analyzeTree(tree) {
  const ghostDirs = [], skillPaths = [];
  let marketplace = false;
  for (const e of (tree && tree.tree) || []) {
    if (e.type !== 'blob') continue;
    const p = e.path;
    if (p === '.claude-plugin/marketplace.json') { marketplace = true; continue; }
    if (SKIP_DIR_RE.test(p)) continue;
    const slash = p.lastIndexOf('/');
    const base = p.slice(slash + 1), dir = slash < 0 ? '' : p.slice(0, slash);
    if (base === 'ghost.json') { if (dir === '' || dir.split('/').length <= 3) ghostDirs.push(dir); }
    else if (base === 'SKILL.md') skillPaths.push(dir);
  }
  const rootPlugin = ghostDirs.includes('');
  const outer = ghostDirs.filter((d) => !ghostDirs.some((g) => g !== d && (g === '' || d.startsWith(g + '/'))));
  const inPlugin = (d) => rootPlugin || outer.some((g) => d === g || d.startsWith(g + '/'));
  const byName = Object.create(null);
  for (const d of skillPaths) {
    if (inPlugin(d)) continue;
    const name = baseName(d), prev = byName[name], depth = d.split('/').length;
    if (prev === undefined || depth < prev.split('/').length || (depth === prev.split('/').length && d < prev)) byName[name] = d;
  }
  const dirs = Object.values(byName).sort();
  let pluginDir = null, subDirs = [];
  if (rootPlugin) pluginDir = '';
  else if (outer.length === 1) pluginDir = outer[0];
  else if (outer.length > 1) subDirs = outer.sort().slice(0, MAX_SUBS);
  const hasPlugin = pluginDir !== null || subDirs.length > 0;
  return {
    kind: hasPlugin && dirs.length ? 'both' : hasPlugin ? 'plugin' : dirs.length ? 'skill' : 'list',
    skills: dirs.length, skill_dirs: dirs.slice(0, MAX_SKILLS_PER_REPO), plugin_dir: pluginDir, sub_dirs: subDirs,
    mk: marketplace, truncated: !!(tree && tree.truncated)
  };
}

// ---------- 文件解析 ----------
// 只解析 frontmatter 顶层的标量字段（name / description 等），支持引号与 > | 多行写法
export function parseFrontmatter(text) {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(text || ''));
  const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    const block = /^[>|][+-]?$/.test(v);
    const more = [];
    while (i + 1 < lines.length && (/^[ \t]+\S/.test(lines[i + 1]) || (block && lines[i + 1].trim() === ''))) more.push(lines[++i].trim());
    const nested = more.length && /^([\w-]+\s*:|- )/.test(more[0]);
    if (block) v = v[0] === '>' ? more.join(' ') : more.join('\n');
    else if (more.length && !nested) v = (v + ' ' + more.join(' ')).trim();
    if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
      v = v[0] === '"' ? v.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, ' ') : v.slice(1, -1).replace(/''/g, "'");
    }
    if (!(kv[1] in out)) out[kv[1]] = v.trim();
  }
  return out;
}
export function firstParagraph(text) {
  const body = String(text || '').replace(/^\uFEFF?---[\s\S]*?\r?\n---[ \t]*\r?\n?/, '');
  let fence = false;
  for (const line of body.split(/\r?\n/)) {
    const s = line.trim();
    if (/^(```|~~~)/.test(s)) { fence = !fence; continue; }
    if (fence || !s || /^(#|<|\||!\[|---|>)/.test(s)) continue;
    return s.replace(/[*_`]/g, '');
  }
  return '';
}
// 只认合法的 Cindy 清单：有 id，且有 schemaVersion / entry / tools / manual / panel / minCindyVersion 之一
export function parseManifest(text) {
  const m = text ? safeJson(text) : null;
  if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) return null;
  if (!(m.schemaVersion || m.entry || m.tools || m.manual || m.panel || m.minCindyVersion)) return null;
  const o = { id: m.id };
  if (m.name) o.n = clip(m.name, 80);
  if (m.description) o.d = clip(m.description, DESC_MAX);
  if (m.version) o.v = String(m.version).slice(0, 20);
  if (Array.isArray(m.tools) && m.tools.length) o.tc = m.tools.length;
  return o;
}
export function skillEntry(full, dir, text) {
  const fm = text ? parseFrontmatter(text) : {};
  const e = { r: full, p: dir, n: clip(fm.name || baseName(dir) || full.split('/')[1], 80) };
  const d = clip(fm.description || (text ? firstParagraph(text) : ''), DESC_MAX);
  if (d) e.d = d;
  return e;
}
const freshFields = (it) => ({ d: clip(it.description, DESC_MAX), s: it.stargazers_count || 0, t: (it.topics || []).slice(0, 8), o: (it.owner && it.owner.id) || 0 });
export function repoEntry(c, a, mans) {
  const it = c.it;
  const e = Object.assign({ f: it.full_name }, freshFields(it), { u: it.pushed_at || '', b: it.default_branch || '', src: c.src, k: a.kind, sk: a.skills });
  if (a.plugin_dir !== null) { e.pd = a.plugin_dir; if (mans[0]) e.m = mans[0]; }
  else if (a.sub_dirs.length) e.subs = a.sub_dirs.map((d, k) => Object.assign({ p: d }, mans[k] || {}));
  if (a.mk) e.mk = 1;
  if (a.truncated) e.tr = 1;
  return e;
}
export function shardOf(full) {
  let h = 0x811c9dc5;
  for (const ch of full) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % SHARDS;
}

// ---------- 批量读文件：有 Token 走 GraphQL（每批 40 个），否则逐个走 contents 接口 ----------
async function fetchBlobs(reqs) {
  const out = new Array(reqs.length).fill(null);
  const n = Math.min(reqs.length, MAX_BLOBS);
  if (TOKEN) {
    const starts = [];
    for (let s = 0; s < n; s += 40) starts.push(s);
    await pool(starts, 4, async (s) => {
      const byRepo = new Map();
      reqs.slice(s, Math.min(s + 40, n)).forEach((r, k) => {
        if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
        byRepo.get(r.repo).push({ i: s + k, path: r.path });
      });
      const names = [...byRepo.keys()];
      const q = 'query{' + names.map((name, ri) => {
        const [owner, repo] = name.split('/');
        return 'r' + ri + ':repository(owner:' + JSON.stringify(owner) + ',name:' + JSON.stringify(repo) + '){' +
          byRepo.get(name).map((f) => 'f' + f.i + ':object(expression:' + JSON.stringify('HEAD:' + f.path) + '){...on Blob{text}}').join('') + '}';
      }).join('') + '}';
      const r = await gh('/graphql', { method: 'POST', body: JSON.stringify({ query: q }), kind: 'graphql', timeout: 120000 });
      const data = r.data && r.data.data;
      if (!data) { log('GraphQL 批次失败（HTTP ' + r.status + '）：' + JSON.stringify((r.data && r.data.errors) || '').slice(0, 200)); return; }
      names.forEach((name, ri) => {
        const node = data['r' + ri];
        if (node) byRepo.get(name).forEach((f) => { const b = node['f' + f.i]; if (b && typeof b.text === 'string') out[f.i] = b.text; });
      });
    });
  } else {
    await pool(reqs.slice(0, n), 4, async (r, i) => {
      const res = await gh('/repos/' + r.repo + '/contents/' + r.path.split('/').map(encodeURIComponent).join('/'));
      if (res.status === 200 && res.data && res.data.content) out[i] = Buffer.from(res.data.content, 'base64').toString('utf8');
    });
  }
  return out;
}

// ---------- 读写索引 ----------
async function loadPrev() {
  const prev = new Map();
  const meta = safeJson(await readFile(join(OUT, 'meta.json'), 'utf8').catch(() => ''));
  if (!meta || !Array.isArray(meta.shards)) return { prev, meta: null };
  for (const s of meta.shards) {
    const d = safeJson(await readFile(join(OUT, s.f), 'utf8').catch(() => ''));
    if (!d) continue;
    for (const r of d.repos || []) prev.set(r.f, { repo: r, skills: [] });
    for (const k of d.skills || []) { const p = prev.get(k.r); if (p) p.skills.push(k); }
  }
  return { prev, meta };
}
export async function writeIndex(dir, repos, skills, extra) {
  await mkdir(dir, { recursive: true });
  const shards = Array.from({ length: SHARDS }, () => ({ repos: [], skills: [] }));
  for (const r of repos) shards[shardOf(r.f)].repos.push(r);
  for (const k of skills) shards[shardOf(k.r)].skills.push(k);
  const list = [];
  for (let i = 0; i < SHARDS; i++) {
    const s = shards[i];
    s.repos.sort((a, b) => b.s - a.s || a.f.localeCompare(b.f));
    s.skills.sort((a, b) => a.r.localeCompare(b.r) || a.p.localeCompare(b.p));
    const f = 'shard-' + String(i).padStart(2, '0') + '.json';
    const text = JSON.stringify(s);
    await writeFile(join(dir, f), text);
    list.push({ f, h: createHash('sha1').update(text).digest('hex').slice(0, 16), bytes: Buffer.byteLength(text), repos: s.repos.length, skills: s.skills.length });
  }
  const meta = Object.assign({ v: 1, generated: new Date().toISOString() }, extra, { shards: list });
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
  return meta;
}

// ---------- 主流程 ----------
async function main() {
  const t0 = Date.now();
  if (env.CI && !TOKEN) throw new Error('缺少 GH_TOKEN：请在仓库 Settings → Secrets and variables → Actions 添加 GH_TOKEN');
  if (!TOKEN) log('没有 GH_TOKEN：匿名额度很少，只适合配合 QUICK=1 LIMIT=… 试跑');
  const { prev, meta: prevMeta } = await loadPrev();
  log('上一版索引：' + prev.size + ' 个仓库');

  const cand = new Map();
  const add = (it, src, via) => {
    if (!it || !it.full_name || it.fork || /cindyjs/i.test(it.full_name)) return;
    const c = cand.get(it.full_name);
    if (!c) { cand.set(it.full_name, { it, src, via }); return; }
    if (src === 'cindy') c.src = 'cindy';
    if (c.via === 'code' && via !== 'code') c.via = via;
  };
  for (const it of await searchRepos('topic:cindy-plugin', 0)) add(it, 'cindy', 'topic');
  for (const it of await searchRepos('cindy plugin in:name,description', 0)) if (looksLikeCindyPlugin(it)) add(it, 'cindy', 'keyword');
  for (const t of QUICK ? SKILL_TOPICS.slice(0, 2) : SKILL_TOPICS) {
    const items = await searchRepos('topic:' + t, MIN_STARS);
    items.forEach((it) => add(it, 'skill', 'topic'));
    log('话题 ' + t + '：' + items.length + ' 个');
  }
  if (!QUICK) {
    const extra = [...(await codeSearchGhost()).map((n) => [n, 'cindy', 'code']),
      ...CINDY_SEEDS.map((n) => [n, 'cindy', 'seed']), ...SKILL_SEEDS.map((n) => [n, 'skill', 'seed'])].filter(([n]) => !cand.has(n));
    await pool(extra, 4, async ([n, src, via]) => { const r = await gh('/repos/' + n); if (r.status === 200 && r.data) add(r.data, src, via); });
  }
  const bySrc = (s) => [...cand.values()].filter((c) => c.src === s).sort((a, b) => (b.it.stargazers_count || 0) - (a.it.stargazers_count || 0));
  let list;
  if (LIMIT) { const k = Math.ceil(LIMIT / 2); list = bySrc('cindy').slice(0, k).concat(bySrc('skill').slice(0, LIMIT - k)); }
  else list = bySrc('cindy').concat(bySrc('skill')).slice(0, MAX_REPOS);
  log('候选仓库 ' + cand.size + ' 个，本次处理 ' + list.length + ' 个');

  const reused = [], work = [];
  for (const c of list) {
    const p = prev.get(c.it.full_name);
    if (p && p.repo.u === (c.it.pushed_at || '') && p.repo.b === (c.it.default_branch || '') && p.repo.src === c.src) reused.push([c, p]);
    else work.push(c);
  }
  log('沿用上一版 ' + reused.length + ' 个，重新读取文件树 ' + work.length + ' 个');
  const trees = await pool(work, 8, async (c) => {
    const name = c.it.full_name, br = c.it.default_branch || 'HEAD';
    let r = await gh('/repos/' + name + '/git/trees/' + encodeURIComponent(br) + '?recursive=1', { timeout: 90000 });
    if (r.status === 404 && br !== 'HEAD') r = await gh('/repos/' + name + '/git/trees/HEAD?recursive=1', { timeout: 90000 });
    if (r.status !== 200 || !r.data || !Array.isArray(r.data.tree)) return { c, fail: r.status };
    return { c, a: analyzeTree(r.data) };
  });
  const analyzed = [];
  for (const [k, x] of trees.entries()) {
    const c = work[k];
    if (x && x.a) { analyzed.push(x); continue; }
    const p = prev.get(c.it.full_name);
    const gone = x && [404, 409, 451].includes(x.fail);
    if (p && !gone) reused.push([c, p]);   // 临时失败：先沿用上一版
  }

  const reqs = [];
  for (const x of analyzed) {
    const dirs = x.a.plugin_dir !== null ? [x.a.plugin_dir] : x.a.sub_dirs;
    x.mf = dirs.map((d) => reqs.push({ repo: x.c.it.full_name, path: (d ? d + '/' : '') + 'ghost.json' }) - 1);
  }
  for (const x of analyzed) {
    x.sk = x.a.skill_dirs.map((d) => [d, reqs.push({ repo: x.c.it.full_name, path: (d ? d + '/' : '') + 'SKILL.md' }) - 1]);
  }
  log('读取文件 ' + Math.min(reqs.length, MAX_BLOBS) + ' / ' + reqs.length + ' 个（插件清单与 SKILL.md）');
  const texts = await fetchBlobs(reqs);

  const repos = [], skills = [];
  let dropped = 0;
  for (const [c, p] of reused) { repos.push(Object.assign({}, p.repo, freshFields(c.it))); skills.push(...p.skills); }
  for (const x of analyzed) {
    const { c, a } = x;
    const mans = x.mf.map((i) => parseManifest(texts[i]));
    if (c.via === 'code' && !mans.some(Boolean)) { dropped++; continue; }
    if (a.kind === 'list' && (c.src === 'cindy' ? c.via === 'code' : (c.it.stargazers_count || 0) < LIST_MIN_STARS)) { dropped++; continue; }
    repos.push(repoEntry(c, a, mans));
    for (const [d, i] of x.sk) skills.push(skillEntry(c.it.full_name, d, texts[i]));
  }
  if (!repos.length) throw new Error('没有收录到任何仓库，保留上一版索引');
  const prevCount = prevMeta && prevMeta.counts ? prevMeta.counts.repos : 0;
  if (prevCount && repos.length < prevCount * 0.5 && !FORCE && !LIMIT) {
    throw new Error('新索引 ' + repos.length + ' 个仓库，比上一版 ' + prevCount + ' 个少一半以上，已中止（确认无误可设 FORCE=1）');
  }
  const counts = {
    repos: repos.length, plugins: repos.filter((r) => r.k === 'plugin' || r.k === 'both').length,
    plugin_subs: repos.reduce((s, r) => s + (r.subs ? r.subs.length : 0), 0),
    skill_repos: repos.filter((r) => r.k === 'skill' || r.k === 'both').length, skills: skills.length,
    lists: repos.filter((r) => r.k === 'list').length, dropped
  };
  await writeIndex(OUT, repos, skills, {
    params: { min_stars: MIN_STARS, list_min_stars: LIST_MIN_STARS, topics: SKILL_TOPICS }, counts,
    stats: Object.assign({}, stats, { seconds: Math.round((Date.now() - t0) / 1000) })
  });
  log('完成：' + JSON.stringify(counts));
  log('API 调用：' + JSON.stringify(stats) + '，用时 ' + Math.round((Date.now() - t0) / 1000) + ' 秒');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('[index] 失败：' + e.message); process.exit(1); });
}
