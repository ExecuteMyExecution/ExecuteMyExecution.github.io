// 纯前端写作后台：读写 GitHub 上的 source/_posts，改动先在本地暂存，
// 攒够一批后用 Git Data API 打成一个 commit，推送即触发站点构建。
import {
  buildTree, diffLines, collapseDiff, escapeHtml, assetDirOf, isRelativeSrc, previewDoc,
  detectConflicts, isNoOpChange
} from './lib.js'

// 外部依赖都来自公共 CDN，逐个镜像轮试，避免单一 CDN 不可达就整页失效。
async function importAny (urls) {
  let last
  for (const url of urls) {
    try {
      return await import(url)
    } catch (e) {
      last = e
    }
  }
  throw new Error(`依赖加载失败（CDN 均不可达）：${urls[0]}\n${last && last.message}`)
}

const yaml = await importAny([
  'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.mjs',
  'https://fastly.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.mjs',
  'https://unpkg.com/js-yaml@4.1.0/dist/js-yaml.mjs'
])

// markdown 渲染只有预览用得到，按需加载：CDN 挂了也不影响编辑与提交。
let md = null
async function ensureMd () {
  if (md) return md
  const [mi, table, attrs] = await Promise.all([
    importAny(['https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/+esm',
      'https://fastly.jsdelivr.net/npm/markdown-it@14.1.0/+esm',
      'https://esm.sh/markdown-it@14.1.0']),
    importAny(['https://cdn.jsdelivr.net/npm/markdown-it-multimd-table@4.2.3/+esm',
      'https://fastly.jsdelivr.net/npm/markdown-it-multimd-table@4.2.3/+esm',
      'https://esm.sh/markdown-it-multimd-table@4.2.3']),
    importAny(['https://cdn.jsdelivr.net/npm/markdown-it-attrs@4.3.1/+esm',
      'https://fastly.jsdelivr.net/npm/markdown-it-attrs@4.3.1/+esm',
      'https://esm.sh/markdown-it-attrs@4.3.1'])
  ])
  // 与 _config.yml 的 markdown.render 保持一致
  md = mi.default({ html: true, xhtmlOut: true, breaks: true, linkify: true, typographer: false })
    .use(table.default, { multiline: true, rowspan: true, headerless: true })
    .use(attrs.default)
  return md
}

const API = 'https://api.github.com'
const LS = 'nocturne-admin-config'
const LS_CHANGES = 'nocturne-admin-changes'
const LS_COLLAPSED = 'nocturne-admin-collapsed'
const SS_TOKEN = 'nocturne-admin-token'
const FM_ORDER = ['title', 'date', 'updated', 'tags', 'categories', 'cover', 'description']
const YAML_IN = { schema: yaml.JSON_SCHEMA }
const YAML_OUT = { schema: yaml.JSON_SCHEMA, lineWidth: -1, noRefs: true, flowLevel: 1 }

const $ = id => document.getElementById(id)
const saved = JSON.parse(localStorage.getItem(LS) || '{}')
// 早期版本把 PAT 存在 localStorage，这里主动清掉。
const legacyToken = saved.token
delete saved.token
const cfg = Object.assign(
  { owner: 'ExecuteMyExecution', repo: 'Blog-Hexo', branch: 'main', authUrl: '' },
  saved
)

const state = {
  files: [],
  shaOf: new Map(),
  dirs: [],
  dirOfCat: {},
  current: null, // { path, sha } —— 远端基线
  changes: new Map(), // path -> { text, baseSha, baseText, action, movedFrom, title }
  collapsed: new Set(JSON.parse(localStorage.getItem(LS_COLLAPSED) || '[]')),
  imageCache: new Map(),
  dirty: false
}

// 令牌只放 sessionStorage：关掉标签页即失效，也不会被其他标签页共享。
const getToken = () => sessionStorage.getItem(SS_TOKEN) || ''
function setToken (token) {
  if (token) sessionStorage.setItem(SS_TOKEN, token)
  else sessionStorage.removeItem(SS_TOKEN)
  updateAuthUI()
}
function saveConfig () {
  localStorage.setItem(LS, JSON.stringify({
    owner: cfg.owner, repo: cfg.repo, branch: cfg.branch, authUrl: cfg.authUrl
  }))
}

