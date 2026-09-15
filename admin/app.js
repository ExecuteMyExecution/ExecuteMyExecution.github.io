// 纯前端写作后台：直接调用 GitHub Contents API 读写 source/_posts，
// 提交产生的 commit 会触发 .github/workflows/deploy.yml 构建并部署站点。
import * as yaml from 'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.mjs'
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js'

const API = 'https://api.github.com'
const LS = 'nocturne-admin-config'
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
const state = { files: [], dirs: [], dirOfCat: {}, current: null, dirty: false }

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

const repoPath = suffix => `/repos/${cfg.owner}/${cfg.repo}${suffix}`

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
async function connect () {
  say('正在连接仓库…')
  const repo = await gh(repoPath(''))
  await loadCategoryMap()
  await loadTree()
  say(`已连接 ${repo.full_name}@${cfg.branch}，共 ${state.files.length} 篇。`, 'ok')
}

async function loadCategoryMap () {
  try {
    const file = await gh(repoPath(`/contents/_config.yml?ref=${encodeURIComponent(cfg.branch)}`))
    const conf = yaml.load(decodeB64(file.content), YAML_IN) || {}
    state.dirOfCat = conf.category_map || {}
  } catch (e) {
    state.dirOfCat = {}
  }
}

async function loadTree () {
  const tree = await gh(repoPath(`/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`))
  state.files = tree.tree
    .filter(n => n.type === 'blob' && /^source\/(_posts|_drafts)\/.+\.md$/.test(n.path))
    .sort((a, b) => a.path.localeCompare(b.path, 'zh'))
  const dirs = new Set()
  for (const f of state.files) {
    const rel = f.path.replace(/^source\/(_posts|_drafts)\/?/, '')
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    if (dir) dirs.add(dir)
  }
  state.dirs = [...dirs].sort()
  $('dirs').innerHTML = state.dirs.map(d => `<option value="${d}"></option>`).join('')
  renderList()
}

function renderList () {
  const q = $('search').value.trim().toLowerCase()
  const list = $('list')
  list.innerHTML = ''
  let group = null
  for (const f of state.files) {
    if (q && !f.path.toLowerCase().includes(q)) continue
    const rel = f.path.replace(/^source\//, '')
    const dir = rel.slice(0, rel.lastIndexOf('/'))
    if (dir !== group) {
      group = dir
      const g = document.createElement('div')
      g.className = 'group'
      g.textContent = dir
      list.append(g)
    }
    const item = document.createElement('div')
    item.className = 'item' + (state.current && state.current.path === f.path ? ' active' : '')
    item.textContent = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/, '')
    item.title = f.path
    item.onclick = () => openFile(f.path)
    list.append(item)
  }
}
function fillEditor (path, fm, body) {
  const known = new Set([...FM_ORDER])
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
  renderPreview()
}

async function openFile (path) {
  if (!(await confirmDiscard())) return
  say('正在加载 ' + path + ' …')
  const file = await gh(repoPath(`/contents/${encodePath(path)}?ref=${encodeURIComponent(cfg.branch)}`))
  const { fm, body } = splitFM(decodeB64(file.content))
  state.current = { path, sha: file.sha }
  fillEditor(path, fm, body)
  renderList()
  say('已加载 ' + path)
}

const encodePath = p => p.split('/').map(encodeURIComponent).join('/')

