// 后台的纯逻辑部分：不碰 DOM、不依赖 CDN，便于单独测试。

// 把 source/_posts/a/b/x.md 这样的路径列表折成可折叠的目录树。
export function buildTree (paths) {
  const root = { name: '', path: '', dirs: new Map(), files: [] }
  for (const path of paths) {
    const rel = path.replace(/^source\//, '')
    const segs = rel.split('/')
    const file = segs.pop()
    let node = root
    let acc = 'source'
    for (const seg of segs) {
      acc += '/' + seg
      if (!node.dirs.has(seg)) {
        node.dirs.set(seg, { name: seg, path: acc, dirs: new Map(), files: [] })
      }
      node = node.dirs.get(seg)
    }
    node.files.push({ name: file, path })
  }
  return root
}

// 行级 diff（LCS）。文章体量小，O(n*m) 足够。
export function diffLines (before, after) {
  const a = before.split('\n')
  const b = after.split('\n')
  const n = a.length
  const m = b.length
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const out = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i], before: i + 1, after: j + 1 })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: 'del', text: a[i], before: i + 1 })
      i++
    } else {
      out.push({ type: 'add', text: b[j], after: j + 1 })
      j++
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i], before: ++i })
  while (j < m) out.push({ type: 'add', text: b[j], after: ++j })
  return out
}
// 只保留有变化的行，两侧各留 context 行上下文，段落之间插入折叠标记。
export function collapseDiff (rows, context = 2) {
  const keep = new Set()
  rows.forEach((row, idx) => {
    if (row.type === 'same') return
    for (let k = idx - context; k <= idx + context; k++) if (rows[k]) keep.add(k)
  })
  const out = []
  let skipped = 0
  rows.forEach((row, idx) => {
    if (keep.has(idx)) {
      if (skipped) {
        out.push({ type: 'gap', count: skipped })
        skipped = 0
      }
      out.push(row)
    } else {
      skipped++
    }
  })
  if (skipped) out.push({ type: 'gap', count: skipped })
  return out
}

// Prism 高亮后的 HTML 按行切开时，跨行的 span 会被截断，这里逐行补齐闭合标签。
// 主题的代码块是「一行一个 <tr><td data-num><td><pre>」结构，必须先按行拆分。
export function splitHighlightedLines (html) {
  const lines = html.split('\n')
  const out = []
  let open = []
  for (const line of lines) {
    const prefix = open.map(tag => tag).join('')
    const tokens = line.match(/<\/?span[^>]*>/g) || []
    for (const tok of tokens) {
      if (tok.startsWith('</')) open.pop()
      else open.push(tok)
    }
    out.push(prefix + line + '</span>'.repeat(open.length))
  }
  return out
}

export function escapeHtml (text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// 文章路径 → 资源目录（post_asset_folder 约定：与文章同名的目录）
export const assetDirOf = postPath => postPath.replace(/\.md$/, '')

// 提交前的冲突预检：远端文件的 sha 与暂存时记录的基线不一致，说明别处改过。
// entries: [path, change][]，shaOf: Map<path, sha>（刚拉取的远端状态）。
export function detectConflicts (entries, shaOf) {
  return entries.filter(([path, c]) => {
    const remote = shaOf.get(path)
    if (c.action === 'delete') return !!remote && remote !== c.baseSha
    if (!c.baseSha) return !!remote // 本地新建，但远端已存在同名文件
    return !!remote && remote !== c.baseSha
  }).map(([path]) => path)
}

// 暂存改动是否是「与基线相比毫无内容变化」的空操作（避免制造空 commit）。
export const isNoOpChange = c =>
  c.action !== 'delete' && c.baseText !== undefined && c.text === c.baseText && !c.movedFrom

// front-matter 语义比较：忽略键顺序，用于判断表单值是否与原文件真的不同。
export function deepEqual (a, b) {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
  }
  return false
}

export const isRelativeSrc = src =>
  !!src && !/^([a-z]+:)?\/\//i.test(src) && !src.startsWith('/') && !src.startsWith('data:') &&
  !src.startsWith('blob:')

// 预览 iframe 里跑的脚本：暴露 window.__ntRender(html) 供父页面增量刷新，
// 只替换 .body.md 的内容、不重载文档，因此滚动位置得以保留。
// 代码块改写成主题结构（figure.highlight > table > tr > td[data-num] + pre）后交给 Prism 上色。
export const PREVIEW_SCRIPT = `
${splitHighlightedLines.toString()}
function toThemeBlock (code) {
  var pre = code.parentElement
  if (!pre || pre.tagName !== 'PRE') return
  var m = code.className.match(/language-([\\w-]+)/)
  var lang = m ? m[1] : 'plain'
  var lines = splitHighlightedLines(code.innerHTML.replace(/\\n$/, ''))
  var rows = lines.map(function (line, i) {
    return '<tr><td data-num="' + (i + 1) + '"></td><td><pre>' + line + '</pre></td></tr>'
  }).join('')
  var figure = document.createElement('figure')
  figure.className = 'highlight ' + lang
  figure.innerHTML = '<figcaption data-lang="' + lang + '"></figcaption><table><tbody>' +
    rows + '</tbody></table>'
  pre.replaceWith(figure)
}
function highlight () {
  document.querySelectorAll('pre > code:not([class*=language-])').forEach(toThemeBlock)
  if (window.Prism) Prism.highlightAll()
}
if (window.Prism) {
  Prism.hooks.add('complete', function (env) { if (env.element) toThemeBlock(env.element) })
}
window.__ntRender = function (html) {
  var root = document.querySelector('.body.md')
  if (!root) return
  root.innerHTML = html
  highlight()
}
highlight()
`

// 预览文档直接引用站点自己的 /css/app.css，因此排版与线上一致；
// data-theme=dark 对应主题的暗色变量。body 必须带 loaded 类：主题靠它把
// overflow 从 hidden 打开（线上是 JS 加的），否则预览无法滚动。
export function previewDoc (bodyHtml = '') {
  return `<!DOCTYPE html><html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/app.css">
<style>
  html { scrollbar-width: thin; scrollbar-color: #3f4550 transparent; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: #3f4550; border: 2px solid #1b1d21; border-radius: 8px; }
  ::-webkit-scrollbar-thumb:hover { background: #515866; }
  html, body { background: #1b1d21; height: auto !important; min-height: 100%; }
  body { margin: 0; padding: 12px 14px !important; overflow: hidden auto !important; }
  html, body, .body.md { overflow-anchor: none; }
  .body.md span:not(.katex), .body.md p, .body.md pre, .body.md li, .body.md a {
    content-visibility: visible;
    contain-intrinsic-size: none;
  }
  .body.md img { max-width: 100%; height: auto; }
</style></head>
<body class="loaded"><div class="article wrap"><div class="body md">${bodyHtml}</div></div>
<script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js" data-manual></script>
<script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/plugins/autoloader/prism-autoloader.min.js"></script>
<script>${PREVIEW_SCRIPT}</script></body></html>`
}