function updateAuthUI () {
  $('btn-login').textContent = getToken() ? '已登录' : '登录 GitHub'
}

function say (msg, kind = '') {
  $('status').textContent = msg
  $('status').className = kind
}

const repoPath = suffix => `/repos/${cfg.owner}/${cfg.repo}${suffix}`
const encodePath = p => p.split('/').map(encodeURIComponent).join('/')

async function gh (path, opts = {}) {
  const token = getToken()
  if (!token) throw new Error('尚未登录，请点右上角「登录 GitHub」')
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {})
    }
  })
  if (res.status === 401) {
    setToken('')
    throw new Error('登录已过期（GitHub App 令牌 8 小时失效），请重新登录')
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${(await res.text()).slice(0, 200)}`)
  return res.status === 204 ? null : res.json()
}

const decodeB64 = b64 =>
  new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)))

function encodeB64 (input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(out)
}
function splitFM (text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return { fm: {}, body: text }
  return { fm: yaml.load(m[1], YAML_IN) || {}, body: text.slice(m[0].length) }
}

function joinFM (fm, body) {
  const ordered = {}
  for (const k of FM_ORDER) if (fm[k] !== undefined) ordered[k] = fm[k]
  for (const k of Object.keys(fm)) if (ordered[k] === undefined) ordered[k] = fm[k]
  const head = yaml.dump(ordered, YAML_OUT).trimEnd()
  return `---\n${head}\n---\n\n${body.replace(/^\s*\n/, '')}`
}

function nowStr () {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 分类字段：Hexo 用「嵌套数组」表示层级，界面上一行一条链，用 / 分隔层级。
function catsToText (value) {
  if (!value) return ''
  const groups = Array.isArray(value)
    ? (Array.isArray(value[0]) ? value : [value])
    : [[value]]
  return groups.map(g => (Array.isArray(g) ? g : [g]).join(' / ')).join('\n')
}

function textToCats (text) {
  const groups = text.split('\n')
    .map(line => line.split('/').map(s => s.trim()).filter(Boolean))
    .filter(g => g.length)
  return groups.length ? groups : undefined
}

const listToText = v => (Array.isArray(v) ? v.join(', ') : v || '')
const textToList = t => {
  const items = t.split(/[,，]/).map(s => s.trim()).filter(Boolean)
  return items.length ? items : undefined
}
// ---------- 本地暂存 ----------
// 改动先落在 localStorage，不立刻产生 commit，攒成一批再提交。
function loadChanges () {
  try {
    state.changes = new Map(JSON.parse(localStorage.getItem(LS_CHANGES) || '[]'))
  } catch (e) {
    state.changes = new Map()
  }
}

function persistChanges () {
  localStorage.setItem(LS_CHANGES, JSON.stringify([...state.changes]))
  updateChangeUI()
}

function updateChangeUI () {
  const n = state.changes.size
  $('btn-changes').textContent = `变更 ${n}`
  $('btn-changes').classList.toggle('has', n > 0)
  $('btn-commit').disabled = n === 0
  renderList()
}

function stageCurrent () {
  const title = $('f-title').value.trim()
  if (!title) return say('标题不能为空', 'err')
  const path = currentPath()
  const base = state.current
  const prev = state.changes.get(path) || {}
  const change = {
    action: 'upsert',
    text: joinFM(collectFM(), $('body').value),
    title,
    baseSha: base ? base.sha : (prev.baseSha ?? null),
    baseText: prev.baseText !== undefined ? prev.baseText : (base ? base.text : ''),
    movedFrom: base && base.path !== path ? base.path : (prev.movedFrom ?? null)
  }
  // 与远端基线相比毫无变化时不入暂存，免得攒出空 commit
  if (isNoOpChange(change) && !state.changes.has(path)) {
    state.dirty = false
    return say('内容与仓库一致，无需暂存', 'ok')
  }
  state.changes.set(path, change)
  state.dirty = false
  persistChanges()
  say(`已暂存 ${path} —— 共 ${state.changes.size} 项待提交，点「提交」一次性推送`, 'ok')
}

function stageDelete () {
  const path = state.current ? state.current.path : currentPath()
  if (!state.shaOf.has(path)) {
    state.changes.delete(path)
    persistChanges()
    newPost()
    return say(`${path} 尚未提交过，已直接丢弃`, 'ok')
  }
  if (!confirm(`把 ${path} 标记为删除？提交后才会真正从仓库移除。`)) return
  state.changes.set(path, {
    action: 'delete', baseSha: state.shaOf.get(path), baseText: '', title: path
  })
  state.dirty = false
  persistChanges()
  say(`已暂存删除 ${path}，提交后生效`, 'ok')
}
async function discardChange (path) {
  state.changes.delete(path)
  persistChanges()
  if (state.current && state.current.path === path) {
    if (state.shaOf.has(path)) await openFile(path)
    else newPost()
  } else if (!state.shaOf.has(path)) {
    renderList()
  }
}

// ---------- 提交 ----------
// Contents API 一次只能改一个文件，用 Git Data API 才能把多个文件打成一个 commit。
async function commitAll (message) {
  const entries = [...state.changes.entries()]
  if (!entries.length) throw new Error('没有待提交的改动')

  await loadTree() // 提交前刷新远端状态，做冲突预检
  const conflicts = detectConflicts(entries, state.shaOf)
  if (conflicts.length) {
    throw new Error('以下文件在远端已被改动，请「查看差异」确认后丢弃或重新打开：\n' +
      conflicts.join('\n'))
  }

  const treeItems = []
  for (const [path, c] of entries) {
    if (c.action === 'delete') {
      treeItems.push({ path, mode: '100644', type: 'blob', sha: null })
      continue
    }
    const blob = await gh(repoPath('/git/blobs'), {
      method: 'POST',
      body: JSON.stringify({ content: encodeB64(c.text), encoding: 'base64' })
    })
    treeItems.push({ path, mode: '100644', type: 'blob', sha: blob.sha })
    if (c.movedFrom && c.movedFrom !== path) {
      treeItems.push({ path: c.movedFrom, mode: '100644', type: 'blob', sha: null })
    }
  }

  const ref = await gh(repoPath(`/git/ref/heads/${encodeURIComponent(cfg.branch)}`))
  const baseCommit = await gh(repoPath(`/git/commits/${ref.object.sha}`))
  const tree = await gh(repoPath('/git/trees'), {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: treeItems })
  })
  const commit = await gh(repoPath('/git/commits'), {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha] })
  })
  await gh(repoPath(`/git/refs/heads/${encodeURIComponent(cfg.branch)}`), {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha })
  })
  return commit
}
function defaultMessage () {
  const entries = [...state.changes.entries()]
  if (entries.length === 1) {
    const [, c] = entries[0]
    if (c.action === 'delete') return `post: 删除 ${c.title}`
    return c.baseSha ? `post: 更新 ${c.title}` : `post: 新增 ${c.title}`
  }
  return `post: 更新 ${entries.length} 个文件`
}

function openChanges () {
  renderChanges()
  $('chg-msg').value = defaultMessage()
  $('dlg-changes').showModal()
}

function renderChanges (selected) {
  const list = $('chg-list')
  list.innerHTML = ''
  const entries = [...state.changes.entries()]
  if (!entries.length) {
    list.innerHTML = '<div class="hint">没有待提交的改动</div>'
    $('chg-diff').innerHTML = ''
    return
  }
  const active = selected || entries[0][0]
  for (const [path, c] of entries) {
    const row = document.createElement('div')
    row.className = 'chg-item' + (path === active ? ' active' : '')
    const kind = c.action === 'delete' ? '删除' : (c.baseSha ? '修改' : '新增')
    row.innerHTML = `<span class="tag ${c.action === 'delete' ? 'del' : (c.baseSha ? 'mod' : 'new')}">${kind}</span>` +
      `<span class="p">${escapeHtml(path.replace(/^source\//, ''))}</span>`
    const drop = document.createElement('button')
    drop.textContent = '丢弃'
    drop.className = 'danger'
    drop.onclick = async e => {
      e.stopPropagation()
      if (!confirm(`丢弃 ${path} 的本地改动？此操作不可撤销。`)) return
      await discardChange(path)
      renderChanges()
      $('chg-msg').value = defaultMessage()
    }
    row.append(drop)
    row.onclick = () => renderChanges(path)
    list.append(row)
  }
  renderDiff(active)
}

function renderDiff (path) {
  const c = state.changes.get(path)
  const box = $('chg-diff')
  if (!c) return (box.innerHTML = '')
  if (c.action === 'delete') {
    box.innerHTML = `<div class="hint">整篇删除：${escapeHtml(path)}（提交后从仓库移除，同名资源目录需手动清理）</div>`
    return
  }
  const rows = collapseDiff(diffLines(c.baseText || '', c.text), 3)
  const head = c.movedFrom ? `<div class="hint">路径变更：${escapeHtml(c.movedFrom)} → ${escapeHtml(path)}</div>` : ''
  box.innerHTML = head + '<table class="diff">' + rows.map(r => {
    if (r.type === 'gap') return `<tr class="gap"><td colspan="3">… 省略 ${r.count} 行 …</td></tr>`
    const sign = r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' '
    return `<tr class="${r.type}"><td class="n">${r.before || ''}</td>` +
      `<td class="n">${r.after || ''}</td><td class="t">${sign} ${escapeHtml(r.text)}</td></tr>`
  }).join('') + '</table>'
}
async function doCommit () {
  const msg = $('chg-msg').value.trim() || defaultMessage()
  const btn = $('btn-do-commit')
  btn.disabled = true
  try {
    const commit = await commitAll(msg)
    const openPath = state.current ? state.current.path : null
    state.changes.clear()
    persistChanges()
    await loadTree()
    if (openPath && state.shaOf.has(openPath)) await openFile(openPath)
    else newPost()
    $('dlg-changes').close()
    say(`已提交 ${commit.sha.slice(0, 7)}：${msg.split('\n')[0]}\n` +
      `构建约需数分钟，进度见 https://github.com/${cfg.owner}/${cfg.repo}/actions`, 'ok')
  } catch (e) {
    say('提交失败：' + e.message, 'err')
  } finally {
    btn.disabled = false
  }
}

// ---------- 目录树 ----------
async function loadTree () {
  const tree = await gh(repoPath(`/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`))
  state.files = tree.tree
    .filter(n => n.type === 'blob' && /^source\/(_posts|_drafts)\/.+\.md$/.test(n.path))
    .sort((a, b) => a.path.localeCompare(b.path, 'zh'))
  state.shaOf = new Map(state.files.map(f => [f.path, f.sha]))
  const dirs = new Set()
  for (const f of state.files) {
    const rel = f.path.replace(/^source\/(_posts|_drafts)\/?/, '')
    if (rel.includes('/')) dirs.add(rel.slice(0, rel.lastIndexOf('/')))
  }
  state.dirs = [...dirs].sort()
  $('dirs').innerHTML = state.dirs.map(d => `<option value="${escapeHtml(d)}"></option>`).join('')
  renderList()
}

function toggleDir (path) {
  if (state.collapsed.has(path)) state.collapsed.delete(path)
  else state.collapsed.add(path)
  localStorage.setItem(LS_COLLAPSED, JSON.stringify([...state.collapsed]))
  renderList()
}

function renderList () {
  const q = $('search').value.trim().toLowerCase()
  const paths = new Set(state.files.map(f => f.path))
  // 本地新建但尚未提交的文件也要出现在树里
  for (const [path, c] of state.changes) if (c.action !== 'delete') paths.add(path)
  const visible = [...paths].filter(p => !q || p.toLowerCase().includes(q))
    .sort((a, b) => a.localeCompare(b, 'zh'))
  const list = $('list')
  list.innerHTML = ''
  renderNode(buildTree(visible), list, 0, !!q)
}
function renderNode (node, container, depth, forceOpen) {
  for (const dir of node.dirs.values()) {
    const collapsed = !forceOpen && state.collapsed.has(dir.path)
    const row = document.createElement('div')
    row.className = 'dir'
    row.style.paddingLeft = depth * 12 + 6 + 'px'
    row.innerHTML = `<span class="caret">${collapsed ? '▸' : '▾'}</span>` +
      `<span class="name">${escapeHtml(dir.name)}</span>` +
      `<span class="count">${countFiles(dir)}</span>`
    row.onclick = () => toggleDir(dir.path)
    container.append(row)
    if (collapsed) continue
    const box = document.createElement('div')
    container.append(box)
    renderNode(dir, box, depth + 1, forceOpen)
  }
  for (const file of node.files) {
    const change = state.changes.get(file.path)
    const item = document.createElement('div')
    item.className = 'item' +
      (state.current && state.current.path === file.path ? ' active' : '') +
      (change ? ' staged' : '')
    item.style.paddingLeft = depth * 12 + 20 + 'px'
    item.textContent = file.name.replace(/\.md$/, '')
    item.title = file.path + (change ? `（已暂存${change.action === 'delete' ? '删除' : ''}）` : '')
    item.onclick = () => openFile(file.path).catch(e => say('打开失败：' + e.message, 'err'))
    container.append(item)
  }
}

function countFiles (node) {
  let n = node.files.length
  for (const dir of node.dirs.values()) n += countFiles(dir)
  return n
}

// ---------- 编辑器 ----------
function fillEditor (path, fm, body) {
  const known = new Set(FM_ORDER)
  const extra = {}
  for (const [k, v] of Object.entries(fm)) if (!known.has(k)) extra[k] = v
  $('f-title').value = fm.title || ''
  $('f-date').value = fm.date || ''
  $('f-cover').value = fm.cover || ''
  $('f-tags').value = listToText(fm.tags)
  $('f-cats').value = catsToText(fm.categories)
  $('f-desc').value = fm.description || ''
  $('f-extra').value = Object.keys(extra).length ? yaml.dump(extra, YAML_OUT).trimEnd() : ''
  $('body').value = body
  const rel = path.replace(/^source\//, '')
  const seg = rel.indexOf('/')
  $('f-status').value = rel.slice(0, seg) || '_posts'
  const tail = rel.slice(seg + 1)
  $('f-dir').value = tail.includes('/') ? tail.slice(0, tail.lastIndexOf('/')) : ''
  $('f-file').value = tail.slice(tail.lastIndexOf('/') + 1)
  state.dirty = false
  resetPreviewTop = true // 换了文章，预览回到顶部
  schedulePreview()
}
async function openFile (path) {
  if (!(await confirmDiscard())) return
  const change = state.changes.get(path)
  let text
  let baseSha = state.shaOf.get(path) || null
  let baseText = ''
  if (state.shaOf.has(path)) {
    const file = await gh(repoPath(`/contents/${encodePath(path)}?ref=${encodeURIComponent(cfg.branch)}`))
    baseText = decodeB64(file.content)
    baseSha = file.sha
  }
  if (change && change.action !== 'delete') {
    text = change.text
    if (change.baseText !== undefined) baseText = change.baseText
  } else {
    text = baseText
  }
  state.current = { path, sha: baseSha, text: baseText }
  const { fm, body } = splitFM(text)
  fillEditor(path, fm, body)
  renderList()
  const note = change
    ? (change.action === 'delete' ? '（已暂存删除，提交后移除）' : '（显示的是本地暂存版本）')
    : ''
  say('已打开 ' + path + note)
}

function newPost () {
  state.current = null
  const dir = $('f-dir').value
  fillEditor(`source/_posts/${dir ? dir + '/' : ''}.md`, { title: '', date: nowStr() }, '')
  $('f-file').value = ''
  $('f-title').focus()
  renderList()
  say('新建文章：填好标题后按 Cmd/Ctrl+S 暂存，攒够改动再点「提交」')
}

function collectFM () {
  const fm = {}
  const extra = $('f-extra').value.trim()
  if (extra) Object.assign(fm, yaml.load(extra, YAML_IN) || {})
  fm.title = $('f-title').value.trim()
  fm.date = $('f-date').value.trim() || nowStr()
  const tags = textToList($('f-tags').value)
  const cats = textToCats($('f-cats').value)
  if (tags) fm.tags = tags
  if (cats) fm.categories = cats
  if ($('f-cover').value.trim()) fm.cover = $('f-cover').value.trim()
  if ($('f-desc').value.trim()) fm.description = $('f-desc').value.trim()
  return fm
}

function currentPath () {
  const dir = $('f-dir').value.trim().replace(/^\/+|\/+$/g, '')
  let file = $('f-file').value.trim()
  if (!file) file = ($('f-title').value.trim() || 'untitled') + '.md'
  if (!file.endsWith('.md')) file += '.md'
  $('f-file').value = file
  return `source/${$('f-status').value}/${dir ? dir + '/' : ''}${file}`
}

async function confirmDiscard () {
  return !state.dirty || confirm('当前编辑尚未暂存，确定放弃这些修改？')
}
// ---------- 图片 ----------
// post_asset_folder: true —— 图片放在与文章同名的目录里，正文用相对文件名引用。
// 图片走 Contents API 单独提交（不进暂存区），避免大体积二进制塞进 localStorage。
async function uploadImage (file) {
  const target = `${assetDirOf(currentPath())}/${file.name}`
  say('正在上传 ' + target + ' …')
  const payload = {
    message: `assets: 上传 ${file.name}`,
    content: encodeB64(await file.arrayBuffer()),
    branch: cfg.branch
  }
  try {
    const exist = await gh(repoPath(`/contents/${encodePath(target)}?ref=${encodeURIComponent(cfg.branch)}`))
    if (exist && exist.sha) payload.sha = exist.sha
  } catch (e) { /* 不存在则直接创建 */ }
  await gh(repoPath(`/contents/${encodePath(target)}`), { method: 'PUT', body: JSON.stringify(payload) })
  state.imageCache.delete(target)
  insertAtCursor(`![](${file.name})`)
  say('已上传 ' + target + '（图片是立即提交的，正文改动仍需暂存后一起提交）', 'ok')
}

function insertAtCursor (text) {
  const el = $('body')
  const start = el.selectionStart
  el.value = el.value.slice(0, start) + text + el.value.slice(el.selectionEnd)
  el.selectionStart = el.selectionEnd = start + text.length
  el.focus()
  state.dirty = true
  schedulePreview()
}

// ---------- 预览 ----------
// 预览用 iframe：首次写入外壳文档，之后只调用文档内的 __ntRender 增量替换正文，
// 不重载 iframe，因此编辑时滚动位置保持不变。
let previewTimer = null
let previewWin = null // 外壳文档就绪后的 contentWindow
let previewPending = null // 外壳加载期间到来的最新内容
let resetPreviewTop = false // 切换文章时让预览回到顶部

function schedulePreview () {
  if (!$('preview').classList.contains('on')) return
  clearTimeout(previewTimer)
  previewTimer = setTimeout(() => {
    renderPreview().catch(e => say('预览失败：' + e.message, 'err'))
  }, 350)
}

async function renderPreview () {
  const iframe = $('preview')
  if (!iframe.classList.contains('on')) return
  const renderer = await ensureMd()
  const html = await resolveImages(renderer.render($('body').value))
  if (previewWin && previewWin.__ntRender) {
    // 只替换 .body.md 的 innerHTML，浏览器会自动保留滚动位置——不重载、不跳顶。
    // 编辑时预览停在原处；只有切换文章时才主动回到顶部。
    previewWin.__ntRender(html)
    if (resetPreviewTop) {
      const box = previewScroller()
      if (box) box.scrollTop = 0
      resetPreviewTop = false
    }
    return
  }
  // 首次：写入外壳，等脚本就绪后渲染最新内容
  previewPending = html
  if (!iframe.dataset.init) {
    iframe.dataset.init = '1'
    iframe.onload = () => {
      previewWin = iframe.contentWindow
      // 预览侧滚动 → 编辑区跟随
      previewWin.addEventListener('scroll', () => syncScroll('pv'), { passive: true })
      if (previewWin.__ntRender) previewWin.__ntRender(previewPending)
    }
    iframe.srcdoc = previewDoc('')
  }
}

// 编辑区与预览按比例双向联动（手动滚动时用）。
// 用"谁先滚谁在一小段时间内当主导"的时间戳锁来打断反馈回环。
let scrollLeader = null
let leaderUntil = 0
let typingUntil = 0 // 打字期间抑制"编辑区→预览"的按比例联动
function previewScroller () {
  return previewWin && (previewWin.document.scrollingElement || previewWin.document.documentElement)
}
function takeLead (source) {
  scrollLeader = source
  leaderUntil = performance.now() + 150
}
function syncScroll (source) {
  const box = previewScroller()
  if (!box || !$('preview').classList.contains('on')) return
  // 正在打字时，textarea 会自动滚动以跟随光标；此时不要按比例拖动预览，
  // 否则会把预览"甩"到一个按比例估算的位置（就是之前"改末行也跳"的根因）。
  // 预览位置改由重渲染时的光标锚定负责。
  if (source === 'ed' && performance.now() < typingUntil) return
  if (scrollLeader && scrollLeader !== source && performance.now() < leaderUntil) return
  takeLead(source)
  const ed = $('body')
  const [from, to] = source === 'ed' ? [ed, box] : [box, ed]
  const denom = from.scrollHeight - from.clientHeight
  const ratio = denom > 0 ? from.scrollTop / denom : 0
  to.scrollTop = ratio * (to.scrollHeight - to.clientHeight)
}

// 相对路径图片取自仓库（私有仓库无法直接用 raw 链接），取回后转 blob URL。
async function resolveImages (html) {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, 'text/html')
  const dir = assetDirOf(currentPath())
  const failed = []
  await Promise.all([...doc.querySelectorAll('img')].map(async img => {
    const src = img.getAttribute('src')
    if (!isRelativeSrc(src)) return
    try {
      img.setAttribute('src', await imageBlobUrl(`${dir}/${src}`))
    } catch (e) {
      img.removeAttribute('src')
      img.setAttribute('alt', `[图片加载失败：${src}]`)
      failed.push(`${src} —— ${e.message}`)
    }
  }))
  if (failed.length) say('预览中有图片未能取回：\n' + failed.join('\n'), 'err')
  return doc.getElementById('root').innerHTML
}

// Contents API 的 JSON 形式对超过 1MB 的文件只返回空 content，
// 所以这里用 raw 媒体类型直接拿字节。
async function imageBlobUrl (path) {
  if (state.imageCache.has(path)) return state.imageCache.get(path)
  const token = getToken()
  if (!token) throw new Error('尚未登录')
  const url = `${API}${repoPath(`/contents/${encodePath(path)}`)}?ref=${encodeURIComponent(cfg.branch)}`
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github.raw',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`
    }
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const ext = (path.split('.').pop() || '').toLowerCase()
  const type = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
  const blobUrl = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }))
  state.imageCache.set(path, blobUrl)
  return blobUrl
}

