/* JSON Viewer - 仿 bejson jsonviewernew 布局与功能，纯原生实现，树视图虚拟滚动 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var ROW_H = 18;           // 树每行高度（与 ExtJS 一致）
  var GRID_MAX_ROWS = 20000; // 属性表最多直接渲染的行数
  var MAX_SCROLL_H = 30000000; // 浏览器对元素高度有上限（Chrome 约 3350 万 px），超出后按比例缩放滚动条
  var STORAGE_KEY = null;   // 启用登录验证时为 'jsonviewer_text:<用户名>'，确认身份前为 null（不读写）
  var FMT_KEY = null;       // 格式模式（auto 或手动指定的格式），与文本同样按用户隔离：'jsonviewer_fmt:<用户名>'

  // 大文本（设计文档 §16）：非 JSON 源文本的解析、或转换的源文本超过 confirmBytes 时先确认；
  // 预计耗时超过 busyMs 时先绘制「正在解析…」/「正在转换…」再阻塞计算。JSON 源的解析不受这两条影响。
  // 测试可经 window.jsonviewer._setLimits 临时修改。
  var MB = 1024 * 1024;
  var LIMITS = { confirmBytes: 20 * MB, busyMs: 300 };
  // 实测速率（ms/MB，本机 headless Chrome，§16.1）；json.stringify 与 xml.stringify 为估计值
  var RATES = {
    parse: { json: 5, yaml: 60, toml: 45, xml: 105 },
    stringify: { json: 10, yaml: 100, toml: 30, xml: 40 }
  };

  // 解析、序列化与各格式适配器见 formats.js（window.JV）
  var JV = window.JV, BigNum = JV.BigNum, DateVal = JV.DateVal, FORMATS = JV.FORMATS;
  var stringifyJSON = JV.stringifyJSON;

  /* ======================================================================
   *  节点模型（按需懒创建子节点）
   * ==================================================================== */
  function typeOf(v) {
    if (v === null) return 'null';
    if (v instanceof BigNum) return 'number';
    var t = typeof v;
    if (t === 'object') {
      if (v instanceof DateVal) return 'date';
      return Array.isArray(v) ? 'array' : 'object';
    }
    return t; // string / number / boolean
  }
  function makeNode(key, value, parent) {
    return {
      key: key, value: value, type: typeOf(value), parent: parent,
      depth: parent ? parent.depth + 1 : 0,
      last: true, children: null, expanded: false, text: null, indent: null, row: -1
    };
  }
  function isContainer(n) { return n.type === 'object' || n.type === 'array'; }
  function childrenOf(n) {
    if (n.children) return n.children;
    var arr = [], v = n.value, i, keys;
    if (n.type === 'array') {
      for (i = 0; i < v.length; i++) arr.push(makeNode(String(i), v[i], n));
    } else if (n.type === 'object') {
      keys = Object.keys(v);
      for (i = 0; i < keys.length; i++) arr.push(makeNode(keys[i], v[keys[i]], n));
    }
    for (i = 0; i < arr.length - 1; i++) arr[i].last = false;
    n.children = arr;
    return arr;
  }
  function valueText(n) {
    switch (n.type) {
      case 'null': return 'null';
      case 'string': return '"' + n.value + '"';
      case 'number': return String(n.value);
      case 'boolean': return n.value ? 'true' : 'false';
      case 'date': return n.value.raw;
      default: return '';
    }
  }
  function rawValueText(n) {   // 复制 Value 用：字符串不带引号，容器给出 JSON 文本
    if (isContainer(n)) return stringifyJSON(n.value, 2);
    if (n.type === 'string') return n.value;
    return valueText(n);
  }
  function nodeText(n) {
    if (n.text !== null) return n.text;
    var t;
    if (!n.parent) t = isContainer(n) ? n.key : n.key + ' : ' + valueText(n);   // 根节点的 key 是格式名（JSON / YAML / ...）
    else if (isContainer(n)) t = n.key;
    else t = n.key + ' : ' + valueText(n);
    n.text = t;
    return t;
  }
  // 遍历整棵（已存在或按需创建的）子树，不递归，避免深层 JSON 栈溢出
  function walk(root, fn, createChildren) {
    var stack = [root], n, ch, i;
    while (stack.length) {
      n = stack.pop();
      fn(n);
      if (!isContainer(n)) continue;
      ch = createChildren ? childrenOf(n) : n.children;
      if (!ch) continue;
      for (i = ch.length - 1; i >= 0; i--) stack.push(ch[i]);
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  /* ======================================================================
   *  树视图（虚拟滚动：只渲染可视区域行）
   * ==================================================================== */
  var TREE_HINT = '在左侧粘贴 JSON / YAML / TOML / XML 后，这里显示树形视图。';
  var tree = {
    body: $('treeBody'), spacer: $('treeSpacer'), layer: $('treeLayer'),
    root: null, rows: [], selected: null, message: '',   // message：没有根节点时显示的提示（为空则用通用提示）
    rStart: -1, rEnd: -1, dirty: true, raf: 0,
    maxScroll: 0, virtMax: 0,

    setRoot: function (root, message) {
      this.root = root;
      this.message = message || '';
      this.selected = null;
      if (root) root.expanded = isContainer(root);
      this.flatten();
      this.body.scrollTop = 0;
      this.invalidate();
    },
    flatten: function () {
      var rows = [];
      if (this.root) {
        var stack = [this.root], n, ch, i;
        while (stack.length) {
          n = stack.pop();
          n.row = rows.length;
          rows.push(n);
          if (n.expanded && isContainer(n)) {
            ch = childrenOf(n);
            for (i = ch.length - 1; i >= 0; i--) stack.push(ch[i]);
          }
        }
      }
      this.rows = rows;
      this.dirty = true;
    },
    invalidate: function () {
      this.dirty = true;
      this.render();
    },
    scheduleRender: function () {
      var self = this;
      if (self.raf) return;
      self.raf = requestAnimationFrame(function () { self.raf = 0; self.render(); });
    },
    indentOf: function (n) {
      var p = n.parent;
      if (!p) return '';
      if (p.indent === null) {
        p.indent = this.indentOf(p) + (p.last ? '<span class="tb"></span>' : '<span class="tl"></span>');
      }
      return p.indent;
    },
    rowHtml: function (n, i) {
      var ec, cont = isContainer(n);
      if (cont) ec = (n.last ? 'ee' : 'e') + (n.expanded ? 'm' : 'p');
      else ec = n.last ? 'ee' : 'e';
      return '<div class="tn' + (n === this.selected ? ' sel' : '') + '" data-r="' + i + '">' +
        this.indentOf(n) +
        '<span class="ec ' + ec + '"></span>' +
        '<span class="ni ' + n.type + '"></span>' +
        '<a><span>' + escapeHtml(nodeText(n)) + '</span></a></div>';
    },
    // 把滚动条位置映射到“虚拟像素”：行数太多时元素高度封顶，按比例换算
    layout: function () {
      var total = this.rows.length, h = this.body.clientHeight;
      var virtH = total * ROW_H;
      var spacerH = Math.min(virtH, MAX_SCROLL_H);
      this.spacer.style.height = spacerH + 'px';
      this.maxScroll = Math.max(0, spacerH - h);
      this.virtMax = Math.max(0, virtH - h);
    },
    virtualTop: function () {
      if (this.maxScroll <= 0) return 0;
      return this.body.scrollTop / this.maxScroll * this.virtMax;
    },
    scrollToVirtual: function (v) {
      if (this.virtMax <= 0) { this.body.scrollTop = 0; return; }
      v = Math.max(0, Math.min(v, this.virtMax));
      this.body.scrollTop = v / this.virtMax * this.maxScroll;
    },
    render: function () {
      var total = this.rows.length;
      this.layout();
      if (!total) {
        this.layer.style.top = '0px';
        this.layer.innerHTML = this.root ? '' : '<div class="tree-empty">' + escapeHtml(this.message || TREE_HINT) + '</div>';
        this.rStart = this.rEnd = -1;
        return;
      }
      var h = this.body.clientHeight, vTop = this.virtualTop();
      var start = Math.max(0, Math.floor(vTop / ROW_H) - 8);
      var end = Math.min(total, Math.ceil((vTop + h) / ROW_H) + 8);
      // 图层顶部 = 当前滚动位置 - 首个渲染行相对可视区顶部的虚拟偏移
      this.layer.style.top = (this.body.scrollTop - (vTop - start * ROW_H)) + 'px';
      if (!this.dirty && start === this.rStart && end === this.rEnd) return;
      var html = [];
      for (var i = start; i < end; i++) html.push(this.rowHtml(this.rows[i], i));
      this.layer.innerHTML = html.join('');
      this.rStart = start; this.rEnd = end; this.dirty = false;
    },
    toggle: function (n) {
      if (!isContainer(n)) return;
      n.expanded = !n.expanded;
      this.flatten();
      this.render();
    },
    select: function (n, ensureVisible) {
      var prev = this.selected;
      this.selected = n;
      if (!ensureVisible) {
        // 只切换类名，不重绘图层：保持 DOM 稳定，也让浏览器能识别连续两次点击
        var oldEl = prev ? this.layer.querySelector('.tn[data-r="' + prev.row + '"]') : null;
        var newEl = this.layer.querySelector('.tn[data-r="' + n.row + '"]');
        if (oldEl && this.rows[prev.row] === prev) oldEl.classList.remove('sel');
        if (newEl && this.rows[n.row] === n) { newEl.classList.add('sel'); grid.show(n); return; }
      }
      if (ensureVisible) {
        var p = n.parent, changed = false;
        while (p) { if (!p.expanded) { p.expanded = true; changed = true; } p = p.parent; }
        if (changed || this.rows[n.row] !== n) this.flatten();
        this.layout();
        var rowTop = n.row * ROW_H, h = this.body.clientHeight, vTop = this.virtualTop();
        if (rowTop < vTop || rowTop + ROW_H > vTop + h) {
          this.scrollToVirtual(rowTop - Math.floor(h / 2));
        }
      }
      this.invalidate();
      grid.show(n);
    },
    expandSub: function (n) {
      walk(n, function (x) { if (isContainer(x)) x.expanded = true; }, true);
      this.flatten(); this.render();
    },
    collapseSub: function (n) {
      walk(n, function (x) { x.expanded = false; }, false);
      this.flatten(); this.render();
    },
    expandAll: function () { if (this.root) this.expandSub(this.root); },
    collapseAll: function () { if (this.root) this.collapseSub(this.root); },
    nodeAt: function (el) {
      var row = el && el.closest ? el.closest('.tn') : null;
      return row ? this.rows[+row.getAttribute('data-r')] : null;
    }
  };

  tree.body.addEventListener('scroll', function () { tree.scheduleRender(); });
  window.addEventListener('resize', function () { tree.scheduleRender(); });
  // 单击选中；同一节点 350ms 内再次点击视为双击：非叶节点展开/折叠（自行判定，不依赖 dblclick 事件）
  var lastClick = { node: null, time: 0 };
  tree.layer.addEventListener('click', function (e) {
    var n = tree.nodeAt(e.target);
    if (!n) return;
    if (e.target.classList.contains('ec')) { tree.toggle(n); return; }
    var now = Date.now();
    var isDouble = lastClick.node === n && now - lastClick.time < 350;
    lastClick.node = n; lastClick.time = isDouble ? 0 : now;
    tree.select(n, false);
    if (isDouble && isContainer(n)) tree.toggle(n);
  });
  tree.layer.addEventListener('mousedown', function (e) { if (e.detail > 1) e.preventDefault(); });  // 双击不选中文字
  tree.layer.addEventListener('contextmenu', function (e) {
    var n = tree.nodeAt(e.target);
    if (!n) return;
    e.preventDefault();
    ctxMenu.show(n, e.clientX, e.clientY);
  });

  /* ======================================================================
   *  右侧属性表：显示选中节点（叶子则取其父节点）的直接子项
   * ==================================================================== */
  var grid = {
    tbody: $('gridRows'),
    show: function (n) {
      if (!n) { this.tbody.innerHTML = ''; return; }
      if (!isContainer(n) && n.parent) n = n.parent;
      var rows = [], list, i, c;
      if (isContainer(n)) {
        list = childrenOf(n);
        var limit = Math.min(list.length, GRID_MAX_ROWS);
        for (i = 0; i < limit; i++) {
          c = list[i];
          rows.push('<tr><td class="name" title="' + escapeHtml(c.key) + '">' + escapeHtml(c.key) +
            '</td><td class="value">' + escapeHtml(isContainer(c) ? '...' : valueText(c)) + '</td></tr>');
        }
        if (list.length > limit) {
          rows.push('<tr><td class="more" colspan="2">… 还有 ' + (list.length - limit) + ' 项未显示</td></tr>');
        }
      } else {
        rows.push('<tr><td class="name">' + escapeHtml(n.key) + '</td><td class="value">' + escapeHtml(valueText(n)) + '</td></tr>');
      }
      this.tbody.innerHTML = rows.join('');
      $('gridBody').scrollTop = 0;
    }
  };

  /* ======================================================================
   *  右键菜单
   * ==================================================================== */
  var ctxMenu = {
    el: $('ctxMenu'), node: null,
    show: function (n, x, y) {
      this.node = n;
      var el = this.el;
      el.hidden = false;
      var w = el.offsetWidth, h = el.offsetHeight;
      if (x + w > window.innerWidth) x = window.innerWidth - w - 2;
      if (y + h > window.innerHeight) y = window.innerHeight - h - 2;
      el.style.left = x + 'px';
      el.style.top = y + 'px';
    },
    hide: function () { this.el.hidden = true; this.node = null; },
    act: function (act) {
      var n = this.node;
      if (!n) return;
      switch (act) {
        case 'copyKey': copyToClipboard(n.key, 'Key 复制成功'); break;
        case 'copyValue': copyToClipboard(rawValueText(n), 'Value 复制成功'); break;
        case 'copyBoth':
          copyToClipboard(isContainer(n) ? n.key + ' : ' + rawValueText(n) : nodeText(n), 'Key+Value 复制成功');
          break;
        case 'expandSub': tree.expandSub(n); break;
        case 'expandAll': tree.expandAll(); break;
        case 'collapseSub': tree.collapseSub(n); break;
        case 'collapseAll': tree.collapseAll(); break;
      }
    }
  };
  ctxMenu.el.addEventListener('click', function (e) {
    var item = e.target.closest('.ctx-item');
    if (!item) return;
    var act = item.getAttribute('data-act');
    ctxMenu.act(act);
    ctxMenu.hide();
  });
  document.addEventListener('mousedown', function (e) {
    if (!ctxMenu.el.hidden && !ctxMenu.el.contains(e.target)) ctxMenu.hide();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { ctxMenu.hide(); dialog.hide(); pwdDialog.hide(); optsMenu.hide(); confirmDlg.close(false); }
  });
  tree.body.addEventListener('scroll', function () { ctxMenu.hide(); });
  window.addEventListener('blur', function () { ctxMenu.hide(); });

  /* ======================================================================
   *  对话框 / 提示
   * ==================================================================== */
  var dialog = {
    mask: $('dialogMask'),
    show: function (title, html, wide) {
      $('dialogTitle').textContent = title;
      $('dialogBody').innerHTML = html;
      this.mask.firstElementChild.classList.toggle('wide', !!wide);
      this.mask.hidden = false;
      $('dialogOk').focus();
    },
    hide: function () { this.mask.hidden = true; }
  };
  $('dialogOk').addEventListener('click', function () { dialog.hide(); });
  dialog.mask.addEventListener('click', function (e) { if (e.target === dialog.mask) dialog.hide(); });

  // 确认对话框：ask 返回 Promise<boolean>；取消、Esc、点遮罩都算取消；再次 ask 时先按取消结束上一个
  var confirmDlg = {
    mask: $('confirmMask'), resolve: null,
    ask: function (title, text) {
      var self = this;
      this.close(false);
      $('confirmTitle').textContent = title;
      $('confirmBody').textContent = text;
      this.mask.hidden = false;
      $('confirmOk').focus();
      return new Promise(function (r) { self.resolve = r; });
    },
    close: function (ok) {
      var r = this.resolve;
      if (!r) return;
      this.resolve = null;
      this.mask.hidden = true;
      r(ok);
    }
  };
  $('confirmOk').addEventListener('click', function () { confirmDlg.close(true); });
  $('confirmCancel').addEventListener('click', function () { confirmDlg.close(false); });
  confirmDlg.mask.addEventListener('click', function (e) { if (e.target === confirmDlg.mask) confirmDlg.close(false); });

  function estMs(kind, id, len) { return RATES[kind][id] * len / MB; }
  function sizeText(len) {
    var mb = len / MB;
    return mb >= 10 ? Math.round(mb) + ' MB' : mb >= 0.1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(len / 1024)) + ' KB';
  }
  function secsText(ms) {
    var s = ms / 1000;
    return s < 1 ? '不到 1 秒' : ' ' + (s < 10 ? +s.toFixed(1) : Math.round(s)) + ' 秒';
  }
  // 「文本约 32 MB，按 YAML 解析预计需要 2 秒，期间页面无响应，是否继续？」
  function costText(len, action, ms) {
    return '文本约 ' + sizeText(len) + '，' + action + '预计需要' + secsText(ms) + '，期间页面无响应，是否继续？';
  }

  // 中栏的忙碌提示（解析、文本工具用；转换在自己的面板里提示）。show 返回令牌，只有最后一次 show 的令牌能隐藏
  var busy = {
    el: $('busyTip'), owner: 0, seq: 0,
    show: function (msg) { this.el.textContent = msg; this.el.hidden = false; return (this.owner = ++this.seq); },
    hide: function (t) { if (t === this.owner) this.el.hidden = true; }
  };
  function twoFrames() {
    return new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
  }

  var toastTimer = 0;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2000);
  }

  function copyToClipboard(text, msg) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      toast(ok ? msg : '复制失败，请手动复制');
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { toast(msg); }, fallback);
    } else {
      fallback();
    }
  }

  /* ======================================================================
   *  编辑区与解析流程
   *  格式模式 fmtMode：'auto'（自动识别）或手动指定的格式 id；curFmt 为当前生效的格式，
   *  决定编辑器高亮、左栏标题、工具栏可用性与根节点文字。适配器见 formats.js。
   * ==================================================================== */
  var docChangedSinceParse = false;
  var langComp = new CM.Compartment();
  var view = new CM.EditorView({
    state: CM.EditorState.create({
      doc: '',
      extensions: [
        CM.lineNumbers(), CM.highlightActiveLineGutter(), CM.history(), CM.drawSelection(),
        CM.highlightActiveLine(), CM.bracketMatching(),
        langComp.of(FORMATS.json.language()), CM.syntaxHighlighting(CM.defaultHighlightStyle),
        CM.placeholder('将 JSON / YAML / TOML / XML 数据粘贴到这里!'),
        CM.indentUnit.of('    '),
        CM.keymap.of([{ key: 'Ctrl-Enter', mac: 'Cmd-Enter', run: function () { check(true); return true; } }]
          .concat(CM.defaultKeymap, CM.historyKeymap, CM.searchKeymap, [CM.indentWithTab])),
        CM.EditorView.updateListener.of(function (u) { if (u.docChanged) docChangedSinceParse = true; })
      ]
    }),
    parent: $('edit')
  });
  var edit = {
    getValue: function () { return view.state.doc.toString(); },
    // userEvent 不属于 input.type / delete 时，CodeMirror 的撤销历史不会把它与相邻的修改合并（「应用到左侧」用来保证单独一步撤销）
    setValue: function (text, userEvent) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: userEvent });
    },
    setLanguage: function (ext) { view.dispatch({ effects: langComp.reconfigure(ext) }); },
    focus: function () { view.focus(); },
    goTo: function (pos) {
      pos = Math.max(0, Math.min(pos, view.state.doc.length));
      view.dispatch({ selection: { anchor: pos }, effects: CM.EditorView.scrollIntoView(pos, { y: 'center' }) });
      view.focus();
    },
    lineCol: function (pos) {
      var doc = view.state.doc;
      pos = Math.max(0, Math.min(pos, doc.length));
      var line = doc.lineAt(pos);
      return { line: line.number, col: pos - line.from + 1 };
    }
  };

  var fmtMode = 'auto';
  var curFmt = 'json';
  var lastParsed = null, lastMode = null;
  var pending = null;                     // 懒加载进行中时为其 Promise（whenIdle 用）
  var parseOpts = { inferTypes: false };  // XML 类型推断默认关闭
  var fmtSelect = $('fmtSelect');

  // 手动模式直接用手动值；自动模式识别（空文本按 JSON）
  function resolveFormat(text) { return fmtMode === 'auto' ? JV.detect(text) : fmtMode; }

  // 左栏工具栏按钮与所需能力（§14.4）；不可用时置灰并在 title 里说明原因
  var TOOL_CAPS = [['btnFormat', 'format'], ['btnMinify', 'minify'], ['btnMinifyEscape', 'escape'], ['btnUnescape', 'escape']];
  var TOOL_OFF_TITLE = {
    btnMinify: { yaml: 'YAML 的缩进有语义，不能删除空格', toml: 'TOML 的换行有语义，不能删除空格' }
  };
  function updateToolbar(ad) {
    for (var i = 0; i < TOOL_CAPS.length; i++) {
      var b = $(TOOL_CAPS[i][0]), ok = !!ad.caps[TOOL_CAPS[i][1]];
      b.disabled = !ok;
      b.title = ok ? '' : ((TOOL_OFF_TITLE[b.id] || {})[ad.id] || '仅 JSON 可用，当前为 ' + ad.label);
    }
  }
  function updateBadge() {
    fmtSelect.options[0].textContent = fmtMode === 'auto' ? '自动 · ' + FORMATS[curFmt].label : '自动';
    fmtSelect.value = fmtMode;
  }
  function setCurrentFormat(id) {
    if (id !== curFmt) {
      var ad = FORMATS[id];
      curFmt = id;
      edit.setLanguage(ad.language());
      $('leftTitle').textContent = ad.label + '数据';
      updateToolbar(ad);
    }
    updateBadge();
  }

  function firstNonSpace(text) {
    var m = /\S/.exec(text.slice(0, 4096));
    return m ? m[0] : '';
  }

  function showFormatError(ad, err, text) {
    var isFE = err instanceof JV.FormatError;
    var msg = isFE ? err.message : String(err && err.message || err);
    var off = isFE ? err.offset : -1;
    var where = '';
    if (off >= 0) {
      var pos = edit.lineCol(off);
      where = '<p>位置' + (err.approx ? '（近似）' : '') + '：第 ' + pos.line + ' 行，第 ' + pos.col + ' 列（光标已定位）</p>';
      edit.goTo(off);
    }
    var hint = '';
    if (fmtMode === 'auto') {
      hint = '当前按 ' + ad.label + ' 解析（自动识别）。';
      var c = firstNonSpace(text);
      hint += ad.id === 'json' && (c === '{' || c === '[') ? '如果这是 YAML 流式写法，请在左上角手动选择 YAML。' : '如格式不对，请在左上角手动选择。';
      hint = '<p class="hint">' + hint + '</p>';
    }
    dialog.show(ad.label + ' 错误', ad.label + ' 格式错误' + where + '<pre>' + escapeHtml(msg) + '</pre>' + hint);
  }

  // 懒加载包加载失败：登录失效则跳转登录页，否则提示刷新
  function vendorFailed(ad) {
    tree.setRoot(null, '加载 ' + ad.label + ' 解析器失败，请刷新重试');
    setSource({ kind: 'loadfail', ad: ad });
    vendorFailNotice(ad);
  }
  function vendorFailNotice(ad) {
    fetch('api/me', { credentials: 'same-origin', cache: 'no-store' }).then(function (res) {
      if (res.status === 401) { location.href = 'login'; return; }
      toast('加载 ' + ad.label + ' 解析器失败，请刷新重试');
    }, function () { toast('加载 ' + ad.label + ' 解析器失败，请刷新重试'); });
  }

  // 适配器已加载则同步执行 fn；否则先懒加载再执行
  function withAdapter(ad, fn) {
    if (ad.loaded()) return fn();
    var p = ad.ensureLoaded().then(function () {
      if (pending === p) pending = null;
      fn();
    }, function () {
      if (pending === p) pending = null;
      vendorFailed(ad);
    });
    pending = p;
    return null;
  }

  // 登记进行中的异步解析（确认框、忙碌提示），供 whenIdle 等待
  function trackPending(p) {
    var q = p.then(function () { if (pending === q) pending = null; }, function () { if (pending === q) pending = null; });
    pending = q;
    return null;
  }

  /* 返回 true / false；需要异步时返回 null：首次懒加载解析库、大文本确认框、忙碌提示（完成后自动继续）。
   * how.confirmed：已确认过的文本（等于当前文本时不再弹确认框）；how.onCancel：用户在确认框里取消时调用。
   * JSON 源始终同步解析，不经确认框与忙碌提示。 */
  var checkSeq = 0;
  function check(force, how) {
    how = how || {};
    docChangedSinceParse = false;
    var text = edit.getValue();
    if (!force && text === lastParsed && fmtMode === lastMode) return true;
    var tok = ++checkSeq;
    if (!text.trim()) {
      lastParsed = text; lastMode = fmtMode;
      setCurrentFormat(fmtMode === 'auto' ? 'json' : fmtMode);
      tree.setRoot(null);
      grid.show(null);
      search.reset();
      setSource({ kind: 'empty' });
      return true;
    }
    var ad = FORMATS[resolveFormat(text)];
    // 大文本确认放在一切状态改动之前：取消时格式、树、转换面板都保持原样
    if (ad.id !== 'json' && how.confirmed !== text && text.length > LIMITS.confirmBytes) {
      return trackPending(confirmDlg.ask('解析大文本',
        costText(text.length, '按 ' + ad.label + ' 解析', estMs('parse', ad.id, text.length))).then(function (ok) {
        if (tok !== checkSeq) return;
        if (ok) check(true, { confirmed: text });
        else if (how.onCancel) how.onCancel();
      }));
    }
    setCurrentFormat(ad.id);
    if (!ad.loaded()) {
      lastParsed = null;
      tree.setRoot(null, '正在加载 ' + ad.label + ' 解析器…');
      grid.show(null);
      search.reset();
      setSource({ kind: 'loading', ad: ad });
      return withAdapter(ad, function () { check(true, { confirmed: text }); });
    }
    if (ad.id !== 'json' && estMs('parse', ad.id, text.length) > LIMITS.busyMs) {
      var bt = busy.show('正在解析…');
      return trackPending(twoFrames().then(function () {
        try {
          if (tok === checkSeq) parseNow(ad, text);
        } finally {
          busy.hide(bt);
        }
      }));
    }
    return parseNow(ad, text);
  }

  // 解析并更新树、属性表与转换源；返回 true / false
  function parseNow(ad, text) {
    var res;
    try {
      res = ad.parse(text, parseOpts);
    } catch (err) {
      setSource({ kind: 'error', ad: ad, err: err });
      showFormatError(ad, err, text);
      return false;
    }
    lastParsed = text; lastMode = fmtMode;
    var label = ad.label + (res.docCount > 1 ? '（' + res.docCount + ' 个文档）' : '');
    if (res.docCount === 0) {
      tree.setRoot(null, label + ' 文档为空');
      grid.show(null);
    } else {
      var root = makeNode(label, res.value, null);
      tree.setRoot(root);
      grid.show(root);
    }
    search.reset();
    saveText(text);
    setSource(res.docCount === 0 ? { kind: 'nodoc', ad: ad } :
      { kind: 'ok', fmt: ad.id, value: res.value, docCount: res.docCount, warnings: res.warnings, size: text.length });
    for (var i = 0; i < res.warnings.length; i++) {
      if (res.warnings[i].code === 'yaml-scalar-root') toast('解析结果是单个字符串，可能不是 YAML');
    }
    return true;
  }

  function setFormat(mode) {
    if (mode !== 'auto' && !FORMATS[mode]) return false;
    var prev = fmtMode;
    fmtMode = mode;
    saveFmt();
    updateBadge();
    // 大文本确认框里取消：格式模式也退回原值
    return check(true, { onCancel: function () { fmtMode = prev; saveFmt(); updateBadge(); } });
  }
  fmtSelect.addEventListener('change', function () { setFormat(fmtSelect.value); });

  // 源格式懒加载与解析、转换面板的目标库加载与转换都完成后 resolve
  function whenIdle() {
    var p = pending || conv.busy;
    return p ? p.then(whenIdle, whenIdle) : Promise.resolve();
  }

  function saveText(text) {
    if (!STORAGE_KEY) return;
    try {
      if (text.length < 2 * 1024 * 1024) sessionStorage.setItem(STORAGE_KEY, text);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch (e) { /* 忽略存储失败 */ }
    saveFmt();
  }
  function saveFmt() {
    if (!FMT_KEY) return;
    try {
      if (fmtMode === 'auto') sessionStorage.removeItem(FMT_KEY);
      else sessionStorage.setItem(FMT_KEY, fmtMode);
    } catch (e) { /* 忽略存储失败 */ }
  }

  // 失焦且内容有改动时解析（对应原站 textarea 的 change 事件）；粘贴后立即解析
  view.contentDOM.addEventListener('blur', function () { if (docChangedSinceParse) check(false); });
  view.contentDOM.addEventListener('paste', function () { setTimeout(function () { check(false); }, 0); });

  // 文本工具按当前格式的适配器路由；不支持的能力按钮已置灰。
  // 非 JSON 的文本工具要先解析（再重排），与解析同样做大文本确认与忙碌提示（预计耗时 = 解析 + 序列化）
  var TOOL_NAME = { format: '格式化', minify: '删除空格' };
  function textTool(cap, method) {
    return function () {
      var ad = FORMATS[resolveFormat(edit.getValue())];
      if (!ad.caps[cap]) return;
      withAdapter(ad, function () {
        var v = edit.getValue();
        if (!v) return;
        if (ad.id === 'json') { run(v); return; }
        var ms = estMs('parse', ad.id, v.length) + estMs('stringify', ad.id, v.length);
        var go = function () {
          if (edit.getValue() !== v) return;
          if (ms <= LIMITS.busyMs) { run(v); return; }
          var bt = busy.show('正在' + TOOL_NAME[method] + '…');
          trackPending(twoFrames().then(function () {
            try { if (edit.getValue() === v) run(v); } finally { busy.hide(bt); }
          }));
        };
        if (v.length <= LIMITS.confirmBytes) { go(); return; }
        trackPending(confirmDlg.ask('处理大文本', costText(v.length, '按 ' + ad.label + ' ' + TOOL_NAME[method], ms)).then(function (ok) {
          if (ok) go();
        }));
      });
      function run(v) {
        var out;
        try {
          out = ad[method](v);
        } catch (err) {
          setCurrentFormat(ad.id);
          showFormatError(ad, err, v);
          return;
        }
        if (out === v) return;
        edit.setValue(out);
        if (method === 'format' && (ad.id === 'yaml' || ad.id === 'toml')) toast('注释未保留，Ctrl+Z 可撤销');
      }
    };
  }
  $('btnCopy').addEventListener('click', function () {
    var v = edit.getValue();
    if (!v) return;
    copyToClipboard(v, '复制成功');
  });
  $('btnFormat').addEventListener('click', textTool('format', 'format'));
  $('btnMinify').addEventListener('click', textTool('minify', 'minify'));
  $('btnMinifyEscape').addEventListener('click', textTool('escape', 'escape'));
  var unescapeTool = textTool('escape', 'unescape');
  $('btnUnescape').addEventListener('click', function () {
    unescapeTool();
    check(false);   // 原站：去除转义后立即重新解析
  });
  updateToolbar(FORMATS.json);
  updateBadge();

  /* ======================================================================
   *  转换面板（§14 方案 C）：中栏「转换」标签。
   *  惰性计算：只有该标签可见时才转换（切到标签、切换目标、改选项、源重新解析成功）；
   *  结果按（解析序号、目标、选项）缓存。只读结果编辑器首次切到本标签时才创建。
   * ==================================================================== */
  var CONV_KEY = 'jsonviewer_conv';
  var DEFAULT_INDENT = { json: 4, yaml: 2, xml: 4 };   // TOML 无缩进概念
  var convOpts = (function () {
    var o = { indent: { json: 4, yaml: 2, xml: 4 }, xmlRoot: 'root', inferTypes: false }, s, k;
    try { s = JSON.parse(localStorage.getItem(CONV_KEY) || 'null'); } catch (e) { s = null; }
    if (s && typeof s === 'object') {
      if (s.indent) for (k in DEFAULT_INDENT) if (s.indent[k] === 2 || s.indent[k] === 4) o.indent[k] = s.indent[k];
      if (typeof s.xmlRoot === 'string' && s.xmlRoot) o.xmlRoot = JV.xmlName(s.xmlRoot);
      o.inferTypes = s.inferTypes === true;
    }
    return o;
  })();
  function saveConvOpts() { try { localStorage.setItem(CONV_KEY, JSON.stringify(convOpts)); } catch (e) { /* 忽略 */ } }
  parseOpts.inferTypes = convOpts.inferTypes;

  // 左侧最近一次解析的状态：ok / empty / nodoc（只有注释）/ error / loading / loadfail；seq 为解析序号
  var source = { kind: 'empty', seq: 0 }, parseSeq = 0;
  function setSource(s) {
    s.seq = ++parseSeq;
    source = s;
    conv.sourceChanged();
  }

  var conv = {
    tab: 'tree', view: null, target: null, lastFmt: null,
    cache: new Map(), token: 0, busy: null, result: null, items: null,
    msg: $('convMsg'), host: $('convEdit'), bar: $('convBar'), barText: $('convBarText'),

    // 目标默认值：源不是 JSON 时默认 JSON，源是 JSON 时默认 YAML；用户点选后以点选为准，直到源格式变化
    targetId: function () {
      if (this.target) return this.target;
      return (this.lastFmt || curFmt) === 'json' ? 'yaml' : 'json';
    },
    opts: function (tid) {
      return { indent: DEFAULT_INDENT[tid] ? convOpts.indent[tid] : undefined, xmlRoot: convOpts.xmlRoot, docCount: source.docCount };
    },
    key: function (tid, o) { return source.seq + '|' + tid + '|' + (o.indent || '') + '|' + (tid === 'xml' ? o.xmlRoot : ''); },
    sourceChanged: function () {
      if (source.kind === 'ok' && source.fmt !== this.lastFmt) { this.lastFmt = source.fmt; this.target = null; }
      this.cache.clear();
      if (this.tab === 'convert') { this.refresh(); return; }
      this.token++;           // 作废进行中的加载 / 转换
      this.result = null;
      this.clearView();
    },
    state: function (text, tid) {
      return CM.EditorState.create({
        doc: text,
        extensions: [
          CM.lineNumbers(), CM.highlightActiveLineGutter(), CM.drawSelection(), CM.highlightActiveLine(),
          CM.EditorState.readOnly.of(true), FORMATS[tid].language(), CM.syntaxHighlighting(CM.defaultHighlightStyle),
          CM.keymap.of(CM.defaultKeymap.concat(CM.searchKeymap))
        ]
      });
    },
    ensureView: function () {
      if (!this.view) this.view = new CM.EditorView({ state: this.state('', 'json'), parent: this.host });
    },
    clearView: function () {
      if (this.view && this.view.state.doc.length) this.view.setState(this.state('', 'json'));
    },
    setActions: function (on) {
      $('convCopy').disabled = $('convDownload').disabled = $('convApply').disabled = !on;
    },
    syncUI: function () {
      var tid = this.targetId(), btns = $('convTargets').children;
      for (var i = 0; i < btns.length; i++) {
        var on = btns[i].getAttribute('data-fmt') === tid;
        btns[i].classList.toggle('on', on);
        btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      this.syncOpts();
    },
    syncOpts: function () {
      var tid = this.targetId(), has = !!DEFAULT_INDENT[tid], btns = $('optIndent').children;
      for (var i = 0; i < btns.length; i++) {
        btns[i].disabled = !has;
        btns[i].classList.toggle('on', has && +btns[i].getAttribute('data-indent') === convOpts.indent[tid]);
      }
      $('optIndentNote').textContent = has ? '' : 'TOML 无缩进';
      $('optRootRow').hidden = tid !== 'xml';
      $('optInferRow').hidden = curFmt !== 'xml';
      if (document.activeElement !== $('optXmlRoot')) $('optXmlRoot').value = convOpts.xmlRoot;
      $('optInfer').checked = convOpts.inferTypes;
    },
    // 返回 Promise：结果（或提示）显示后 resolve。confirmed 为 true 时跳过大文本确认（用户已确认）
    refresh: function (confirmed) {
      var self = this, tok = ++this.token;
      this.syncUI();
      if (source.kind !== 'ok') { this.showSource(); return Promise.resolve(); }
      var tid = this.targetId(), ad = FORMATS[tid], o = this.opts(tid), key = this.key(tid, o);
      if (this.result && this.result.key === key) return Promise.resolve();
      var hit = this.cache.get(key);
      if (hit) { this.show(hit); return Promise.resolve(); }
      var ms = estMs('stringify', tid, source.size);
      // 大文本：先确认（取消则不转换，见 cancelled）；确认前不改动面板
      if (confirmed !== true && source.size > LIMITS.confirmBytes) {
        return this.track(confirmDlg.ask('转换大文本', costText(source.size, '转换为 ' + ad.label + ' ', ms)).then(function (ok) {
          if (tok !== self.token) return;
          if (ok) return self.refresh(true);
          self.cancelled(tid, ms);
        }));
      }
      if (!ad.loaded()) {
        this.showMsg('<p>正在加载 ' + ad.label + ' 解析器…</p>');
        return this.track(ad.ensureLoaded().then(function () {
          if (tok === self.token) return self.refresh(confirmed);
        }, function () {
          if (tok === self.token) self.loadFailed(ad);
        }));
      }
      if (ms > LIMITS.busyMs) {                     // 预计耗时较长：先让「正在转换…」绘制出来再阻塞计算
        this.showMsg('<p>正在转换…</p>');
        return this.track(twoFrames().then(function () { if (tok === self.token) self.compute(key, tid, o); }));
      }
      this.compute(key, tid, o);
      return Promise.resolve();
    },
    // 确认框里取消：当前显示的结果仍对应当前源时，退回产生它的目标与选项并保持显示；否则提示已取消，可手动继续
    cancelled: function (tid, ms) {
      var r = this.result;
      if (r && r.seq === source.seq) {
        this.target = r.tid;
        if (DEFAULT_INDENT[r.tid]) convOpts.indent[r.tid] = r.o.indent;
        if (r.tid === 'xml') convOpts.xmlRoot = r.o.xmlRoot;
        saveConvOpts();
        this.syncUI();
        return;
      }
      this.showMsg('<p>已取消转换（' + escapeHtml(costText(source.size, '转换为 ' + FORMATS[tid].label + ' ', ms).replace(/，是否继续？$/, '')) +
        '）。</p><button type="button" data-act="convert">继续转换</button>');
    },
    track: function (p) {
      var self = this, q = p.then(function () { if (self.busy === q) self.busy = null; });
      this.busy = q;
      return q;
    },
    compute: function (key, tid, o) {
      var r;
      try {
        r = JV.convert(source.value, tid, o);
      } catch (err) {
        this.showMsg('<p>生成 ' + FORMATS[tid].label + ' 失败（左侧数据已正确解析，问题出在目标格式一侧）。</p><pre>' +
          escapeHtml(String(err && err.message || err)) + '</pre>');
        return;
      }
      var res = { key: key, seq: source.seq, tid: tid, o: o, text: r.text, losses: r.losses };
      this.cache.set(key, res);
      if (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
      this.show(res);
    },
    show: function (res) {
      this.ensureView();
      this.result = res;
      this.msg.hidden = true;
      this.host.hidden = false;
      this.view.setState(this.state(res.text, res.tid));
      this.renderBar(res);
      this.setActions(true);
    },
    showMsg: function (html) {
      this.result = null;
      this.items = null;
      this.msg.innerHTML = html;
      this.msg.hidden = false;
      this.host.hidden = true;
      this.bar.hidden = true;
      this.clearView();
      this.setActions(false);
    },
    showSource: function () {
      var ad = source.ad, html;
      switch (source.kind) {
        case 'error': html = '<p>左侧文本解析失败，请先修正。</p><button type="button" data-act="locate">定位错误</button>'; break;
        case 'loading': html = '<p>正在加载 ' + ad.label + ' 解析器…</p>'; break;
        case 'loadfail': html = '<p>加载 ' + ad.label + ' 解析器失败，请刷新重试。</p>'; break;
        case 'nodoc': html = '<p>左侧 ' + ad.label + ' 文档为空（只有注释），没有可转换的数据。</p>'; break;
        default: html = '<p>左侧没有内容，请先粘贴 JSON / YAML / TOML / XML 数据。</p>';
      }
      this.showMsg(html);
    },
    loadFailed: function (ad) {
      this.showMsg('<p>加载 ' + ad.label + ' 解析器失败，请刷新重试。</p>');
      vendorFailNotice(ad);
    },
    locate: function () {
      if (source.kind !== 'error') return;
      if (docChangedSinceParse) { check(false); return; }   // 文本改过：重新解析（仍失败会弹出错误并定位）
      showFormatError(source.ad, source.err, edit.getValue());
    },
    // 提示条：实际损失（警告色，带数量与路径，含解析阶段的 warnings）在前，固有损失（灰色）在后；都没有时隐藏
    renderBar: function (res) {
      var acts = [], w = source.warnings || [], i, e, txt, paths, html = [], plain = [];
      for (i = 0; i < w.length; i++) if (w[i].code !== 'yaml-scalar-root') acts.push(w[i]);
      acts = acts.concat(res.losses);
      var inh = JV.inherentLosses(source.fmt, res.tid, { docCount: source.docCount, inferTypes: parseOpts.inferTypes });
      this.items = { acts: acts, inh: inh, tid: res.tid };
      if (!acts.length && !inh.length) { this.bar.hidden = true; return; }
      if (acts.length) {
        html.push('<span class="warn-mark">!</span><b class="actual">有损转换：</b>');
        for (i = 0; i < acts.length; i++) {
          e = acts[i];
          txt = JV.lossText(e);
          paths = e.paths.length && !(e.paths.length === 1 && e.paths[0] === '$') ?
            e.paths.slice(0, 3).join('、') + (e.count > Math.min(3, e.paths.length) ? ' 等' : '') : '';
          html.push((i ? '；' : '') + '<span class="actual">' + escapeHtml(txt) + '</span>' +
            (paths ? ' <span class="paths">' + escapeHtml(paths) + '</span>' : ''));
          plain.push(txt + (paths ? '  ' + paths : ''));
        }
        if (inh.length) html.push('；');
      } else {
        html.push('<b class="inherent">说明：</b>');
      }
      if (inh.length) html.push('<span class="inherent">' + escapeHtml(inh.join('；')) + '</span>');
      this.bar.classList.toggle('warn', acts.length > 0);
      this.barText.innerHTML = html.join('');
      this.barText.title = plain.concat(inh).join('\n');
      this.bar.hidden = false;
    },
    details: function () {
      var it = this.items, html = [], n = 0, i, e, more;
      if (!it) return;
      if (it.acts.length) {
        html.push('<h4>实际损失（与数据有关）</h4><ol class="loss-list">');
        for (i = 0; i < it.acts.length && n < 50; i++, n++) {
          e = it.acts[i];
          more = e.count > e.paths.length ? ' 等 ' + e.count + ' 处' : '';
          html.push('<li>' + escapeHtml(JV.lossText(e)) +
            (e.paths.length ? '<span class="paths">' + escapeHtml(e.paths.join('  ') + more) + '</span>' : '') + '</li>');
        }
        html.push('</ol>');
      }
      if (it.inh.length && n < 50) {
        html.push('<h4>固有损失（由源格式与目标格式决定）</h4><ul class="loss-list inherent">');
        for (i = 0; i < it.inh.length && n < 50; i++, n++) html.push('<li>' + escapeHtml(it.inh[i]) + '</li>');
        html.push('</ul>');
      }
      dialog.show('转换说明：' + FORMATS[source.fmt].label + ' → ' + FORMATS[it.tid].label, html.join(''), true);
    },
    setTarget: function (id) {
      if (!FORMATS[id]) return Promise.resolve();
      this.target = id;
      return this.refresh();
    },
    copy: function () { if (this.result) copyToClipboard(this.result.text, '复制成功'); },
    download: function () {
      var r = this.result;
      if (!r) return;
      var ad = FORMATS[r.tid], url = URL.createObjectURL(new Blob([r.text], { type: ad.mime + ';charset=utf-8' }));
      var a = document.createElement('a');
      a.href = url;
      a.download = 'converted.' + ad.ext;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    },
    // 单次事务替换左侧文本（可 Ctrl+Z 撤销）；手动格式模式切到目标格式，自动模式保持自动；重新解析后回到树视图
    apply: function () {
      var r = this.result;
      if (!r) return;
      edit.setValue(r.text, 'set.convert');
      if (fmtMode !== 'auto') { fmtMode = r.tid; saveFmt(); }
      showTab('tree');
      var ok = check(true);
      if (ok === true) toast('已应用，Ctrl+Z 可撤销');
      else if (ok === null) {               // 懒加载 / 大文本确认 / 忙碌提示：解析真正完成后再提示
        whenIdle().then(function () { if (source.kind === 'ok' && lastParsed === r.text) toast('已应用，Ctrl+Z 可撤销'); });
      }
    }
  };

  function showTab(name) {
    if (name !== 'tree' && name !== 'convert') return Promise.resolve();
    var isConv = name === 'convert';
    conv.tab = name;
    $('treePane').hidden = isConv;
    $('convPane').hidden = !isConv;
    $('tabTree').classList.toggle('on', !isConv);
    $('tabConvert').classList.toggle('on', isConv);
    $('tabTree').setAttribute('aria-selected', String(!isConv));
    $('tabConvert').setAttribute('aria-selected', String(isConv));
    ctxMenu.hide();
    optsMenu.hide();
    if (!isConv) {
      conv.token++;
      tree.invalidate();      // 树在隐藏期间 clientHeight 为 0，切回时必须按真实高度重算行区间
      return Promise.resolve();
    }
    if (docChangedSinceParse) check(false);
    conv.ensureView();
    return conv.refresh();
  }
  $('tabTree').addEventListener('click', function () { showTab('tree'); });
  $('tabConvert').addEventListener('click', function () { showTab('convert'); });
  $('convTargets').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-fmt]');
    if (b) conv.setTarget(b.getAttribute('data-fmt'));
  });
  $('convCopy').addEventListener('click', function () { conv.copy(); });
  $('convDownload').addEventListener('click', function () { conv.download(); });
  $('convApply').addEventListener('click', function () { conv.apply(); });
  $('convDetail').addEventListener('click', function () { conv.details(); });
  conv.msg.addEventListener('click', function (e) {
    if (e.target.closest('[data-act="locate"]')) conv.locate();
    else if (e.target.closest('[data-act="convert"]')) conv.refresh(true);
  });
  conv.setActions(false);

  /* 转换选项下拉：缩进（按目标格式分别记忆）、XML 根元素名、XML 推断类型；存 localStorage */
  var optsMenu = {
    el: $('convOpts'), btn: $('convOptBtn'),
    open: function () {
      conv.syncOpts();
      var r = this.btn.getBoundingClientRect(), d = this.el;
      d.hidden = false;
      d.style.left = Math.max(4, Math.min(r.right - d.offsetWidth, window.innerWidth - d.offsetWidth - 4)) + 'px';
      d.style.top = (r.bottom + 3) + 'px';
      this.btn.setAttribute('aria-expanded', 'true');
    },
    hide: function () {
      if (this.el.hidden) return;
      commitRoot();
      this.el.hidden = true;
      this.btn.setAttribute('aria-expanded', 'false');
    }
  };
  optsMenu.btn.addEventListener('click', function () { if (optsMenu.el.hidden) optsMenu.open(); else optsMenu.hide(); });
  document.addEventListener('mousedown', function (e) {
    if (!optsMenu.el.hidden && !optsMenu.el.contains(e.target) && !optsMenu.btn.contains(e.target)) optsMenu.hide();
  });
  window.addEventListener('resize', function () { optsMenu.hide(); });
  $('optIndent').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-indent]'), tid = conv.targetId();
    if (!b || b.disabled || !DEFAULT_INDENT[tid]) return;
    convOpts.indent[tid] = +b.getAttribute('data-indent');
    saveConvOpts();
    conv.syncOpts();
    conv.refresh();
  });
  function commitRoot() {
    var inp = $('optXmlRoot'), v = JV.xmlName(inp.value.trim() || 'root');
    inp.value = v;
    if (v === convOpts.xmlRoot) return;
    convOpts.xmlRoot = v;
    saveConvOpts();
    if (conv.tab === 'convert') conv.refresh();
  }
  $('optXmlRoot').addEventListener('change', commitRoot);
  $('optXmlRoot').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commitRoot(); } });
  $('optInfer').addEventListener('change', function () {
    convOpts.inferTypes = parseOpts.inferTypes = $('optInfer').checked;
    saveConvOpts();
    if (curFmt === 'xml') check(true);     // 重新解析左侧，树与转换结果同步变化
    else conv.refresh();
  });

  /* ======================================================================
   *  查找（不区分大小写，匹配节点文本，上一个/下一个循环）
   * ==================================================================== */
  var search = {
    input: $('searchText'), label: $('searchResult'),
    results: [], index: -1, timer: 0,
    reset: function () { this.results = []; this.index = -1; this.label.textContent = ''; },
    start: function () {
      var self = this;
      clearTimeout(this.timer);
      this.timer = setTimeout(function () { self.run(); }, 150);
    },
    run: function () {
      this.results = [];
      this.index = -1;
      var q = this.input.value;
      if (!q || !tree.root) { this.label.textContent = ''; return; }
      var Q = q.toUpperCase(), results = this.results;
      walk(tree.root, function (n) {
        if (nodeText(n).toUpperCase().indexOf(Q) !== -1) results.push(n);
      }, true);
      if (results.length) {
        this.index = 0;
        this.label.className = 'search-result ok';
        this.goto();
        this.input.focus();
      } else {
        this.label.className = 'search-result';
        this.label.textContent = 'Phrase not found!';
      }
    },
    goto: function () {
      this.label.textContent = (this.index + 1) + '/' + this.results.length;
      tree.select(this.results[this.index], true);
    },
    next: function () {
      if (!this.results.length) return;
      this.index = (this.index + 1) % this.results.length;
      this.goto();
    },
    prev: function () {
      if (!this.results.length) return;
      this.index = (this.index - 1 + this.results.length) % this.results.length;
      this.goto();
    }
  };
  $('btnSearch').addEventListener('click', function () { search.start(); });
  search.input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (search.results.length && search.input.value) { e.shiftKey ? search.prev() : search.next(); }
      else search.start();
    }
  });
  search.input.addEventListener('input', function () { search.results = []; search.index = -1; search.label.textContent = ''; });
  $('btnNext').addEventListener('click', function () { search.next(); });
  $('btnPrev').addEventListener('click', function () { search.prev(); });
  $('btnExpandAll').addEventListener('click', function () { tree.expandAll(); });
  $('btnCollapseAll').addEventListener('click', function () { tree.collapseAll(); });
  $('btnAbout').addEventListener('click', function () {
    dialog.show('关于', [
      '<p><b>JSON 在线视图查看器</b>，自托管版本。</p>',
      '<p>左侧粘贴 JSON、YAML、TOML 或 XML，失焦或粘贴后自动解析；中间为树形视图，右侧为选中节点的属性表。</p>',
      '<p>格式默认自动识别（左上角显示「自动 · YAML」等），识别不对时可在下拉框中手动指定。</p>',
      '<p>中间的「转换」标签可把当前数据转为另外三种格式，支持复制、下载和应用到左侧；',
      '有损转换（如 TOML 没有 null、XML 只有文本）会在结果上方提示，「详情」列出具体位置。</p>',
      '<p>XML 映射约定：属性写成 <code>@名称</code>，有属性或子元素时文本写成 <code>#text</code>，同名的兄弟元素合并为数组。</p>',
      '<p>快捷键：<kbd>Ctrl</kbd>+<kbd>Enter</kbd> 立即解析；编辑区 <kbd>Tab</kbd> 缩进 4 个空格、<kbd>Ctrl</kbd>+<kbd>F</kbd> 在文本中查找；',
      '查找框 <kbd>Enter</kbd> 下一个、<kbd>Shift</kbd>+<kbd>Enter</kbd> 上一个。</p>',
      '<p>树节点上右键可复制 Key / Value，或展开、收起子节点。超过 16 位的数字按原文显示，不会丢失精度。</p>',
      '<p>源码：<a href="https://github.com/angelo1002888/jsonviewer" target="_blank" rel="noopener">https://github.com/angelo1002888/jsonviewer</a></p>',
      '<p>隐私：所有内容只在浏览器内解析，不会上传到任何服务器；托管方只能看到普通的请求元数据（IP、UA），看不到你的数据。</p>'
    ].join(''));
  });

  /* ======================================================================
   *  可拖动分割条
   * ==================================================================== */
  function makeSplitter(splitter, panel, side) {
    var startX = 0, startW = 0, dragging = false;
    var MIN = 120;
    splitter.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startW = panel.getBoundingClientRect().width;
      splitter.classList.add('active');
      document.body.classList.add('resizing');
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      var w = side === 'left' ? startW + dx : startW - dx;
      var max = window.innerWidth - 300;
      w = Math.max(MIN, Math.min(max, w));
      panel.style.width = w + 'px';
      panel.style.flexBasis = w + 'px';
    });
    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      splitter.classList.remove('active');
      document.body.classList.remove('resizing');
      tree.scheduleRender();
    });
  }
  makeSplitter($('splitLeft'), $('leftPanel'), 'left');
  makeSplitter($('splitRight'), $('gridPanel'), 'right');

  /* ======================================================================
   *  用户菜单（仅在服务端启用登录验证时显示）
   * ==================================================================== */
  var userMenu = {
    el: $('userMenu'), btn: $('userBtn'), drop: $('userDrop'),
    open: function () {
      var r = this.btn.getBoundingClientRect(), d = this.drop;
      d.hidden = false;
      // 右对齐到按钮，并限制在视口内
      var left = Math.max(4, Math.min(r.right - d.offsetWidth, window.innerWidth - d.offsetWidth - 4));
      d.style.left = left + 'px';
      d.style.top = (r.bottom + 3) + 'px';
      this.btn.setAttribute('aria-expanded', 'true');
    },
    hide: function () { this.drop.hidden = true; this.btn.setAttribute('aria-expanded', 'false'); },
    show: function (name, admin) {
      $('userName').textContent = name;
      $('menuAdmin').hidden = !admin;
      this.el.hidden = false;
    }
  };
  userMenu.btn.addEventListener('click', function () {
    if (userMenu.drop.hidden) userMenu.open(); else userMenu.hide();
  });
  document.addEventListener('mousedown', function (e) {
    if (!userMenu.drop.hidden && !userMenu.el.contains(e.target)) userMenu.hide();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') userMenu.hide(); });
  window.addEventListener('blur', function () { userMenu.hide(); });
  window.addEventListener('resize', function () { userMenu.hide(); });
  $('menuPassword').addEventListener('click', function () { userMenu.hide(); pwdDialog.show(); });

  /* 修改密码弹窗：POST api/password，成功后其它会话失效 */
  var pwdDialog = {
    mask: $('pwdMask'), form: $('pwdForm'), err: $('pwdError'), busy: false,
    show: function () {
      this.form.reset();
      $('pwdUser').value = $('userName').textContent;
      this.err.textContent = this.err.title = '';
      this.setBusy(false);
      this.mask.hidden = false;
      $('pwdCurrent').focus();
    },
    hide: function () { if (!this.busy) this.mask.hidden = true; },
    setBusy: function (b) {
      this.busy = b;
      $('pwdOk').disabled = b;
      $('pwdCancel').disabled = b;
    },
    submit: function () {
      var self = this;
      if (self.busy) return;
      var fd = new FormData(self.form);
      fd.delete('username');
      fd.append('csrf', $('csrfField').value);
      self.err.textContent = '';
      self.setBusy(true);
      // 以 urlencoded 提交：服务端 CSRF 校验只解析普通表单
      fetch('api/password', { method: 'POST', body: new URLSearchParams(fd), credentials: 'same-origin', cache: 'no-store' }).then(function (res) {
        if (res.status === 401) { location.href = 'login'; return null; }
        return res.json().then(function (j) { return j; }, function () {
          return { ok: false, error: '请求失败（' + res.status + '），请刷新页面后重试' };
        });
      }, function () {
        return { ok: false, error: '网络错误，请稍后重试' };
      }).then(function (r) {
        self.setBusy(false);
        if (!r) return;
        if (r.ok) {
          self.hide();
          toast('密码已修改，其它设备需重新登录');
        } else {
          self.err.textContent = r.error || '修改失败';
          self.err.title = self.err.textContent;
        }
      });
    }
  };
  pwdDialog.form.addEventListener('submit', function (e) { e.preventDefault(); pwdDialog.submit(); });
  $('pwdCancel').addEventListener('click', function () { pwdDialog.hide(); });

  $('logoutForm').addEventListener('submit', function () {
    try {
      if (STORAGE_KEY) sessionStorage.removeItem(STORAGE_KEY);
      if (FMT_KEY) sessionStorage.removeItem(FMT_KEY);
    } catch (e) { /* 忽略 */ }
  });

  /* ======================================================================
   *  启动：确认登录身份后恢复上次内容（不同用户的暂存内容互相隔离）
   * ==================================================================== */
  function init(user) {
    STORAGE_KEY = user ? 'jsonviewer_text:' + user : 'jsonviewer_text';
    FMT_KEY = user ? 'jsonviewer_fmt:' + user : 'jsonviewer_fmt';
    var current = edit.getValue();
    if (current) {             // 身份确认前已有输入：以当前内容为准
      if (current === lastParsed) saveText(current);
      return;
    }
    var saved = null, savedFmt = null;
    try {
      saved = sessionStorage.getItem(STORAGE_KEY);
      savedFmt = sessionStorage.getItem(FMT_KEY);
    } catch (e) { saved = savedFmt = null; }
    if (fmtMode === 'auto' && savedFmt && FORMATS[savedFmt]) fmtMode = savedFmt;   // 恢复手动指定的格式
    if (saved) {
      edit.setValue(saved);
      check(false);
    } else {
      check(true);
    }
  }
  tree.render();
  // auth 关闭、旧版服务端（404）或网络失败都按未启用登录处理，不阻塞查看器；只有 401 跳转登录页
  var TO_LOGIN = {};
  fetch('api/me', { credentials: 'same-origin', cache: 'no-store' }).then(function (res) {
    if (res.status === 401) { location.href = 'login'; return TO_LOGIN; }
    if (!res.ok) return null;
    return res.json().catch(function () { return null; });
  }, function () { return null; }).then(function (me) {
    if (me === TO_LOGIN) return;
    if (me && me.auth && me.user) {
      $('csrfField').value = me.csrf || '';
      userMenu.show(me.user, !!me.admin);
      init(me.user);
    } else {
      init(null);
    }
  });

  // 供自动化测试 / 书签脚本使用的小接口
  window.jsonviewer = {
    setText: function (text) { edit.setValue(text); return check(true); },
    getText: function () { return edit.getValue(); },
    parse: function () { return check(true); },
    setFormat: setFormat,                                                 // 'auto' 或格式 id
    getFormat: function () { return { mode: fmtMode, format: curFmt }; },
    whenIdle: whenIdle,                                                   // 懒加载与随后的解析完成后 resolve
    showTab: showTab,                                                     // 'tree' | 'convert'，返回 Promise
    // 不经界面的转换：from 可为 'auto'；resolve { text, losses, warnings, inherent }，失败 reject FormatError
    convert: function (text, from, to, opts) {
      opts = opts || {};
      return new Promise(function (resolve) {
        var f = !from || from === 'auto' ? JV.detect(text) : from;
        if (!FORMATS[f] || !FORMATS[to]) throw new JV.FormatError(String(FORMATS[f] ? to : f), '未知格式', -1);
        resolve(Promise.all([FORMATS[f].ensureLoaded(), FORMATS[to].ensureLoaded()]).then(function () {
          var r = FORMATS[f].parse(text, { inferTypes: !!opts.inferTypes });
          var out = JV.convert(r.value, to, { indent: opts.indent, xmlRoot: opts.xmlRoot, docCount: r.docCount });
          return {
            text: out.text, losses: out.losses, warnings: r.warnings,
            inherent: JV.inherentLosses(f, to, { docCount: r.docCount, inferTypes: !!opts.inferTypes })
          };
        }));
      });
    },
    // 仅供测试：临时调整大文本确认阈值（字节）与忙碌提示阈值（毫秒），返回调整前的值
    _setLimits: function (o) {
      var prev = { confirmBytes: LIMITS.confirmBytes, busyMs: LIMITS.busyMs };
      if (o && typeof o.confirmBytes === 'number') LIMITS.confirmBytes = o.confirmBytes;
      if (o && typeof o.busyMs === 'number') LIMITS.busyMs = o.busyMs;
      return prev;
    },
    tree: tree
  };
})();
