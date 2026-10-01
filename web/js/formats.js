/* jsonviewer 格式层：JSON / YAML / TOML / XML 适配器、格式识别、懒加载器、BigNum / DateVal。
 * 暴露 window.JV。YAML（js-yaml）与 TOML（smol-toml）打包在 js/vendor/{yaml,toml}.bundle.js，首次用到时才加载；
 * JSON 走原生 JSON.parse 快速路径，XML 用浏览器原生 DOMParser。 */
(function () {
  'use strict';

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
   *  日期时间值（目前只有 TOML 产生）：保存原文，kind 为 datetime / datetime-local / date / time
   * ==================================================================== */
  function DateVal(raw, kind) { this.raw = raw; this.kind = kind; }
  DateVal.prototype.toString = function () { return this.raw; };
  DateVal.prototype.toJSON = function () { return this.raw; };

  /* 统一的解析错误：offset 为绝对偏移（未知为 -1）；approx 表示位置是近似值 */
  function FormatError(format, message, offset, approx) {
    var e = new Error(message);
    this.name = 'FormatError';
    this.format = format;
    this.message = message;
    this.offset = (offset === undefined || offset === null) ? -1 : offset;
    this.approx = !!approx;
    this.stack = e.stack;
  }
  FormatError.prototype = Object.create(Error.prototype);
  FormatError.prototype.constructor = FormatError;

  function warn(list, code, path, sample) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].code === code) {
        var w = list[i];
        w.count++;
        if (path && w.paths.length < 5 && w.paths.indexOf(path) === -1) w.paths.push(path);
        return;
      }
    }
    list.push({ code: code, count: 1, paths: path ? [path] : [], sample: sample === undefined ? '' : sample });
  }

  /* 转换损失：与 warning 同构 { code, count, paths[], sample }。路径用链表节点 { up, k } 惰性拼接，
   * 只在该 code 的路径不足 5 条时才生成 '$.a.b[3]' 形式的字符串，大数据量下不为每个节点拼路径。 */
  function pathSeg(k) {
    return typeof k === 'number' ? '[' + k + ']' : /^[A-Za-z_$][\w$]*$/.test(k) ? '.' + k : '[' + JSON.stringify(k) + ']';
  }
  function pathStr(at, k) {
    var parts = [];
    if (k !== undefined) parts.push(pathSeg(k));
    for (; at; at = at.up) parts.push(pathSeg(at.k));
    return '$' + parts.reverse().join('');
  }
  function lossAt(list, code, at, k, sample) {
    var w = null;
    for (var i = 0; i < list.length; i++) if (list[i].code === code) { w = list[i]; break; }
    if (!w) { w = { code: code, count: 0, paths: [], sample: sample === undefined ? '' : sample }; list.push(w); }
    w.count++;
    if (w.paths.length < 5) {
      var p = pathStr(at, k);
      if (w.paths.indexOf(p) === -1) w.paths.push(p);
    }
  }
  function isLeafObj(v) { return v instanceof BigNum || v instanceof DateVal; }

  // 1 基行列 → 绝对偏移；列超过行尾时钳制到行尾
  function lineColToOffset(text, line, col) {
    var pos = 0, ln = 1, nl;
    while (ln < line) {
      nl = text.indexOf('\n', pos);
      if (nl === -1) return text.length;
      pos = nl + 1; ln++;
    }
    var end = text.indexOf('\n', pos);
    if (end === -1) end = text.length;
    return Math.max(pos, Math.min(pos + Math.max(0, col - 1), end));
  }

  function errMsg(e) { return String(e && e.message || e); }

  /* ======================================================================
   *  懒加载：按包名缓存 Promise，<script> 用相对路径（兼容反代子路径）
   * ==================================================================== */
  var vendorPromises = {};
  function loadVendor(name) {
    if (vendorPromises[name]) return vendorPromises[name];
    var p = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'js/vendor/' + name + '.bundle.js';
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () {
        if (s.parentNode) s.parentNode.removeChild(s);
        reject(new Error('加载 js/vendor/' + name + '.bundle.js 失败'));
      };
      document.head.appendChild(s);
    });
    vendorPromises[name] = p;
    p.catch(function () { if (vendorPromises[name] === p) delete vendorPromises[name]; });   // 失败后允许重试
    return p;
  }
  function ensureGlobal(name, global) {
    if (window[global]) return Promise.resolve();
    return loadVendor(name).then(function () {
      if (!window[global]) {   // 例如登录已失效，拿到的是登录页 HTML
        delete vendorPromises[name];
        throw new Error('js/vendor/' + name + '.bundle.js 未能初始化');
      }
    });
  }

  /* ======================================================================
   *  JSON 适配器（文本工具：按字符扫描，对无效 JSON 也能工作，且不改动数字原文）
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

  // 四个空格缩进的格式化（先删空白再重排，算法与原站一致，原站为两个空格）
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
        out.push(s.slice(last, i + 1), '\n', spaces(level * 4)); last = i + 1;
      } else if (c === '{' || c === '[') {
        next = s.charAt(i + 1);
        if ((c === '{' && next === '}') || (c === '[' && next === ']')) {
          out.push(s.slice(last, i + 2)); last = i + 2; i++;   // 空容器保持 {} / []
        } else {
          level++;
          out.push(s.slice(last, i + 1), '\n', spaces(level * 4)); last = i + 1;
        }
      } else if (c === '}' || c === ']') {
        level = Math.max(0, level - 1);
        out.push(s.slice(last, i), '\n', spaces(level * 4), c); last = i + 1;
      }
    }
    if (last < len) out.push(s.slice(last));
    return out.join('');
  }

  function minifyAndEscape(text) { return minify(text).replace(/"/g, '\\"'); }
  function unescape(text) { return text.replace(/\\\\/g, '\\').replace(/\\"/g, '"'); }

  // 从 JSON.parse 的错误信息里提取位置（Chrome: "at position N"；Firefox: "line N column M"）
  function jsonErrorOffset(text, msg) {
    var m = /position (\d+)/.exec(msg);
    if (m) return +m[1];
    m = /line (\d+) column (\d+)/.exec(msg);
    if (m) return lineColToOffset(text, +m[1], +m[2]);
    return -1;
  }

  // 目标 JSON 的损失扫描（迭代）：inf / nan → null、DateVal → 字符串
  function jsonLeaf(x, at, k, losses) {
    if (typeof x === 'number') { if (!isFinite(x)) lossAt(losses, 'json-nonfinite', at, k, String(x)); }
    else if (x instanceof DateVal) lossAt(losses, 'json-date', at, k, x.raw);
  }
  function jsonScan(root, losses) {
    if (root === null || typeof root !== 'object' || isLeafObj(root)) { jsonLeaf(root, null, undefined, losses); return; }
    var stack = [{ v: root, at: null }], f, v, i, k, x, keys, kids;
    while (stack.length) {
      f = stack.pop(); v = f.v; kids = [];
      if (Array.isArray(v)) {
        for (i = 0; i < v.length; i++) {
          x = v[i];
          if (x !== null && typeof x === 'object' && !isLeafObj(x)) kids.push({ v: x, at: { up: f.at, k: i } });
          else jsonLeaf(x, f.at, i, losses);
        }
      } else {
        keys = Object.keys(v);
        for (i = 0; i < keys.length; i++) {
          k = keys[i]; x = v[k];
          if (x !== null && typeof x === 'object' && !isLeafObj(x)) kids.push({ v: x, at: { up: f.at, k: k } });
          else jsonLeaf(x, f.at, k, losses);
        }
      }
      for (i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);   // 按文档顺序访问，路径示例更直观
    }
  }

  var langCache = {};
  function lang(id, make) {
    if (!langCache[id]) langCache[id] = make();
    return langCache[id];
  }

  var json = {
    id: 'json', label: 'JSON', ext: 'json', mime: 'application/json', vendor: null,
    caps: { format: true, minify: true, escape: true, topLevel: 'any', nulls: true, comments: false },
    sniff: function (sample) { var c = firstChar(sample); return c === '{' || c === '[' ? 1 : 0; },
    loaded: function () { return true; },
    ensureLoaded: function () { return Promise.resolve(); },
    language: function () { return lang('json', function () { return CM.json(); }); },
    parse: function (text) {
      try {
        return { value: parseJSON(text), warnings: [], docCount: 1 };
      } catch (err) {
        var msg = errMsg(err);
        if (LONG_DIGITS.test(text)) {   // 大数保护路径改写过文本，用原文重新解析拿到准确位置
          try { JSON.parse(text); } catch (err2) { msg = errMsg(err2); }
        }
        var off = findJsonError(text);
        if (off < 0) off = jsonErrorOffset(text, msg);
        throw new FormatError('json', msg, off);
      }
    },
    // inf / nan 按原生行为写成 null、DateVal 写成字符串，都记损失；BigNum 原文输出
    stringify: function (value, opts) {
      var indent = opts && opts.indent ? opts.indent : 4, losses = [];
      if (value === undefined) return { text: '', losses: losses };
      jsonScan(value, losses);
      return { text: stringifyJSON(value, indent), losses: losses };
    },
    format: format,
    minify: minify,
    escape: minifyAndEscape,
    unescape: unescape
  };

  /* ======================================================================
   *  YAML 适配器（js-yaml，YAML 1.2 core schema）
   * ==================================================================== */
  var YAML_MAX_NODES = 5000000;
  var yamlSchemas = null, yamlWarnings = null;
  var YAML_BIG_RE = /^[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
  var DATE_LIKE_RE = /^(?:\d{4}-\d\d-\d\d(?:[Tt ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:[Zz]|[ \t]*[-+]\d\d?(?::?\d\d)?)?)?|\d\d:\d\d:\d\d(?:\.\d+)?)$/;

  function yamlSetup() {
    if (yamlSchemas) return yamlSchemas;
    var Y = window.JVYaml;
    // 大数：16 位以上的十进制数字保留原文。必须排在 core 的 int / float 之前
    var bigTag = Y.defineScalarTag('tag:jsonviewer,2026:bignum', {
      implicit: true,
      implicitFirstChars: ['-', '+', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
      resolve: function (s) {
        if (!LONG_DIGITS.test(s) || !YAML_BIG_RE.test(s)) return Y.NOT_RESOLVED;
        return new BigNum(s.replace(/^\+/, '').replace(/^(-?)0+(?=\d)/, '$1'));
      },
      identify: function (d) { return d instanceof BigNum; },
      represent: function (d) { return d.raw; }
    });
    // 只在输出侧存在：DateVal 输出为不带引号的标量，长得像日期的普通字符串则因此被加引号
    var dateTag = Y.defineScalarTag('tag:jsonviewer,2026:date', {
      implicit: true,
      resolve: function (s) { return DATE_LIKE_RE.test(s) ? new DateVal(s, 'date') : Y.NOT_RESOLVED; },
      identify: function (d) { return d instanceof DateVal; },
      represent: function (d) { return d.raw; }
    });
    // 未知标签兜底（空前缀 + 前缀匹配，能接住 !Ref、!!binary、!!set 等），降级为裸值并记 warning
    var anyScalar = Y.defineScalarTag('', {
      matchByTagPrefix: true,
      resolve: function (s, explicit, tagName) { warn(yamlWarnings, 'yaml-tag-dropped', '', tagName); return s; },
      identify: function () { return false; }
    });
    var anySeq = Y.defineSequenceTag('', {
      matchByTagPrefix: true,
      create: function (tagName) { warn(yamlWarnings, 'yaml-tag-dropped', '', tagName); return []; },
      addItem: function (c, item) { c.push(item); },
      identify: function () { return false; }
    });
    var anyMap = Y.defineMappingTag('', {
      matchByTagPrefix: true,
      create: function (tagName) { warn(yamlWarnings, 'yaml-tag-dropped', '', tagName); return {}; },
      addPair: function (c, k, v) {
        if (k !== null && typeof k === 'object') return 'complex keys are not supported';
        var key = String(k);
        if (key === '__proto__') Object.defineProperty(c, key, { value: v, writable: true, enumerable: true, configurable: true });
        else c[key] = v;
        return '';
      },
      has: function (c, k) { return Object.prototype.hasOwnProperty.call(c, String(k)); },
      keys: function (r) { return Object.keys(r); },
      get: function (r, k) { return r[k]; },
      identify: function () { return false; }
    });
    var core = Y.CORE_SCHEMA.tags;
    yamlSchemas = {
      load: new Y.Schema(core.concat([Y.mergeTag, anyScalar, anySeq, anyMap])),
      loadBig: new Y.Schema([bigTag].concat(core, [Y.mergeTag, anyScalar, anySeq, anyMap])),
      dump: new Y.Schema([bigTag, dateTag].concat(Y.DUMP_SCHEMA.tags))
    };
    return yamlSchemas;
  }

  // 循环引用与别名炸弹检查：一趟迭代遍历，按对象身份记忆化「展开后节点数」
  function yamlCheckAliases(root) {
    if (root === null || typeof root !== 'object' || root instanceof BigNum) return;
    var done = new Map(), onPath = new Set(), stack = [];
    function push(o) {
      onPath.add(o);
      stack.push({ o: o, keys: Array.isArray(o) ? null : Object.keys(o), i: 0, sum: 1 });
    }
    function tooBig() { throw new FormatError('yaml', 'YAML 别名展开后节点数超过 ' + YAML_MAX_NODES + '，无法展示（疑似别名炸弹）', -1); }
    push(root);
    while (stack.length) {
      var f = stack[stack.length - 1];
      var n = f.keys ? f.keys.length : f.o.length;
      if (f.i < n) {
        var c = f.keys ? f.o[f.keys[f.i]] : f.o[f.i];
        f.i++;
        if (c === null || typeof c !== 'object' || c instanceof BigNum || c instanceof DateVal) { f.sum++; continue; }
        if (onPath.has(c)) throw new FormatError('yaml', 'YAML 含递归别名（循环引用），无法展示', -1);
        var s = done.get(c);
        if (s === undefined) { push(c); continue; }
        f.sum += s;
        if (f.sum > YAML_MAX_NODES) tooBig();
      } else {
        stack.pop();
        onPath.delete(f.o);
        done.set(f.o, f.sum);
        if (f.sum > YAML_MAX_NODES) tooBig();
        if (stack.length) stack[stack.length - 1].sum += f.sum;
      }
    }
  }

  // js-yaml 对复合键（序列或映射作键）只报偏移 0：用事件流找出第一个复合键的位置
  function yamlComplexKeyOffset(text) {
    var Y = window.JVYaml, ev, stack = [], i, e, top, isKey, at;
    try { ev = Y.parseEvents(text, { maxDepth: 1000 }); } catch (err) { return -1; }
    for (i = 0; i < ev.length; i++) {
      e = ev[i];
      if (e.type === 6) { stack.pop(); continue; }                     // POP
      if (e.type === 1) { stack.push({ map: false }); continue; }      // DOCUMENT
      top = stack[stack.length - 1];
      isKey = false;
      if (top && top.map) { isKey = top.key; top.key = !top.key; }
      if (e.type === 2 || e.type === 3) {                               // SEQUENCE / MAPPING
        if (isKey) {
          at = e.start;
          if (e.anchorStart >= 0 && e.anchorStart < at) at = e.anchorStart;
          if (e.tagStart >= 0 && e.tagStart < at) at = e.tagStart;
          return at;
        }
        stack.push({ map: e.type === 3, key: true });
      }
    }
    return -1;
  }

  // 文本最后一个非空、非注释行是否为 '---'（尾部 '---' 会产生一个空文档，需要剔除）
  function endsWithDocStart(text) {
    var end = text.length;
    while (end > 0) {
      var start = text.lastIndexOf('\n', end - 1) + 1;
      var line = text.slice(start, end).trim();
      if (line && line.charAt(0) !== '#') return /^---(?:\s+#.*)?$/.test(line);
      end = start - 1;
    }
    return false;
  }

  var yaml = {
    id: 'yaml', label: 'YAML', ext: 'yaml', mime: 'application/yaml', vendor: 'yaml',
    caps: { format: true, minify: false, escape: false, topLevel: 'any', nulls: true, comments: true },
    sniff: function (sample) { return scanSignals(sample).yaml; },
    loaded: function () { return !!window.JVYaml; },
    ensureLoaded: function () { return ensureGlobal('yaml', 'JVYaml'); },
    language: function () { return lang('yaml', function () { return CM.yaml(); }); },
    parse: function (text) {
      var Y = window.JVYaml, sc = yamlSetup(), docs, warnings = [];
      yamlWarnings = warnings;
      try {
        docs = Y.loadAll(text, {
          schema: LONG_DIGITS.test(text) ? sc.loadBig : sc.load,
          maxDepth: 1000, maxAliases: 10000
        });
      } catch (e) {
        if (e instanceof Y.YAMLException) {
          var pos = e.mark && typeof e.mark.position === 'number' ? e.mark.position : -1;
          if (pos === 0 && /complex key/.test(e.reason || '')) pos = yamlComplexKeyOffset(text);
          throw new FormatError('yaml', e.reason || e.message, pos);
        }
        throw new FormatError('yaml', errMsg(e), -1);
      } finally {
        yamlWarnings = null;
      }
      if (docs.length > 1 && docs[docs.length - 1] === null && endsWithDocStart(text)) docs.pop();
      var value = docs.length === 0 ? undefined : docs.length === 1 ? docs[0] : docs;
      if (text.indexOf('*') !== -1) yamlCheckAliases(value);
      if (docs.length === 1 && typeof value === 'string' && /\n\s*\S/.test(text.trim())) {
        warn(warnings, 'yaml-scalar-root', '$', '');
      }
      return { value: value, warnings: warnings, docCount: docs.length };
    },
    // opts.docCount > 1（多文档来源）时每个文档前写 '---'；别名按值展开（noRefs）
    stringify: function (value, opts) {
      var Y = window.JVYaml, sc = yamlSetup();
      var o = { schema: sc.dump, indent: opts && opts.indent ? opts.indent : 2, noRefs: true, lineWidth: -1 };
      try {
        if (opts && opts.docCount > 1 && Array.isArray(value)) {
          return { text: value.map(function (d) { return '---\n' + Y.dump(d, o); }).join(''), losses: [] };
        }
        return { text: value === undefined ? '' : Y.dump(value, o), losses: [] };
      } catch (e) {
        throw new FormatError('yaml', errMsg(e), -1);
      }
    },
    // 解析后重排：注释、锚点、书写风格不保留
    format: function (text, opts) {
      var r = yaml.parse(text);
      if (r.docCount === 0) return text;
      return yaml.stringify(r.value, { indent: opts && opts.indent || 2, docCount: r.docCount }).text.replace(/\n$/, '');
    }
  };

  /* ======================================================================
   *  TOML 适配器（smol-toml）
   * ==================================================================== */
  function tomlDateVal(d) {
    var kind = d.isDate() ? 'date' : d.isTime() ? 'time' : d.isLocal() ? 'datetime-local' : 'datetime';
    var raw = d.toISOString().replace(/\.000(?=$|[Zz+-])/, '');
    return new DateVal(raw, kind);
  }
  // 原地把 BigInt → BigNum、TomlDate → DateVal（迭代遍历）
  function tomlNormalize(root) {
    var T = window.JVToml, stack = [root], o, keys, i, k, v;
    while (stack.length) {
      o = stack.pop();
      if (Array.isArray(o)) {
        for (i = 0; i < o.length; i++) {
          v = o[i];
          if (typeof v === 'bigint') o[i] = new BigNum(String(v));
          else if (v instanceof T.TomlDate) o[i] = tomlDateVal(v);
          else if (v !== null && typeof v === 'object') stack.push(v);
        }
      } else {
        keys = Object.keys(o);
        for (i = 0; i < keys.length; i++) {
          k = keys[i]; v = o[k];
          if (typeof v === 'bigint') o[k] = new BigNum(String(v));
          else if (v instanceof T.TomlDate) o[k] = tomlDateVal(v);
          else if (v !== null && typeof v === 'object') stack.push(v);
        }
      }
    }
    return root;
  }
  /* 输出前的预处理（§15.1）：对象里值为 null 的键丢弃、数组里的 null 元素丢弃（smol-toml 遇到会崩溃）、
   * BigNum → BigInt（非整数转 Number 并记精度损失）、DateVal → TomlDate；顶层数组 / 标量的包装在 stringify 里做。
   * 结构共享：子树无改动时直接复用原对象，不复制，也不修改模型。 */
  function tomlPrepare(value, losses) {
    var T = window.JVToml;
    function leaf(v, at, k) {
      if (v instanceof BigNum) {
        if (/^-?\d+$/.test(v.raw)) return BigInt(v.raw);
        lossAt(losses, 'toml-bignum', at, k, v.raw);
        return Number(v.raw);
      }
      if (v instanceof DateVal) return new T.TomlDate(v.raw);
      return v;
    }
    function copyKeys(v, keys, n) {
      var o = {};
      for (var j = 0; j < n; j++) defineKey(o, keys[j], v[keys[j]]);
      return o;
    }
    function conv(v, at, k) {   // at：v 所在容器的路径节点，k：v 在其中的键；递归深度受解析器的深度上限约束
      if (v === null || typeof v !== 'object') return v;
      if (isLeafObj(v)) return leaf(v, at, k);
      var here = k === undefined ? null : { up: at, k: k }, out = null, i, key, x, c, keys;
      if (Array.isArray(v)) {
        for (i = 0; i < v.length; i++) {
          x = v[i];
          if (x === null) {
            lossAt(losses, 'toml-null-item', here, i);
            if (!out) out = v.slice(0, i);
            continue;
          }
          c = conv(x, here, i);
          if (out) out.push(c);
          else if (c !== x) { out = v.slice(0, i); out.push(c); }
        }
      } else {
        keys = Object.keys(v);
        for (i = 0; i < keys.length; i++) {
          key = keys[i]; x = v[key];
          if (x === null) {
            lossAt(losses, 'toml-null-key', here, key);
            if (!out) out = copyKeys(v, keys, i);
            continue;
          }
          c = conv(x, here, key);
          if (out) defineKey(out, key, c);
          else if (c !== x) { out = copyKeys(v, keys, i); defineKey(out, key, c); }
        }
      }
      return out || v;
    }
    return conv(value, null, undefined);
  }

  var toml = {
    id: 'toml', label: 'TOML', ext: 'toml', mime: 'application/toml', vendor: 'toml',
    caps: { format: true, minify: false, escape: false, topLevel: 'object', nulls: false, comments: true },
    sniff: function (sample) { return scanSignals(sample).toml; },
    loaded: function () { return !!window.JVToml; },
    ensureLoaded: function () { return ensureGlobal('toml', 'JVToml'); },
    language: function () { return lang('toml', function () { return CM.StreamLanguage.define(CM.toml); }); },
    parse: function (text) {
      var T = window.JVToml, v;
      try {
        v = T.parse(text, { integersAsBigInt: 'asNeeded' });
      } catch (e) {
        if (e instanceof T.TomlError && e.line) {
          throw new FormatError('toml', String(e.message).split('\n')[0], lineColToOffset(text, e.line, e.column));
        }
        throw new FormatError('toml', errMsg(e).split('\n')[0], -1);
      }
      return { value: tomlNormalize(v), warnings: [], docCount: 1 };
    },
    // TOML 的顶层必须是表：顶层数组包装到 items、顶层标量包装到 value（顶层 null 直接丢弃），都记损失
    stringify: function (value) {
      var T = window.JVToml, losses = [], v;
      if (value === undefined) return { text: '', losses: losses };
      try {
        if (Array.isArray(value)) {
          lossAt(losses, 'toml-wrap-array', null);
          v = { items: tomlPrepare(value, losses) };
        } else if (value === null) {
          lossAt(losses, 'toml-wrap-scalar', null);
          lossAt(losses, 'toml-null-key', null);
          v = {};
        } else if (typeof value !== 'object' || isLeafObj(value)) {
          lossAt(losses, 'toml-wrap-scalar', null);
          v = { value: tomlPrepare(value, losses) };
        } else {
          v = tomlPrepare(value, losses);
        }
        var text = T.stringify(v);
        return { text: /\S/.test(text) ? text : '', losses: losses };   // 空表输出为空文本，而不是单个换行
      } catch (e) {
        throw new FormatError('toml', errMsg(e), -1);
      }
    },
    format: function (text) {
      return toml.stringify(toml.parse(text).value).text.replace(/\n$/, '');
    }
  };

  /* ======================================================================
   *  XML 适配器（原生 DOMParser）
   *  映射约定：属性 → '@名'；有属性或子元素时文本 → '#text'；同名兄弟元素 → 数组；
   *  命名空间前缀原样保留；CDATA 并入文本；注释 / 处理指令 / DOCTYPE 丢弃并记 warning。
   * ==================================================================== */
  var peNS;   // 本浏览器 parsererror 元素的命名空间，首次用到 XML 时探测
  function parserErrorNS() {
    if (peNS === undefined) {
      var d = new DOMParser().parseFromString('<', 'application/xml');
      var pe = d.getElementsByTagName('parsererror')[0] || d.documentElement;
      peNS = pe ? pe.namespaceURI : null;
    }
    return peNS;
  }
  function xmlDom(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    var ns = parserErrorNS();
    var list = ns ? doc.getElementsByTagNameNS(ns, 'parsererror') : doc.getElementsByTagName('parsererror');
    if (list.length) {
      var msg = list[0].textContent || 'XML 解析失败';
      var m = /error on line (\d+) at column (\d+):\s*([^\n]*)/.exec(msg);      // Chrome / Safari
      var off = -1;
      if (m) {
        off = lineColToOffset(text, +m[1], +m[2]);
        msg = m[3] || msg;
      } else {
        m = /Line Number (\d+), Column (\d+)/.exec(msg);                          // Firefox
        if (m) off = lineColToOffset(text, +m[1], +m[2]);
        msg = msg.split('\n')[0];
      }
      throw new FormatError('xml', msg.trim(), off, true);
    }
    return doc;
  }

  function defineKey(o, k, v) {
    if (k === '__proto__') Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
    else o[k] = v;
  }

  var JSON_NUM_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
  function inferType(s) {
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (JSON_NUM_RE.test(s)) return LONG_DIGITS.test(s) ? new BigNum(s) : Number(s);
    return s;
  }

  function xmlPath(f) {
    var parts = [];
    for (; f; f = f.parent) parts.push(f.name);
    parts.reverse();
    var p = '$';
    for (var i = 0; i < parts.length; i++) p += /^[A-Za-z_$][\w$]*$/.test(parts[i]) ? '.' + parts[i] : '[' + JSON.stringify(parts[i]) + ']';
    return p;
  }

  // DOM → 对象：显式栈迭代，无递归深度限制
  function xmlToObject(doc, opts, warnings) {
    var infer = !!(opts && opts.inferTypes);
    var conv = infer ? inferType : function (s) { return s; };
    var top = doc.childNodes, rootEl = null, i, n;
    for (i = 0; i < top.length; i++) {
      n = top[i];
      if (n.nodeType === 1) rootEl = n;
      else if (n.nodeType === 8) warn(warnings, 'xml-comment', '$', n.data.slice(0, 40));
      else if (n.nodeType === 7) warn(warnings, 'xml-pi', '$', n.target);
      else if (n.nodeType === 10) warn(warnings, 'xml-doctype', '$', n.name);
    }
    if (!rootEl) return {};
    function frame(el, parent) {
      return { el: el, parent: parent, name: el.nodeName, kids: el.childNodes, i: 0, runs: [], run: null, groups: null, order: null, elems: 0, lastName: null, value: undefined };
    }
    function finish(f) {
      var el = f.el, attrs = el.attributes, j, k, text, obj;
      if (f.run !== null) f.runs.push(f.run);
      var texts = [];
      for (j = 0; j < f.runs.length; j++) { k = f.runs[j].trim(); if (k) texts.push(k); }
      text = texts.join(' ');
      if (f.elems && texts.length) warn(warnings, 'xml-mixed', xmlPath(f), f.name);
      if (!attrs.length && !f.elems) return conv(text);
      obj = {};
      for (j = 0; j < attrs.length; j++) obj['@' + attrs[j].name] = conv(attrs[j].value);
      if (text) obj['#text'] = conv(text);
      if (f.order) {
        for (j = 0; j < f.order.length; j++) {
          k = f.order[j];
          var g = f.groups.get(k);
          defineKey(obj, k, g.length === 1 ? g[0] : g);
        }
      }
      return obj;
    }
    var root = frame(rootEl, null), stack = [root], f, c, t;
    while (stack.length) {
      f = stack[stack.length - 1];
      if (f.i < f.kids.length) {
        c = f.kids[f.i++];
        t = c.nodeType;
        if (t === 3 || t === 4) {                 // 文本、CDATA：连续的并成一段
          f.run = f.run === null ? c.data : f.run + c.data;
        } else if (t === 1) {
          if (f.run !== null) { f.runs.push(f.run); f.run = null; }
          stack.push(frame(c, f));
        } else if (t === 8) {
          warn(warnings, 'xml-comment', xmlPath(f), c.data.slice(0, 40));
        } else if (t === 7) {
          warn(warnings, 'xml-pi', xmlPath(f), c.target);
        }
        continue;
      }
      stack.pop();
      var v = finish(f), p = f.parent;
      if (!p) { root.value = v; break; }
      p.elems++;
      if (!p.groups) { p.groups = new Map(); p.order = []; }
      var g = p.groups.get(f.name);
      if (!g) { g = []; p.groups.set(f.name, g); p.order.push(f.name); }
      else if (p.lastName !== f.name) warn(warnings, 'xml-order', xmlPath(f), f.name);
      g.push(v);
      p.lastName = f.name;
    }
    var out = {};
    defineKey(out, rootEl.nodeName, root.value);
    return out;
  }

  function escText(s) {
    return s.replace(/[&<>]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; });
  }
  function escAttr(s) {
    return s.replace(/[&<"\n\r\t]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '"' ? '&quot;' : c === '\n' ? '&#10;' : c === '\r' ? '&#13;' : '&#9;';
    });
  }
  function startTag(el) {
    var s = '<' + el.nodeName, a = el.attributes;
    for (var i = 0; i < a.length; i++) s += ' ' + a[i].name + '="' + escAttr(a[i].value) + '"';
    return s;
  }
  function leafXml(n, trim) {
    switch (n.nodeType) {
      case 3: return escText(trim ? n.data.trim() : n.data);
      case 4: return '<![CDATA[' + n.data + ']]>';
      case 8: return '<!--' + n.data + '-->';
      case 7: return '<?' + n.target + (n.data ? ' ' + n.data : '') + '?>';
      default: return '';
    }
  }
  function isBlank(n) { return n.nodeType === 3 && !/\S/.test(n.data); }

  // 从源文本里原样取出 <?xml ...?> 声明与 DOCTYPE（DOM 不保留声明，DOCTYPE 的内部子集也拿不到）
  function xmlDecl(src) {
    var m = /^\uFEFF?\s*(<\?xml\s[^?]*\?>)/.exec(src.slice(0, 512));
    return m ? m[1] : '';
  }
  function xmlDoctype(src, node) {
    var i = src.indexOf('<!DOCTYPE'), depth = 0, q = '', c;
    if (i !== -1) {
      for (var j = i + 9; j < src.length; j++) {
        c = src.charAt(j);
        if (q) { if (c === q) q = ''; continue; }
        if (c === '"' || c === "'") q = c;
        else if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) return src.slice(i, j + 1);
      }
    }
    var s = '<!DOCTYPE ' + node.name;
    if (node.publicId) s += ' PUBLIC "' + node.publicId + '" "' + node.systemId + '"';
    else if (node.systemId) s += ' SYSTEM "' + node.systemId + '"';
    return s + '>';
  }

  // 重排（pretty 为缩进字符串）或压缩（pretty 为 null）：保留注释、CDATA、处理指令，去掉元素间的纯空白文本
  function xmlSerialize(doc, src, pretty) {
    var lines = [], i, n, decl = xmlDecl(src);
    function ind(d) { return pretty ? spaces(d * pretty.length) : ''; }
    if (decl) lines.push(decl);
    var top = doc.childNodes;
    for (i = 0; i < top.length; i++) {
      n = top[i];
      if (n.nodeType === 10) lines.push(xmlDoctype(src, n));
      else if (n.nodeType === 1) serializeElement(n);
      else if (n.nodeType === 7 || n.nodeType === 8) lines.push(leafXml(n, false));
    }
    return lines.join(pretty ? '\n' : '');

    function serializeElement(rootEl) {
      var stack = [{ el: rootEl, d: 0, kids: null, i: 0 }], f, k, j, kids, block, s;
      while (stack.length) {
        f = stack[stack.length - 1];
        if (!f.kids) {
          kids = f.el.childNodes; block = false;
          for (j = 0; j < kids.length; j++) { k = kids[j].nodeType; if (k === 1 || k === 7 || k === 8) { block = true; break; } }
          f.kids = [];
          for (j = 0; j < kids.length; j++) if (!(block && isBlank(kids[j]))) f.kids.push(kids[j]);
          if (!f.kids.length) { lines.push(ind(f.d) + startTag(f.el) + '/>'); stack.pop(); continue; }
          if (!block) {                                   // 只有文本 / CDATA：写在同一行，内容原样
            s = ind(f.d) + startTag(f.el) + '>';
            for (j = 0; j < f.kids.length; j++) s += leafXml(f.kids[j], false);
            lines.push(s + '</' + f.el.nodeName + '>');
            stack.pop();
            continue;
          }
          lines.push(ind(f.d) + startTag(f.el) + '>');
        }
        if (f.i < f.kids.length) {
          k = f.kids[f.i++];
          if (k.nodeType === 1) stack.push({ el: k, d: f.d + 1, kids: null, i: 0 });
          else lines.push(ind(f.d + 1) + leafXml(k, !!pretty));
          continue;
        }
        lines.push(ind(f.d) + '</' + f.el.nodeName + '>');
        stack.pop();
      }
    }
  }

  /* ----------------------------------------------------------------------
   *  对象 → XML（§11.5）。显式任务栈迭代，不受嵌套深度限制。
   *  名字按 XML 1.0 第 5 版 Name 规则（BMP 子集）清洗：非法字符换成 '_'，首字符非法时前补 '_'，空名写 '_'。
   *  冒号只在恰好一个、前缀与本地名都是合法 NCName、且前缀为 xml 或已由本元素 / 祖先的 @xmlns:前缀 声明时保留，
   *  否则浏览器（以及任何命名空间感知的解析器）会拒绝读回。
   * -------------------------------------------------------------------- */
  var XML_START = 'A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD';
  var NC_BAD = new RegExp('[^' + XML_START + '\\-.0-9\\u00B7\\u0300-\\u036F\\u203F\\u2040]', 'gu');
  var NC_START = new RegExp('^[' + XML_START + ']', 'u');
  // XML 1.0 不允许的字符：C0 控制字符（制表、换行、回车除外）、U+FFFE / U+FFFF、孤立代理项
  var XML_BAD_CHAR = /[\0-\x08\x0B\x0C\x0E-\x1F￾￿]|\p{Cs}/gu;

  function ncName(s) {
    var r = s.replace(NC_BAD, '_');
    if (!r) return '_';
    return NC_START.test(r) ? r : '_' + r;
  }
  function isNCName(s) { return s !== '' && ncName(s) === s; }
  // attr 为 true 时按属性名处理（xmlns、xmlns:前缀 是声明本身）
  function xmlQName(s, scope, attr) {
    var i = s.indexOf(':');
    if (i > 0 && i === s.lastIndexOf(':')) {
      var pre = s.slice(0, i), loc = s.slice(i + 1);
      if (isNCName(pre) && isNCName(loc)) {
        if (pre === 'xml' || (attr && pre === 'xmlns') || (pre !== 'xmlns' && scope[pre] === true)) return s;
      }
    }
    return ncName(s);
  }
  // 本元素的 @xmlns:前缀 声明（值为标量）扩展出新的作用域；没有声明时复用父作用域
  function xmlScope(v, scope) {
    var keys = Object.keys(v), s = scope;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.length > 7 && k.slice(0, 7) === '@xmlns:') {
        var x = v[k];
        if (x === null || typeof x !== 'object' || isLeafObj(x)) {
          if (s === scope) s = Object.create(scope);
          s[k.slice(7)] = true;
        }
      }
    }
    return s;
  }
  function xmlScalarText(v) {
    if (typeof v === 'string') return v;
    if (isLeafObj(v)) return v.raw;
    return String(v);
  }

  function objectToXml(value, opts, losses) {
    var unit = opts && opts.indent ? opts.indent : 4;
    var item = opts && opts.xmlItem ? ncName(opts.xmlItem) : 'item';
    var rootName = ncName(opts && opts.xmlRoot ? opts.xmlRoot : 'root');
    var out = ['<?xml version="1.0" encoding="UTF-8"?>'], indents = [''], nameCache = new Map();
    var baseScope = Object.create(null);

    function ind(d) {
      while (indents.length <= d) indents.push(spaces(indents.length * unit));
      return indents[d];
    }
    function clean(s, at, k) {
      XML_BAD_CHAR.lastIndex = 0;
      if (!XML_BAD_CHAR.test(s)) return s;
      var n = 0;
      s = s.replace(XML_BAD_CHAR, function () { n++; return '�'; });
      for (var i = 0; i < n; i++) lossAt(losses, 'xml-control-char', at, k);
      return s;
    }
    function text(v, at, k) {
      return clean(xmlScalarText(v), at, k).replace(/[&<>\r]/g, function (c) {
        return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&#13;';
      });
    }
    function attrText(v, at, k) { return escAttr(clean(xmlScalarText(v), at, k)); }
    // 元素名：k 为原始键名，kAt / kKey 为记损失用的位置
    function elName(k, scope, kAt, kKey) {
      var n;
      if (k.indexOf(':') === -1) {
        n = nameCache.get(k);
        if (n === undefined) { n = ncName(k); nameCache.set(k, n); }
      } else {
        n = xmlQName(k, scope, false);
      }
      if (n !== k) lossAt(losses, 'xml-name', kAt, kKey, (k === '' ? '""' : k) + ' → ' + n);
      return n;
    }

    // 根元素：顶层是单键对象、该键值不是数组且键名合法时用该键作根，否则包一层 <root>
    var tasks = [], keys, rk, rv;
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !isLeafObj(value) && (keys = Object.keys(value)).length === 1) {
      rk = keys[0]; rv = value[rk];
      var own = rv !== null && typeof rv === 'object' && !Array.isArray(rv) && !isLeafObj(rv) ? xmlScope(rv, baseScope) : baseScope;
      if (Array.isArray(rv) || xmlQName(rk, own, false) !== rk) rk = undefined;
    }
    if (rk !== undefined) {
      tasks.push({ n: rk, v: rv, d: 0, at: { up: null, k: rk }, scope: baseScope, fixed: false });
    } else {
      lossAt(losses, 'xml-root', null, undefined, rootName);
      tasks.push({ n: rootName, v: value === undefined ? null : value, d: 0, at: null, scope: baseScope, fixed: true });
    }

    var t, v, name, scope, i, j, k, x, attrs, txt, kids, seen, an, at, base, locUp, locKey;
    while (tasks.length) {
      t = tasks.pop();
      if (typeof t === 'string') { out.push(t); continue; }
      v = t.v; scope = t.scope;
      var isObj = v !== null && typeof v === 'object' && !Array.isArray(v) && !isLeafObj(v);
      if (isObj) scope = xmlScope(v, scope);
      locUp = t.at ? t.at.up : null; locKey = t.at ? t.at.k : undefined;   // v 自身的位置
      name = t.fixed ? t.n : t.inArr ? elName(t.n, scope, t.kAt, t.kKey) : elName(t.n, scope, locUp, locKey);
      var pad = ind(t.d);
      if (v === null) { out.push(pad + '<' + name + '/>'); continue; }
      if (!isObj && !Array.isArray(v)) { out.push(pad + '<' + name + '>' + text(v, locUp, locKey) + '</' + name + '>'); continue; }
      kids = [];
      if (Array.isArray(v)) {                     // 数组作元素内容（数组里嵌数组、顶层数组）：每项一个 <item>
        if (!v.length) {
          lossAt(losses, 'xml-empty-array', locUp, locKey);
          out.push(pad + '<' + name + '/>');
          continue;
        }
        if (v.length === 1) lossAt(losses, 'xml-single-array', locUp, locKey);
        for (i = 0; i < v.length; i++) kids.push({ n: item, v: v[i], d: t.d + 1, at: { up: t.at, k: i }, scope: scope, fixed: true });
        out.push(pad + '<' + name + '>');
      } else {
        keys = Object.keys(v); attrs = ''; txt = null; seen = null;
        for (i = 0; i < keys.length; i++) {
          k = keys[i]; x = v[k];
          var scalar = x === null || typeof x !== 'object' || isLeafObj(x);
          if (k.charAt(0) === '@' && scalar) {
            an = xmlQName(k.slice(1), scope, true);
            if (seen && seen[an]) {                // 清洗后与已有属性重名：加序号
              base = an; j = 2;
              while (seen[base + '_' + j]) j++;
              an = base + '_' + j;
            }
            if (an !== k.slice(1)) lossAt(losses, 'xml-name', t.at, k, k + ' → @' + an);
            (seen || (seen = Object.create(null)))[an] = true;
            attrs += ' ' + an + '="' + (x === null ? '' : attrText(x, t.at, k)) + '"';
          } else if (k === '#text' && scalar) {
            if (x !== null) txt = text(x, t.at, k);
          } else {
            if (k.charAt(0) === '@') lossAt(losses, 'xml-attr-container', t.at, k);
            at = { up: t.at, k: k };
            if (Array.isArray(x)) {                // 数组：以父键名重复元素
              if (!x.length) { lossAt(losses, 'xml-empty-array', t.at, k); continue; }
              if (x.length === 1) lossAt(losses, 'xml-single-array', t.at, k);
              for (j = 0; j < x.length; j++) kids.push({ n: k, v: x[j], d: t.d + 1, at: { up: at, k: j }, kAt: t.at, kKey: k, scope: scope, fixed: false, inArr: true });
            } else {
              kids.push({ n: k, v: x, d: t.d + 1, at: at, scope: scope, fixed: false });
            }
          }
        }
        if (!kids.length) {
          out.push(pad + '<' + name + attrs + (txt === null ? '/>' : '>' + txt + '</' + name + '>'));
          continue;
        }
        out.push(pad + '<' + name + attrs + '>');
        if (txt) out.push(ind(t.d + 1) + txt);
      }
      tasks.push(pad + '</' + name + '>');
      for (i = kids.length - 1; i >= 0; i--) tasks.push(kids[i]);
    }
    return out.join('\n') + '\n';
  }

  var xml = {
    id: 'xml', label: 'XML', ext: 'xml', mime: 'application/xml', vendor: null,
    caps: { format: true, minify: true, escape: false, topLevel: 'element', nulls: false, comments: true },
    sniff: function (sample) { return firstChar(sample) === '<' ? 1 : 0; },
    loaded: function () { return true; },
    ensureLoaded: function () { return Promise.resolve(); },
    language: function () { return lang('xml', function () { return CM.xml(); }); },
    parse: function (text, opts) {
      var warnings = [];
      var value = xmlToObject(xmlDom(text), opts, warnings);
      return { value: value, warnings: warnings, docCount: 1 };
    },
    // 对象 → XML；opts：indent（默认 4）、xmlRoot（需要包装时的根元素名，默认 root）、xmlItem（固定 item）
    stringify: function (value, opts) {
      var losses = [];
      return { text: objectToXml(value, opts, losses), losses: losses };
    },
    format: function (text, opts) {
      return xmlSerialize(xmlDom(text), text, spaces(opts && opts.indent || 4));
    },
    minify: function (text) {
      return xmlSerialize(xmlDom(text), text, null);
    }
  };

  /* ======================================================================
   *  格式识别（§13.2）
   * ==================================================================== */
  function firstIndex(text) {
    var i = 0, n = text.length, c;
    if (n && text.charCodeAt(0) === 0xFEFF) i = 1;
    for (; i < n; i++) {
      c = text.charCodeAt(i);
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13) return i;
    }
    return -1;
  }
  function firstChar(text) { var i = firstIndex(text); return i < 0 ? '' : text.charAt(i); }

  var TOML_BARE = /^[A-Za-z0-9_-]+$/;
  // 整行是 TOML 表头：[a.b] 或 [[a]]，裸键，且首个键不是纯数字、true、false、null
  function isTomlHeader(line) {
    line = line.replace(/\s+#.*$/, '').trim();
    var m = /^\[\[([^\[\]]+)\]\]$/.exec(line) || /^\[([^\[\]]+)\]$/.exec(line);
    if (!m) return false;
    var parts = m[1].split('.');
    for (var i = 0; i < parts.length; i++) if (!TOML_BARE.test(parts[i].trim())) return false;
    var k = parts[0].trim();
    return !/^\d+$/.test(k) && k !== 'true' && k !== 'false' && k !== 'null';
  }
  // 前 8KB 内最多 50 个有效行（非空、非 # 注释）的 TOML / YAML 信号计数
  function scanSignals(text) {
    var s = text.slice(0, 8192).split('\n'), t = 0, y = 0, lines = 0, i, line, eq, col, m;
    for (i = 0; i < s.length && lines < 50; i++) {
      line = s[i].replace(/^[\s\uFEFF]+/, '').replace(/\s+$/, '');
      if (!line || line.charAt(0) === '#') continue;
      lines++;
      if (isTomlHeader(line)) { t++; continue; }
      eq = line.indexOf('=');
      m = /:(?:\s|$)/.exec(line);
      col = m ? m.index : -1;
      if (eq !== -1 && (col === -1 || eq < col)) t++;
      else if (line === '-' || line.slice(0, 2) === '- ' || (col !== -1 && (eq === -1 || col < eq))) y++;
    }
    return { toml: t, yaml: y };
  }

  function detect(text) {
    var i = firstIndex(text);
    if (i < 0) return 'json';
    var c = text.charAt(i);
    if (c === '<') return 'xml';
    if (c === '{') return 'json';
    if (c === '[') {
      var nl = text.indexOf('\n', i), end = nl === -1 ? text.length : nl;
      if (end - i <= 256 && isTomlHeader(text.slice(i, end))) return 'toml';
      return 'json';
    }
    var head = text.slice(i, i + 5);
    if (head.slice(0, 3) === '---' || head === '%YAML' || head.slice(0, 4) === '%TAG') return 'yaml';
    var sig = scanSignals(text.slice(i, i + 8192));
    if (sig.toml > sig.yaml) return 'toml';
    if (sig.yaml > 0) return 'yaml';
    try { JSON.parse(text); return 'json'; } catch (e) { return 'yaml'; }
  }

  /* ======================================================================
   *  格式互转（§15）
   * ==================================================================== */
  var FORMATS = { json: json, yaml: yaml, toml: toml, xml: xml };

  // 模型 → 目标格式文本。opts：{ indent, xmlRoot, xmlItem, docCount }；目标库须已加载。不修改 model
  function convert(model, targetId, opts) {
    var ad = FORMATS[targetId];
    if (!ad) throw new FormatError(String(targetId), '未知的目标格式：' + targetId, -1);
    if (!ad.loaded()) throw new FormatError(targetId, ad.label + ' 库尚未加载', -1);
    try {
      return ad.stringify(model, opts || {});
    } catch (e) {
      if (e instanceof FormatError) throw e;
      throw new FormatError(targetId, errMsg(e), -1);   // 例如嵌套过深导致的栈溢出
    }
  }

  /* 固有损失：只由源格式与目标格式决定（§15.1 矩阵），与具体数据无关。
   * info：{ docCount, inferTypes }。返回中文说明列表，无损时为空数组。 */
  function inherentLosses(src, tgt, info) {
    var out = [], multi = info && info.docCount > 1;
    if (src === 'yaml') {
      out.push(tgt === 'yaml' ? '注释不保留，锚点与别名按值展开，书写风格规范化' : '注释、锚点、标签与书写风格不保留');
      if (tgt !== 'yaml') out.push('非字符串键（数字、布尔等）会变为字符串');
      if (multi && tgt !== 'yaml') out.push('多个文档合并为一个数组');
    } else if (src === 'toml') {
      out.push('注释不保留');
      if (tgt === 'toml') out.push('整数与浮点不区分（1.0 写成 1），表的书写风格规范化');
      else if (tgt === 'json') out.push('整数与浮点不区分（1.0 变为 1），表的书写风格不保留');
      else if (tgt === 'yaml') out.push('日期时间输出为不带引号的标量，按 YAML 1.2 读回时是字符串');
    } else if (src === 'xml') {
      out.push(tgt === 'xml' ? '注释、处理指令、DOCTYPE、CDATA 标记不保留（左侧「格式化」按钮可保留）' : '注释、处理指令、DOCTYPE、CDATA 标记不保留');
      if (tgt !== 'xml') {
        out.push('同名元素只出现一次时不是数组，单个与数组无法区分');
        out.push('文本首尾空白已去除');
        if (!(info && info.inferTypes)) out.push('值全部是字符串（可在选项中开启「XML 推断类型」）');
      }
    }
    if (src !== 'xml' && tgt === 'xml') out.push('数字、布尔、null 都变为文本，单元素数组与单个值无法区分');
    if (src !== 'toml' && tgt === 'toml') out.push('键序调整：普通键在前，表与表数组在后');
    return out;
  }

  // 损失 / warning 条目的中文说明（动词说明做了什么；路径与数量由界面另外展示）
  var LOSS_TEXT = {
    'json-nonfinite': function (n) { return n + ' 个 inf / nan 已写成 null'; },
    'json-date': function (n) { return n + ' 个日期时间已转为字符串'; },
    'toml-null-key': function (n) { return n + ' 个值为 null 的键已丢弃（TOML 没有 null）'; },
    'toml-null-item': function (n) { return n + ' 个数组中的 null 元素已丢弃，后续元素下标前移'; },
    'toml-wrap-array': function () { return '顶层数组已包装到 items 键下'; },
    'toml-wrap-scalar': function () { return '顶层标量已包装到 value 键下'; },
    'toml-bignum': function (n) { return n + ' 个高精度小数已转为双精度浮点，精度可能丢失'; },
    'xml-root': function (n, s) { return '已包装到 <' + s + '> 根元素下（可在选项「XML 根元素名」中修改）'; },
    'xml-empty-array': function (n) { return n + ' 个空数组已丢弃'; },
    'xml-single-array': function (n) { return n + ' 个单元素数组写成单个元素，读回时不再是数组'; },
    'xml-attr-container': function (n) { return n + ' 个 @ 开头的键值为对象或数组，已按普通元素输出'; },
    'xml-name': function (n, s) { return n + ' 处键名不是合法的 XML 名称，已改写' + (s ? '（例：' + s + '）' : ''); },
    'xml-control-char': function (n) { return n + ' 个 XML 不允许的控制字符已替换为 U+FFFD'; },
    'yaml-tag-dropped': function (n, s) { return n + ' 个 YAML 标签已丢弃' + (s ? '（例：' + s + '）' : ''); },
    'xml-comment': function (n) { return n + ' 条 XML 注释已丢弃'; },
    'xml-pi': function (n, s) { return n + ' 条处理指令已丢弃' + (s ? '（例：<?' + s + '?>）' : ''); },
    'xml-doctype': function () { return 'DOCTYPE 已丢弃'; },
    'xml-mixed': function (n) { return n + ' 处混合内容：文本已合并进 #text，与子元素的相对顺序丢失'; },
    'xml-order': function (n) { return n + ' 处同名元素不连续，已归并为数组，原顺序丢失'; }
  };
  function lossText(e) {
    var f = LOSS_TEXT[e.code];
    return f ? f(e.count, e.sample) : e.code + '（' + e.count + '）';
  }

  window.JV = {
    BigNum: BigNum,
    DateVal: DateVal,
    FormatError: FormatError,
    parseJSON: parseJSON,
    stringifyJSON: stringifyJSON,
    findJsonError: findJsonError,
    FORMATS: FORMATS,
    ORDER: ['json', 'yaml', 'toml', 'xml'],
    detect: detect,
    loadVendor: loadVendor,
    lineColToOffset: lineColToOffset,
    convert: convert,
    inherentLosses: inherentLosses,
    lossText: lossText,
    xmlName: ncName
  };
})();