// 预览用 iframe 直接加载站点自己的 /css/app.css，代码块结构也复刻主题，
// 具体拼装见 lib.js 的 previewDoc / PREVIEW_SCRIPT。

// ---------- 授权与连接 ----------
async function connect () {
  say('正在连接仓库…')
  const repo = await gh(repoPath(''))
  await loadCategoryMap()
  await loadTree()
  say(`已连接 ${repo.full_name}@${cfg.branch}，共 ${state.files.length} 篇` +
    (state.changes.size ? `，本地另有 ${state.changes.size} 项待提交` : '') + '。', 'ok')
}

async function loadCategoryMap () {
  try {
    const file = await gh(repoPath(`/contents/_config.yml?ref=${encodeURIComponent(cfg.branch)}`))
    state.dirOfCat = (yaml.load(decodeB64(file.content), YAML_IN) || {}).category_map || {}
  } catch (e) {
    state.dirOfCat = {}
  }
}

function suggestCategories () {
  const dir = $('f-dir').value.trim().replace(/^\/+|\/+$/g, '')
  if (!dir || $('f-cats').value.trim()) return
  const catOfDir = {}
  for (const [zh, en] of Object.entries(state.dirOfCat)) catOfDir[en] = zh
  $('f-cats').value = dir.split('/').map(seg => catOfDir[seg] || seg).join(' / ')
}