function newPost () {
  state.current = null
  fillEditor('source/_posts/' + ($('f-dir').value ? $('f-dir').value + '/' : '') + '.md',
    { title: '', date: nowStr() }, '')
  $('f-file').value = ''
  $('f-title').focus()
  renderList()
  say('新建文章：填写标题后会自动生成文件名，保存即提交并触发部署。')
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
async function save () {
  const btn = $('btn-save')
  btn.disabled = true
  try {
    if (!$('f-title').value.trim()) throw new Error('标题不能为空')
    const text = joinFM(collectFM(), $('body').value)
    const target = currentPath()
    const old = state.current
    const moved = old && old.path !== target
    say((old ? '正在提交修改' : '正在创建文章') + ' → ' + target + ' …')
    const payload = {
      message: `${old ? 'post: 更新' : 'post: 新增'} ${$('f-title').value.trim()}`,
      content: encodeB64(text),
      branch: cfg.branch
    }
    if (old && !moved) payload.sha = old.sha
    const res = await gh(repoPath(`/contents/${encodePath(target)}`), {
      method: 'PUT',
      body: JSON.stringify(payload)
    })
    if (moved) {
      await gh(repoPath(`/contents/${encodePath(old.path)}`), {
        method: 'DELETE',
        body: JSON.stringify({ message: `post: 移除旧路径 ${old.path}`, sha: old.sha, branch: cfg.branch })
      })
    }
    state.current = { path: target, sha: res.content.sha }
    state.dirty = false
    await loadTree()
    say(`已提交 ${target}${moved ? `（原 ${old.path} 已删除，如有同名资源目录需手动搬移）` : ''}\n` +
      `构建约需数分钟，进度见 https://github.com/${cfg.owner}/${cfg.repo}/actions`, 'ok')
  } catch (e) {
    say('提交失败：' + e.message + '\n若提示 409/422，多为文件已在别处变更，请「刷新」后重新打开该文章。', 'err')
  } finally {
    btn.disabled = false
  }
}

async function remove () {
  if (!state.current) return say('当前不是仓库中已有的文章。', 'err')
  if (!confirm(`确认从仓库删除 ${state.current.path}？此操作会直接提交到 ${cfg.branch} 分支。`)) return
  try {
    await gh(repoPath(`/contents/${encodePath(state.current.path)}`), {
      method: 'DELETE',
      body: JSON.stringify({
        message: `post: 删除 ${state.current.path}`, sha: state.current.sha, branch: cfg.branch
      })
    })
    const gone = state.current.path
    state.current = null
    state.dirty = false
    await loadTree()
    newPost()
    say('已删除 ' + gone + '（同名资源目录未删除，需要时请手动清理）', 'ok')
  } catch (e) {
    say('删除失败：' + e.message, 'err')
  }
}
// post_asset_folder: true —— 图片放在与文章同名的目录里，正文用相对文件名引用。
async function uploadImage (file) {
  const path = currentPath()
  const assetDir = path.replace(/\.md$/, '')
  const target = `${assetDir}/${file.name}`
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
  insertAtCursor(`![](${file.name})`)
  say('已上传 ' + target + '，正文已插入引用。', 'ok')
}

function insertAtCursor (text) {
  const el = $('body')
  const start = el.selectionStart
  el.value = el.value.slice(0, start) + text + el.value.slice(el.selectionEnd)
  el.selectionStart = el.selectionEnd = start + text.length
  el.focus()
  state.dirty = true
  renderPreview()
}

function renderPreview () {
  if (!$('preview').classList.contains('on')) return
  $('preview').innerHTML = marked.parse($('body').value, { gfm: true, breaks: true })
}

async function confirmDiscard () {
  return !state.dirty || confirm('当前修改尚未提交，确定放弃？')
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
  const target = `${workerOrigin}/auth?origin=${encodeURIComponent(location.origin)}`
  const popup = window.open(target, 'nocturne-admin-auth', 'width=760,height=800')
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
$('btn-save').onclick = save
$('btn-delete').onclick = remove
$('btn-preview').onclick = () => {
  $('preview').classList.toggle('on')
  renderPreview()
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
$('body').oninput = () => { state.dirty = true; renderPreview() }
for (const id of ['f-title', 'f-date', 'f-cover', 'f-tags', 'f-cats', 'f-desc', 'f-extra', 'f-file', 'f-status', 'f-dir']) {
  $(id).oninput = () => { state.dirty = true }
}
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save() }
})
window.addEventListener('beforeunload', e => { if (state.dirty) e.preventDefault() })

newPost()
updateAuthUI()
if (legacyToken) {
  saveConfig()
  say('检测到旧版本存在 localStorage 里的令牌，已删除。请到 GitHub 上撤销该 PAT，然后用「登录 GitHub」重新授权。', 'err')
} else if (getToken()) {
  connect().catch(e => say('连接失败：' + e.message, 'err'))
} else if (cfg.authUrl) {
  say('尚未登录。点右上角「登录 GitHub」开始。')
} else {
  openSettings()
}

