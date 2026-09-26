/* JSON Viewer - 仿 bejson jsonviewernew 布局与功能，纯原生实现，树视图虚拟滚动 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var ROW_H = 18;           // 树每行高度（与 ExtJS 一致）
  var GRID_MAX_ROWS = 20000; // 属性表最多直接渲染的行数
  var MAX_SCROLL_H = 30000000; // 浏览器对元素高度有上限（Chrome 约 3350 万 px），超出后按比例缩放滚动条
  var STORAGE_KEY = 'jsonviewer_text';

  /* ======================================================================
   *  大数安全的 JSON 解析 / 序列化
   *  普通文本直接走原生 JSON.parse；只有出现 16 位以上连续数字时才做保护，
   *  把超长数字先包成字符串，解析后还原成 BigNum（保存原始文本，不丢精度）。
   * ==================================================================== */
  function BigNum(raw) { this.raw = raw; }
  BigNum.prototype.toString = function () { return this.raw; };
  var BN_MARK = 'BN';
  BigNum.prototype.toJSON = function () { return BN_MARK + this.raw; };

  var LONG_DIGITS = /\d{16,}/;
  var TOKEN_RE = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

  function parseJSON(text) {
    if (!LONG_DIGITS.test(text)) return JSON.parse(text);
    var replaced = text.replace(TOKEN_RE, function (m) {
      if (m.charCodeAt(0) === 34) return m;          // 字符串原样
      if (!LONG_DIGITS.test(m)) return m;            // 短数字原样
      return '"' + BN_MARK + m + '"';
    });
    return JSON.parse(replaced, function (k, v) {
      if (typeof v === 'string' && v.length > 3 && v.charCodeAt(0) === 0xE000 && v.slice(0, 3) === BN_MARK) {
        return new BigNum(v.slice(3));
      }
      return v;
    });
  }

  // 轻量 JSON 扫描器：返回第一个非法字符的偏移量（-1 表示合法）。只在 JSON.parse 失败后调用，用于定位光标。
  var NUM_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  function findJsonError(s) {
    var i = 0, n = s.length, stack = [], expect = 'value', c;
    function ws() { while (i < n) { c = s.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; } }
    function str() {            // i 指向开头引号
      i++;
      while (i < n) {
        c = s.charCodeAt(i);
        if (c === 34) { i++; return true; }
        if (c === 92) {
          var e = s.charAt(i + 1);
          if (e === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(s.substr(i + 2, 4))) return false; i += 6; }
          else if ('"\\/bfnrt'.indexOf(e) !== -1 && e !== '') i += 2;
          else return false;
        } else if (c < 32) return false;
        else i++;
      }
      return false;
    }
    while (true) {
      ws();
      if (i >= n) return (expect === 'end') ? -1 : n;
      var ch = s.charAt(i);
      if (expect === 'value') {
        if (ch === '{') { stack.push('{'); i++; ws(); if (s.charAt(i) === '}') { i++; expect = 'after'; } else expect = 'key'; }
        else if (ch === '[') { stack.push('['); i++; ws(); if (s.charAt(i) === ']') { i++; expect = 'after'; } else expect = 'value'; }
        else if (ch === '"') { if (!str()) return i; expect = 'after'; }
        else if (ch === '-' || (ch >= '0' && ch <= '9')) { NUM_RE.lastIndex = i; var m = NUM_RE.exec(s); if (!m) return i; i += m[0].length; expect = 'after'; }
        else if (s.startsWith('true', i)) { i += 4; expect = 'after'; }
        else if (s.startsWith('false', i)) { i += 5; expect = 'after'; }
        else if (s.startsWith('null', i)) { i += 4; expect = 'after'; }
        else return i;
        if (expect === 'after' && !stack.length) expect = 'end';
      } else if (expect === 'key') {
        if (ch !== '"' || !str()) return i;
        expect = 'colon';
      } else if (expect === 'colon') {
        if (ch !== ':') return i;
        i++; expect = 'value';
      } else if (expect === 'after') {
        var top = stack[stack.length - 1];
        if (ch === ',') { i++; expect = top === '{' ? 'key' : 'value'; }
        else if ((ch === '}' && top === '{') || (ch === ']' && top === '[')) { stack.pop(); i++; expect = stack.length ? 'after' : 'end'; }
        else return i;
      } else { // end：后面不允许再有内容
        return i;
      }
    }
  }

  var BN_OUT_RE = /"BN(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)"/g;
  function stringifyJSON(value, indent) {
    var s = JSON.stringify(value, null, indent);
    if (s === undefined) return '';
    return s.replace(BN_OUT_RE, '$1');
  }

  /* ======================================================================
   *  节点模型（按需懒创建子节点）
   * ==================================================================== */
  function typeOf(v) {
    if (v === null) return 'null';
    if (v instanceof BigNum) return 'number';
    var t = typeof v;
    if (t === 'object') return Array.isArray(v) ? 'array' : 'object';
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
    if (!n.parent) t = isContainer(n) ? 'JSON' : 'JSON : ' + valueText(n);
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
  var tree = {
    body: $('treeBody'), spacer: $('treeSpacer'), layer: $('treeLayer'),
    root: null, rows: [], selected: null,
    rStart: -1, rEnd: -1, dirty: true, raf: 0,
    maxScroll: 0, virtMax: 0,

    setRoot: function (root) {
      this.root = root;
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
        this.layer.innerHTML = this.root ? '' : '<div class="tree-empty">在左侧粘贴 JSON 后，这里显示树形视图。</div>';
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
      this.selected = n;
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
  tree.layer.addEventListener('click', function (e) {
    var n = tree.nodeAt(e.target);
    if (!n) return;
    if (e.target.classList.contains('ec')) { tree.toggle(n); return; }
    tree.select(n, false);
  });
  tree.layer.addEventListener('dblclick', function (e) {
    var n = tree.nodeAt(e.target);
    if (n && !e.target.classList.contains('ec')) tree.toggle(n);
  });
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
        rows.push('<tr><td class="name">JSON</td><td class="value">' + escapeHtml(valueText(n)) + '</td></tr>');
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
        case 'copyKey': copyToClipboard(n.parent ? n.key : 'JSON', 'Key 复制成功'); break;
        case 'copyValue': copyToClipboard(rawValueText(n), 'Value 复制成功'); break;
        case 'copyBoth':
          copyToClipboard(isContainer(n) ? (n.parent ? n.key : 'JSON') + ' : ' + rawValueText(n) : nodeText(n), 'Key+Value 复制成功');
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
    if (e.key === 'Escape') { ctxMenu.hide(); dialog.hide(); }
  });
  tree.body.addEventListener('scroll', function () { ctxMenu.hide(); });
  window.addEventListener('blur', function () { ctxMenu.hide(); });

  /* ======================================================================
   *  对话框 / 提示
   * ==================================================================== */
  var dialog = {
    mask: $('dialogMask'),
    show: function (title, html) {
      $('dialogTitle').textContent = title;
      $('dialogBody').innerHTML = html;
      this.mask.hidden = false;
      $('dialogOk').focus();
    },
    hide: function () { this.mask.hidden = true; }
  };
  $('dialogOk').addEventListener('click', function () { dialog.hide(); });
  dialog.mask.addEventListener('click', function (e) { if (e.target === dialog.mask) dialog.hide(); });

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
   *  文本工具：格式化 / 删除空格 / 转义
   *  按字符扫描（跳过字符串内部），对无效 JSON 也能工作，且不改动数字原文。
   * ==================================================================== */
  function isQuote(c) { return c === '"' || c === "'"; }

  // 删除字符串外的所有空白（含换行）
  function minify(text) {
    var out = [], q = null, last = 0, i, c, len = text.length;
    for (i = 0; i < len; i++) {
      c = text.charAt(i);
      if (q) {
        if (c === '\\') { i++; continue; }
        if (c === q) q = null;
      } else if (isQuote(c)) {
        q = c;
      } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        if (last < i) out.push(text.slice(last, i));
        last = i + 1;
      }
    }
    if (last < len) out.push(text.slice(last));
    return out.join('');
  }

  var SPACES = '                                                                ';
  function spaces(n) {
    while (SPACES.length < n) SPACES += SPACES;
    return SPACES.slice(0, n);
  }

  // 两个空格缩进的格式化（先删空白再重排，与原站算法一致）
  function format(text) {
    var s = minify(text), out = [], q = null, level = 0, last = 0, i, c, next, len = s.length;
    for (i = 0; i < len; i++) {
      c = s.charAt(i);
      if (q) {
        if (c === '\\') { i++; continue; }
        if (c === q) q = null;
        continue;
      }
      if (isQuote(c)) { q = c; continue; }
      if (c === ':') {
        out.push(s.slice(last, i + 1), ' '); last = i + 1;
      } else if (c === ',') {
        out.push(s.slice(last, i + 1), '\n', spaces(level * 2)); last = i + 1;
      } else if (c === '{' || c === '[') {
        next = s.charAt(i + 1);
        if ((c === '{' && next === '}') || (c === '[' && next === ']')) {
          out.push(s.slice(last, i + 2)); last = i + 2; i++;   // 空容器保持 {} / []
        } else {
          level++;
          out.push(s.slice(last, i + 1), '\n', spaces(level * 2)); last = i + 1;
        }
      } else if (c === '}' || c === ']') {
        level = Math.max(0, level - 1);
        out.push(s.slice(last, i), '\n', spaces(level * 2), c); last = i + 1;
      }
    }
    if (last < len) out.push(s.slice(last));
    return out.join('');
  }

  function minifyAndEscape(text) { return minify(text).replace(/"/g, '\\"'); }
  function unescape(text) { return text.replace(/\\\\/g, '\\').replace(/\\"/g, '"'); }

  /* ======================================================================
   *  编辑区与解析流程
   * ==================================================================== */
  var docChangedSinceParse = false;
  var view = new CM.EditorView({
    state: CM.EditorState.create({
      doc: '',
      extensions: [
        CM.lineNumbers(), CM.highlightActiveLineGutter(), CM.history(), CM.drawSelection(),
        CM.highlightActiveLine(), CM.bracketMatching(),
        CM.json(), CM.syntaxHighlighting(CM.defaultHighlightStyle),
        CM.placeholder('将JSON数据粘贴到这里!'),
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
    setValue: function (text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
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
    },
    // 从 JSON.parse 的错误信息里提取位置（Chrome: "at position N"；Firefox: "line N column M"）
    errorOffset: function (msg) {
      var m = /position (\d+)/.exec(msg);
      if (m) return +m[1];
      m = /line (\d+) column (\d+)/.exec(msg);
      if (m) {
        var ln = +m[1], doc = view.state.doc;
        if (ln >= 1 && ln <= doc.lines) return doc.line(ln).from + (+m[2]) - 1;
      }
      return -1;
    }
  };
  var lastParsed = null;

  function check(force) {
    docChangedSinceParse = false;
    var text = edit.getValue();
    if (!force && text === lastParsed) return true;
    if (!text.trim()) {
      lastParsed = text;
      tree.setRoot(null);
      grid.show(null);
      search.reset();
      return true;
    }
    var data;
    try {
      data = parseJSON(text);
    } catch (err) {
      var msg = String(err && err.message || err);
      if (LONG_DIGITS.test(text)) {   // 大数保护路径改写过文本，用原文重新解析拿到准确位置
        try { JSON.parse(text); } catch (err2) { msg = String(err2 && err2.message || err2); }
      }
      var off = findJsonError(text);
      if (off < 0) off = edit.errorOffset(msg);
      var where = '';
      if (off >= 0) {
        var pos = edit.lineCol(off);
        where = '<p>位置：第 ' + pos.line + ' 行，第 ' + pos.col + ' 列（光标已定位）</p>';
        edit.goTo(off);
      }
      dialog.show('JSON 错误', 'JSON 格式错误' + where + '<pre>' + escapeHtml(msg) + '</pre>');
      return false;
    }
    lastParsed = text;
    var root = makeNode('JSON', data, null);
    tree.setRoot(root);
    grid.show(root);
    search.reset();
    saveText(text);
    return true;
  }

  function saveText(text) {
    try {
      if (text.length < 2 * 1024 * 1024) sessionStorage.setItem(STORAGE_KEY, text);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch (e) { /* 忽略存储失败 */ }
  }

  // 失焦且内容有改动时解析（对应原站 textarea 的 change 事件）；粘贴后立即解析
  view.contentDOM.addEventListener('blur', function () { if (docChangedSinceParse) check(false); });
  view.contentDOM.addEventListener('paste', function () { setTimeout(function () { check(false); }, 0); });

  function applyTransform(fn) {
    var v = edit.getValue();
    if (!v) return;
    var out = fn(v);
    if (out !== v) edit.setValue(out);
  }
  $('btnCopy').addEventListener('click', function () {
    var v = edit.getValue();
    if (!v) return;
    copyToClipboard(v, '复制成功');
  });
  $('btnFormat').addEventListener('click', function () { applyTransform(format); });
  $('btnMinify').addEventListener('click', function () { applyTransform(minify); });
  $('btnMinifyEscape').addEventListener('click', function () { applyTransform(minifyAndEscape); });
  $('btnUnescape').addEventListener('click', function () {
    applyTransform(unescape);
    check(false);   // 原站：去除转义后立即重新解析
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
      '<p>左侧粘贴 JSON，失焦或粘贴后自动解析；中间为树形视图，右侧为选中节点的属性表。</p>',
      '<p>快捷键：<kbd>Ctrl</kbd>+<kbd>Enter</kbd> 立即解析；编辑区 <kbd>Tab</kbd> 缩进 4 个空格、<kbd>Ctrl</kbd>+<kbd>F</kbd> 在文本中查找；',
      '查找框 <kbd>Enter</kbd> 下一个、<kbd>Shift</kbd>+<kbd>Enter</kbd> 上一个。</p>',
      '<p>树节点上右键可复制 Key / Value，或展开、收起子节点。超过 16 位的数字按原文显示，不会丢失精度。</p>'
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
   *  启动：恢复上次内容
   * ==================================================================== */
  (function init() {
    var saved = null;
    try { saved = sessionStorage.getItem(STORAGE_KEY); } catch (e) { saved = null; }
    if (saved) {
      edit.setValue(saved);
      check(false);
    } else {
      tree.render();
    }
  })();

  // 供自动化测试 / 书签脚本使用的小接口
  window.jsonviewer = {
    setText: function (text) { edit.setValue(text); return check(true); },
    getText: function () { return edit.getValue(); },
    parse: function () { return check(true); },
    tree: tree
  };
})();