// GitHub 授权走 Worker 代理：弹窗完成 OAuth，令牌经 postMessage 回传，不出现在 URL 里。
function login () {
  if (!cfg.authUrl) {
    openSettings()
    return say('请先在设置里填入授权 Worker 地址。', 'err')
  }
  let workerOrigin
  try {
    workerOrigin = new URL(cfg.authUrl).origin
  } catch (e) {
    return say('Worker 地址不是合法 URL：' + cfg.authUrl, 'err')
  }
  const popup = window.open(`${workerOrigin}/auth?origin=${encodeURIComponent(location.origin)}`,
    'nocturne-admin-auth', 'width=760,height=800')
  if (!popup) return say('弹窗被浏览器拦截，请允许本站弹窗后重试。', 'err')
  say('已打开 GitHub 授权窗口…')

  const onMessage = async event => {
    if (event.origin !== workerOrigin) return
    const data = event.data
    if (!data || data.source !== 'nocturne-admin-auth' || !data.token) return
    window.removeEventListener('message', onMessage)
    setToken(data.token)
    try {
      await connect()
    } catch (e) {
      say('连接失败：' + e.message, 'err')
    }
  }
  window.addEventListener('message', onMessage)
}

function openSettings () {
  $('s-owner').value = cfg.owner
  $('s-repo').value = cfg.repo
  $('s-branch').value = cfg.branch
  $('s-auth').value = cfg.authUrl
  $('s-token').value = ''
  $('dlg-settings').showModal()
}
// ---------- 事件绑定 ----------
$('btn-settings').onclick = openSettings
$('btn-login').onclick = () => {
  if (getToken() && !confirm('当前已登录，重新登录会替换现有令牌，继续？')) return
  login()
}
$('s-cancel').onclick = () => $('dlg-settings').close()
$('s-logout').onclick = () => {
  setToken('')
  $('dlg-settings').close()
  say('已退出登录（令牌已从本标签页清除）。如需彻底撤销授权：GitHub → Settings → Applications。', 'ok')
}
$('s-save').onclick = async () => {
  cfg.owner = $('s-owner').value.trim()
  cfg.repo = $('s-repo').value.trim()
  cfg.branch = $('s-branch').value.trim() || 'main'
  cfg.authUrl = $('s-auth').value.trim().replace(/\/+$/, '')
  saveConfig()
  const manual = $('s-token').value.trim()
  $('s-token').value = ''
  $('dlg-settings').close()
  if (manual) setToken(manual)
  if (!getToken()) return login()
  try {
    await connect()
  } catch (e) {
    say('连接失败：' + e.message, 'err')
  }
}

$('btn-refresh').onclick = async () => {
  try {
    await loadTree()
    say(`已刷新，共 ${state.files.length} 篇。`, 'ok')
  } catch (e) {
    say('刷新失败：' + e.message, 'err')
  }
}
$('search').oninput = renderList
$('btn-new').onclick = async () => { if (await confirmDiscard()) newPost() }
$('btn-stage').onclick = stageCurrent
$('btn-changes').onclick = openChanges
$('btn-commit').onclick = openChanges
$('btn-delete').onclick = stageDelete
$('chg-close').onclick = () => $('dlg-changes').close()
$('btn-do-commit').onclick = doCommit
$('btn-preview').onclick = () => {
  const on = $('preview').classList.toggle('on')
  $('btn-preview').classList.toggle('active', on)
  if (on) renderPreview().catch(e => say('预览失败：' + e.message, 'err'))
}
$('btn-upload').onclick = () => {
  if (!$('f-file').value.trim() && !$('f-title').value.trim()) {
    return say('请先填写标题或文件名，图片会存到与文章同名的资源目录中。', 'err')
  }
  $('file-input').click()
}
$('file-input').onchange = async e => {
  const file = e.target.files[0]
  e.target.value = ''
  if (!file) return
  try {
    await uploadImage(file)
  } catch (err) {
    say('上传失败：' + err.message, 'err')
  }
}
$('f-dir').onchange = suggestCategories
$('body').oninput = () => {
  state.dirty = true
  typingUntil = performance.now() + 700 // 打字窗口内不做按比例联动，交给光标锚定
  schedulePreview()
}
$('body').addEventListener('scroll', () => syncScroll('ed'), { passive: true })
for (const id of ['f-title', 'f-date', 'f-cover', 'f-tags', 'f-cats', 'f-desc', 'f-extra', 'f-file',
  'f-status', 'f-dir']) {
  $(id).oninput = () => { state.dirty = true }
}
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault()
    stageCurrent()
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    if (state.changes.size) openChanges()
  }
})
window.addEventListener('beforeunload', e => { if (state.dirty) e.preventDefault() })

// ---------- 启动 ----------
loadChanges()
newPost()
updateAuthUI()
updateChangeUI()
if (legacyToken) {
  saveConfig()
  say('检测到旧版本存在 localStorage 里的令牌，已删除。请到 GitHub 上撤销该 PAT，然后用「登录 GitHub」重新授权。', 'err')
} else if (getToken()) {
  connect().catch(e => say('连接失败：' + e.message, 'err'))
} else if (cfg.authUrl) {
  say('尚未登录。点右上角「登录 GitHub」开始。' +
    (state.changes.size ? `本地有 ${state.changes.size} 项待提交的改动。` : ''))
} else {
  openSettings()
}
