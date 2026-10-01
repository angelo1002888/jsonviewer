/*
 * 表驱动格式测试：启动已编译的 ./jsonviewer，在 headless Chrome 页面里直接调用 window.JV（parse / detect / format），
 * 覆盖 YAML / TOML / XML 解析与格式识别（XML 依赖浏览器的 DOMParser，所以不在 Node 里跑）。
 * 用法：make build && npm install && npm run test:formats
 * 环境变量：CHROME=/path/to/chrome（默认 /usr/bin/google-chrome）
 */
const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const BIN = path.join(__dirname, '..', 'jsonviewer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0, total = 0;
function check(name, ok, detail) {
  total++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (!ok && detail !== undefined ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}
function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
}
async function waitPort(port) {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise(res => { const c = net.connect(port, '127.0.0.1', () => { c.end(); res(true); }); c.on('error', () => res(false)); });
    if (ok) return;
    await sleep(50);
  }
  throw new Error('服务未在 5 秒内监听端口 ' + port);
}
// 与编辑器一致的 1 基行列
function lineCol(text, off) {
  const before = text.slice(0, off);
  const line = before.split('\n').length;
  return { line, col: off - (before.lastIndexOf('\n') + 1) + 1 };
}
const bn = raw => ({ $bn: raw });
const date = (raw, kind) => ({ $date: raw, kind });
const num = s => ({ $num: s });
const canon = v => JSON.stringify(v);

// 别名炸弹：7 层、每层 10 个别名，展开后 1000 万个叶子
const bomb = ['a: &a [x, x, x, x, x, x, x, x, x, x]'].concat('bcdefg'.split('').map((c, i) => c + ': &' + c + ' [' + Array(10).fill('*' + 'abcdefg'[i]).join(', ') + ']')).join('\n');

/*
 * 用例字段：
 *   fmt / text / opts      调用 JV.FORMATS[fmt].parse(text, opts)
 *   value                  期望值（BigNum → {$bn}，DateVal → {$date, kind}，Infinity / NaN → {$num}）
 *   warnings               必须出现的 warning code；noWarnings: true 表示不能有 warning
 *   docCount               期望的文档数
 *   error                  期望抛 FormatError：{ msg: 正则, line, col, approx }（只检查给出的字段）
 *   probe                  在页面里求值的表达式（变量 r 为 parse 结果），必须为 true
 */
const PARSE_CASES = [
  // ---- YAML ----
  { g: 'YAML', name: '大整数与高精度小数保留原文，普通数字仍是 number', fmt: 'yaml', text: 'a: 12345678901234567890\nb: 3.14159265358979323846\nc: 42\nd: -98765432109876543210\ne: +12345678901234567', value: { a: bn('12345678901234567890'), b: bn('3.14159265358979323846'), c: 42, d: bn('-98765432109876543210'), e: bn('12345678901234567') } },
  { g: 'YAML', name: '带引号的长数字仍是字符串', fmt: 'yaml', text: 'a: "12345678901234567890"\nb: \'98765432109876543210\'', value: { a: '12345678901234567890', b: '98765432109876543210' } },
  { g: 'YAML', name: 'yes / no / on 是字符串（YAML 1.2 core）', fmt: 'yaml', text: 'a: yes\nb: no\nc: on\nd: true\ne: ~', value: { a: 'yes', b: 'no', c: 'on', d: true, e: null } },
  { g: 'YAML', name: '日期是字符串；0o17 是数字；1_000 是字符串', fmt: 'yaml', text: 'd: 2001-12-14\nt: 2001-12-14T21:59:43.10-05:00\no: 0o17\nh: 0xFF\nu: 1_000', value: { d: '2001-12-14', t: '2001-12-14T21:59:43.10-05:00', o: 15, h: 255, u: '1_000' } },
  { g: 'YAML', name: '合并键 <<', fmt: 'yaml', text: 'base: &b {x: 1, y: 2}\nm:\n  <<: *b\n  y: 3', value: { base: { x: 1, y: 2 }, m: { x: 1, y: 3 } } },
  { g: 'YAML', name: '锚点与别名展开为共享引用', fmt: 'yaml', text: 'a: &x {k: [1, 2]}\nb: *x', value: { a: { k: [1, 2] }, b: { k: [1, 2] } }, probe: 'r.value.a === r.value.b' },
  { g: 'YAML', name: '循环引用被拒绝', fmt: 'yaml', text: 'a: &x\n  self: *x', error: { msg: /循环引用/ } },
  { g: 'YAML', name: '别名炸弹被拒绝', fmt: 'yaml', text: bomb, error: { msg: /别名展开/ } },
  { g: 'YAML', name: '多文档得数组，尾部 --- 的空文档剔除', fmt: 'yaml', text: '---\na: 1\n---\nb: 2\n---\n- 3\n---\n', value: [{ a: 1 }, { b: 2 }, [3]], docCount: 3 },
  { g: 'YAML', name: '多文档中显式的 null 文档保留', fmt: 'yaml', text: 'a: 1\n---\n~\n', value: [{ a: 1 }, null], docCount: 2 },
  { g: 'YAML', name: '纯注释文档得空树（不是错误）', fmt: 'yaml', text: '# 只有注释\n# second\n', docCount: 0, probe: 'r.value === undefined' },
  { g: 'YAML', name: '!Ref / !!binary / !!set 降级为裸值并产生 warning', fmt: 'yaml', text: 'a: !Ref foo\nb: !!binary aGVsbG8=\nc: !!set {x, y}\nd: !custom [1, 2]', value: { a: 'foo', b: 'aGVsbG8=', c: { x: null, y: null }, d: [1, 2] }, warnings: ['yaml-tag-dropped'], probe: 'r.warnings[0].count === 4' },
  { g: 'YAML', name: '非字符串键转字符串', fmt: 'yaml', text: '1: a\ntrue: b\n~: c\n3.5: d', value: { 1: 'a', true: 'b', null: 'c', '3.5': 'd' } },
  { g: 'YAML', name: '复合键报错并定位到该键', fmt: 'yaml', text: 'x: 0\ny:\n  a: 1\n  ? [x, y]\n  : 2', error: { msg: /complex keys/, line: 4, col: 5 } },
  { g: 'YAML', name: '流式映射里的复合键定位', fmt: 'yaml', text: '- 1\n- {a: 1, [b]: 2}', error: { msg: /complex keys/, line: 2, col: 10 } },
  { g: 'YAML', name: '重复键报错', fmt: 'yaml', text: 'a: 1\nb: 2\na: 3', error: { msg: /duplicate/i, line: 3 } },
  { g: 'YAML', name: '语法错误定位（未闭合的流式序列）', fmt: 'yaml', text: 'a: 1\nb: [1, 2\nc: 3', error: { line: 3 } },
  { g: 'YAML', name: '150 层嵌套可解析', fmt: 'yaml', text: '['.repeat(150) + '1' + ']'.repeat(150), probe: 'JSON.stringify(r.value).length === 301' },
  { g: 'YAML', name: '.inf / .nan 是 number', fmt: 'yaml', text: 'a: .inf\nb: -.inf\nc: .nan', value: { a: num('Infinity'), b: num('-Infinity'), c: num('NaN') } },
  { g: 'YAML', name: '__proto__ 键作为自有属性，不污染原型', fmt: 'yaml', text: '__proto__: {polluted: 1}\nb: 2', probe: 'Object.getPrototypeOf(r.value) === Object.prototype && Object.keys(r.value)[0] === "__proto__" && ({}).polluted === undefined' },
  { g: 'YAML', name: '多行文本解析为单个字符串时给出 warning', fmt: 'yaml', text: 'hello\nworld', value: 'hello world', warnings: ['yaml-scalar-root'] },
  { g: 'YAML', name: '普通文档没有 warning', fmt: 'yaml', text: 'server:\n  host: a\n  port: 80\nlist:\n  - 1\n  - two', value: { server: { host: 'a', port: 80 }, list: [1, 'two'] }, noWarnings: true, docCount: 1 },

  // ---- TOML ----
  { g: 'TOML', name: '超过 53 位的整数保留原文，安全整数仍是 number', fmt: 'toml', text: 'a = 12345678901234567890\nb = 42\nc = -9223372036854775808\nd = 9007199254740991', value: { a: bn('12345678901234567890'), b: 42, c: bn('-9223372036854775808'), d: 9007199254740991 } },
  {
    g: 'TOML', name: '四种日期类型的 kind 与 raw', fmt: 'toml',
    text: 'odt = 1979-05-27T07:32:00Z\nodt2 = 1979-05-27T00:32:00.999-07:00\nldt = 1979-05-27T07:32:00\nld = 1979-05-27\nlt = 07:32:00\nlt2 = 00:32:00.5',
    value: { odt: date('1979-05-27T07:32:00Z', 'datetime'), odt2: date('1979-05-27T00:32:00.999-07:00', 'datetime'), ldt: date('1979-05-27T07:32:00', 'datetime-local'), ld: date('1979-05-27', 'date'), lt: date('07:32:00', 'time'), lt2: date('00:32:00.500', 'time') }
  },
  { g: 'TOML', name: 'inf / nan', fmt: 'toml', text: 'a = inf\nb = -inf\nc = nan\nd = 1.5', value: { a: num('Infinity'), b: num('-Infinity'), c: num('NaN'), d: 1.5 } },
  { g: 'TOML', name: '表数组', fmt: 'toml', text: '[[products]]\nname = "Hammer"\nsku = 738594937\n\n[[products]]\n\n[[products]]\nname = "Nail"', value: { products: [{ name: 'Hammer', sku: 738594937 }, {}, { name: 'Nail' }] } },
  { g: 'TOML', name: '点分键与表头', fmt: 'toml', text: 'a.b.c = 1\nsite."google.com" = true\n[x.y]\nz = "w"', value: { a: { b: { c: 1 } }, site: { 'google.com': true }, x: { y: { z: 'w' } } } },
  { g: 'TOML', name: '内联表与数组', fmt: 'toml', text: 'p = { x = 1, y = "z", n = [1, 2, [3]] }', value: { p: { x: 1, y: 'z', n: [1, 2, [3]] } } },
  { g: 'TOML', name: '语法错误定位（1 基行列）', fmt: 'toml', text: 'a = 1\nb = = 2', error: { line: 2, col: 5 } },
  { g: 'TOML', name: '重复键报错', fmt: 'toml', text: 'a = 1\na = 2', error: { line: 2 } },

  // ---- XML ----
  { g: 'XML', name: '属性、文本与 #text', fmt: 'xml', text: '<a id="1" lang="zh">x</a>', value: { a: { '@id': '1', '@lang': 'zh', '#text': 'x' } } },
  { g: 'XML', name: '只有文本的元素得字符串', fmt: 'xml', text: '<a>hi</a>', value: { a: 'hi' } },
  {
    g: 'XML', name: '重复元素成数组、单个元素不成数组、空元素得空串（设计文档示例）', fmt: 'xml',
    text: '<book id="1" lang="zh">\n  <title>三体</title>\n  <author>刘慈欣</author>\n  <tag>科幻</tag>\n  <tag>长篇</tag>\n  <stock/>\n</book>',
    value: { book: { '@id': '1', '@lang': 'zh', title: '三体', author: '刘慈欣', tag: ['科幻', '长篇'], stock: '' } }, noWarnings: true
  },
  { g: 'XML', name: '<a/> 与 <a></a> 都得空串', fmt: 'xml', text: '<r><a/><b></b><c>  </c></r>', value: { r: { a: '', b: '', c: '' } } },
  { g: 'XML', name: '混合内容拼接进 #text 并产生 warning', fmt: 'xml', text: '<p>hello <b>x</b> world</p>', value: { p: { '#text': 'hello world', b: 'x' } }, warnings: ['xml-mixed'] },
  { g: 'XML', name: '不连续同名元素归并并产生 warning', fmt: 'xml', text: '<r><a>1</a><b>2</b><a>3</a></r>', value: { r: { a: ['1', '3'], b: '2' } }, warnings: ['xml-order'], probe: 'r.warnings[0].paths[0] === "$.r.a"' },
  { g: 'XML', name: '命名空间前缀原样保留，xmlns 当普通属性', fmt: 'xml', text: '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><m:x xmlns:m="urn:m">1</m:x></soap:Body></soap:Envelope>', value: { 'soap:Envelope': { '@xmlns:soap': 'http://schemas.xmlsoap.org/soap/envelope/', 'soap:Body': { 'm:x': { '@xmlns:m': 'urn:m', '#text': '1' } } } } },
  { g: 'XML', name: 'CDATA 并入文本', fmt: 'xml', text: '<a>x<![CDATA[<y> & ]]>z</a>', value: { a: 'x<y> & z' } },
  { g: 'XML', name: '注释 / 处理指令 / DOCTYPE 丢弃并 warning', fmt: 'xml', text: '<?xml version="1.0"?>\n<!DOCTYPE a>\n<!-- top -->\n<a><?pi data?><!-- in -->t</a>', value: { a: 't' }, warnings: ['xml-comment', 'xml-pi', 'xml-doctype'] },
  { g: 'XML', name: '实体解码', fmt: 'xml', text: '<a t="&quot;q&quot;">&lt;&amp;&gt;&#20013;&#x6587;</a>', value: { a: { '@t': '"q"', '#text': '<&>中文' } } },
  { g: 'XML', name: '__proto__ 元素名安全', fmt: 'xml', text: '<r><__proto__><polluted>1</polluted></__proto__></r>', probe: 'Object.keys(r.value.r)[0] === "__proto__" && Object.getPrototypeOf(r.value.r) === Object.prototype && r.value.r.__proto__.polluted === "1" && ({}).polluted === undefined' },
  { g: 'XML', name: '根元素名是 __proto__', fmt: 'xml', text: '<__proto__>1</__proto__>', probe: 'Object.keys(r.value)[0] === "__proto__" && Object.getPrototypeOf(r.value) === Object.prototype' },
  { g: 'XML', name: '类型推断默认关闭：值都是字符串', fmt: 'xml', text: '<r><a>007</a><b>12345678901234567890</b><c>true</c><d>1.5</d></r>', value: { r: { a: '007', b: '12345678901234567890', c: 'true', d: '1.5' } } },
  { g: 'XML', name: '类型推断开启：007 保持字符串、长数字成 BigNum', fmt: 'xml', opts: { inferTypes: true }, text: '<r x="2"><a>007</a><b>12345678901234567890</b><c>true</c><d>1.5</d><e>-0</e><f>1e3</f><g>.5</g></r>', value: { r: { '@x': 2, a: '007', b: bn('12345678901234567890'), c: true, d: 1.5, e: -0, f: 1000, g: '.5' } } },
  { g: 'XML', name: '语法错误定位（近似）', fmt: 'xml', text: '<a>\n  <b>1</c>\n</a>', error: { line: 2, approx: true } },
  { g: 'XML', name: '多个根元素报错', fmt: 'xml', text: '<a/><b/>', error: { line: 1 } },
  { g: 'XML', name: '5000 层嵌套（迭代实现不爆栈）', fmt: 'xml', text: '<a>'.repeat(5000) + 'x' + '</a>'.repeat(5000), probe: '(function () { var d = 0, x = r.value; while (x && typeof x === "object") { x = x.a; d++; } return d === 5000 && x === "x"; })()' }
];

const DETECT_CASES = [
  ['{"a": 1}', 'json'], ['[1, 2]', 'json'], ['  \n {"a":1}', 'json'],
  ['a: 1\nb: [1, 2]', 'yaml'], ['[server]\nhost = "x"', 'toml'], ['<a/>', 'xml'], ['\uFEFF  <?xml version="1.0"?><a/>', 'xml'],
  ['[package]\nname = "x"', 'toml'], ['[1]', 'json'], ['["a"]', 'json'], ['[[1]]', 'json'], ['[true]', 'json'], ['[null]', 'json'],
  ['[[a]]\nb = 1', 'toml'], ['[a.b-c]  # comment\nx = 1', 'toml'],
  ['name = "x"\nversion = "1"', 'toml'], ['url: http://x?a=b', 'yaml'], ['- a\n- b', 'yaml'],
  ['---\na: 1', 'yaml'], ['%YAML 1.2\n---\na: 1', 'yaml'], ['# comment\nkey: value', 'yaml'],
  ['123', 'json'], ['"abc"', 'json'], ['true', 'json'], ['null', 'json'], ['plain words', 'yaml'], ['', 'json'],
  ['{"a": 1, "b": [1, 2,]}', 'json']
];

(async () => {
  const port = await freePort();
  const srv = spawn(BIN, ['-listen', '127.0.0.1:' + port], { stdio: ['ignore', 'pipe', 'pipe'] });
  await waitPort(port);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0' });
    await page.evaluate(() => Promise.all(['yaml', 'toml'].map(id => window.JV.FORMATS[id].ensureLoaded())));
    // 页面内的执行器：把结果编码成可比较的普通 JSON
    await page.evaluate(() => {
      const JV = window.JV;
      function enc(v) {
        if (v instanceof JV.BigNum) return { $bn: v.raw };
        if (v instanceof JV.DateVal) return { $date: v.raw, kind: v.kind };
        if (typeof v === 'number' && !isFinite(v)) return { $num: String(v) };
        if (Array.isArray(v)) return v.map(enc);
        if (v && typeof v === 'object') {
          const o = {};
          for (const k of Object.keys(v)) Object.defineProperty(o, k, { value: enc(v[k]), enumerable: true, writable: true, configurable: true });
          return o;
        }
        return v;
      }
      window.__runParse = (c) => {
        let r;
        try {
          r = JV.FORMATS[c.fmt].parse(c.text, c.opts);
        } catch (e) {
          return { ok: false, isFE: e instanceof JV.FormatError, format: e.format, message: String(e.message), offset: e.offset, approx: !!e.approx };
        }
        let probe = null;
        if (c.probe) { try { probe = !!new Function('r', 'return (' + c.probe + ');')(r); } catch (e) { probe = 'error: ' + e.message; } }
        return { ok: true, value: !c.wantValue ? null : r.value === undefined ? '<undefined>' : enc(r.value), warnings: r.warnings.map(w => w.code), docCount: r.docCount, probe };
      };
    });

    let group = '';
    for (const c of PARSE_CASES) {
      if (c.g !== group) { group = c.g; console.log(group + ' 解析'); }
      const r = await page.evaluate(c2 => window.__runParse(c2), { fmt: c.fmt, text: c.text, opts: c.opts, probe: c.probe, wantValue: c.value !== undefined });
      const problems = [];
      if (c.error) {
        if (r.ok) problems.push('期望报错，实际解析成功: ' + canon(r.value).slice(0, 120));
        else {
          if (!r.isFE) problems.push('不是 FormatError');
          if (r.format !== c.fmt) problems.push('format=' + r.format);
          if (c.error.msg && !c.error.msg.test(r.message)) problems.push('message=' + r.message);
          if (c.error.line !== undefined || c.error.col !== undefined) {
            if (r.offset < 0) problems.push('没有位置');
            else {
              const lc = lineCol(c.text, r.offset);
              if (c.error.line !== undefined && lc.line !== c.error.line) problems.push('line=' + lc.line);
              if (c.error.col !== undefined && lc.col !== c.error.col) problems.push('col=' + lc.col);
            }
          }
          if (c.error.approx !== undefined && r.approx !== c.error.approx) problems.push('approx=' + r.approx);
        }
      } else if (!r.ok) {
        problems.push('解析失败: ' + r.message);
      } else {
        if (c.value !== undefined && canon(r.value) !== canon(c.value)) problems.push('值=' + canon(r.value).slice(0, 200));
        for (const w of c.warnings || []) if (!r.warnings.includes(w)) problems.push('缺少 warning ' + w + '，实际 ' + r.warnings.join(','));
        if (c.noWarnings && r.warnings.length) problems.push('不应有 warning: ' + r.warnings.join(','));
        if (c.docCount !== undefined && r.docCount !== c.docCount) problems.push('docCount=' + r.docCount);
        if (c.probe && r.probe !== true) problems.push('probe=' + r.probe);
      }
      check(c.name, problems.length === 0, problems.join('; '));
    }

    console.log('格式化（解析后重排 / DOM 重排）');
    const fmtRes = await page.evaluate(() => {
      const F = window.JV.FORMATS, out = {};
      out.yaml = F.yaml.format('# c\nb:   [1, 2]\na: {x: 12345678901234567890, s: "yes", d: "2001-12-14"}\n');
      out.yamlMulti = F.yaml.format('a: 1\n---\nb: 2\n');
      out.toml = F.toml.format('# c\nd = 1979-05-27\nt = 07:32:00\nbig = 12345678901234567890\n[s]\nx = 1\n');
      out.xml = F.xml.format('<?xml version="1.0" encoding="UTF-8"?>\n<!-- top --><r a="1&amp;2"><b>t</b><!-- c --><![CDATA[x<y]]><?pi d?><e/>\n<m>hi <i>x</i> there</m></r>');
      out.xmlMin = F.xml.minify('<r>\n  <a> keep  me </a>\n  <!-- c -->\n  <b/>\n</r>');
      return out;
    });
    check('YAML 格式化：重排、大数原文、长得像布尔 / 日期的字符串加引号', fmtRes.yaml === "b:\n  - 1\n  - 2\na:\n  x: 12345678901234567890\n  s: 'yes'\n  d: '2001-12-14'", JSON.stringify(fmtRes.yaml));
    check('YAML 格式化：多文档用 --- 分隔', fmtRes.yamlMulti === '---\na: 1\n---\nb: 2', JSON.stringify(fmtRes.yamlMulti));
    check('TOML 格式化：日期不带引号、大数原文', /^d = 1979-05-27$/m.test(fmtRes.toml) && /^t = 07:32:00(\.000)?$/m.test(fmtRes.toml) && /^big = 12345678901234567890$/m.test(fmtRes.toml) && /^\[s\]$/m.test(fmtRes.toml), JSON.stringify(fmtRes.toml));
    check('XML 格式化：缩进 4、保留声明 / 注释 / CDATA / 处理指令', fmtRes.xml === '<?xml version="1.0" encoding="UTF-8"?>\n<!-- top -->\n<r a="1&amp;2">\n    <b>t</b>\n    <!-- c -->\n    <![CDATA[x<y]]>\n    <?pi d?>\n    <e/>\n    <m>\n        hi\n        <i>x</i>\n        there\n    </m>\n</r>', JSON.stringify(fmtRes.xml));
    check('XML 删除空格：只去掉元素间的纯空白', fmtRes.xmlMin === '<r><a> keep  me </a><!-- c --><b/></r>', JSON.stringify(fmtRes.xmlMin));

    console.log('识别');
    const det = await page.evaluate(cases => cases.map(c => window.JV.detect(c[0])), DETECT_CASES);
    DETECT_CASES.forEach((c, i) => check('detect ' + JSON.stringify(c[0]).slice(0, 40) + ' → ' + c[1], det[i] === c[1], det[i]));
    // 每个适配器 stringify 的输出能被识别回该格式（避开 {} 这类退化值：YAML 写成 '{}'、TOML 写成空文本）
    const back = await page.evaluate(() => {
      const F = window.JV.FORMATS, JV = window.JV, bad = [];
      const values = [
        { name: 'x', n: 1, list: [1, 2], sub: { a: true } },
        { sub: { a: 1 } },
        [{ a: 1 }, 2, 'three'],
        { arr: [{ x: 1 }, { x: 2 }], big: JV.parseJSON('{"b":12345678901234567890}').b, s: 'yes', d: 'x: y' },
        { title: '中文', nested: { deep: { deeper: [1, [2, 3]] } } }
      ];
      values.forEach((v, i) => {
        for (const id of JV.ORDER) {
          const got = JV.detect(F[id].stringify(v).text);
          if (got !== id) bad.push('#' + i + ' ' + id + '→' + got);
        }
      });
      if (JV.detect(F.xml.format('<r><a>1</a></r>')) !== 'xml') bad.push('xml.format');
      return bad;
    });
    check('各适配器 stringify 的输出能被识别回该格式（5 组值 × 4 种格式）', back.length === 0, back.join(', '));

    // ---------- 互转（经 window.jsonviewer.convert，与界面走同一条路径） ----------
    await page.evaluate(() => {
      const JV = window.JV;
      // 与键序无关的规范化编码，用于比较「结构相等」
      function enc(v) {
        if (v instanceof JV.BigNum) return { $bn: v.raw };
        if (v instanceof JV.DateVal) return { $date: v.raw };
        if (typeof v === 'number' && !isFinite(v)) return { $num: String(v) };
        if (Array.isArray(v)) return v.map(enc);
        if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[' ' + k] = enc(v[k]); return o; }
        return v;
      }
      window.__sorted = (fmt, text, opts) => JSON.stringify(enc(JV.FORMATS[fmt].parse(text, opts).value));
      window.__conv = (text, from, to, opts) => window.jsonviewer.convert(text, from, to, opts).then(
        r => ({ ok: true, text: r.text, losses: r.losses, warnings: r.warnings.map(w => w.code), inherent: r.inherent, lossText: r.losses.map(l => JV.lossText(l)) }),
        e => ({ ok: false, isFE: e instanceof JV.FormatError, message: String(e.message) }));
    });
    const conv = (text, from, to, opts) => page.evaluate((a, b, c, d) => window.__conv(a, b, c, d), text, from, to, opts || {});
    const sorted = (fmt, text, opts) => page.evaluate((a, b, c) => window.__sorted(a, b, c), fmt, text, opts || {});
    const codes = r => (r.losses || []).map(l => l.code + ':' + l.count).join(',');
    const loss = (r, code) => (r.losses || []).find(l => l.code === code);

    console.log('往返');
    const RT_JSON = '{"big":12345678901234567890,"dec":3.14159265358979323846,"neg":-98765432109876543210,"u":"中文 ☃ 😀 \\u00e9","e":{},"a":[],' +
      '"yes":"yes","no":"no","num":"123","float":"1.5","colon":"x: y","hash":"# x","tilde":"~","nul":null,"t":true,"f":-1.5e-7,' +
      '"date":"2001-12-14","ml":"line1\\nline2\\n","lead":"  sp ","quote":"\'\\"","list":[1,"two",[3,{}]],"deep":{"x":{"y":[null]}}}';
    const canonJson = (await conv(RT_JSON, 'json', 'json')).text;
    let y = await conv(RT_JSON, 'json', 'yaml');
    let yb = y.ok ? await conv(y.text, 'yaml', 'json') : y;
    check('JSON → YAML → JSON 完全相等（大数、Unicode、空容器、"yes"、"123"、"x: y"、多行字符串）', y.ok && yb.ok && yb.text === canonJson && y.losses.length === 0, yb.ok ? yb.text.slice(0, 200) : yb.message);

    const RT_TOML = '{"title":"x","n":42,"f":1.5,"big":12345678901234567890,"b":false,"arr":[1,2,3],"mixed":[1,"a",{"z":1}],' +
      '"sub":{"k":"v","deep":{"x":[{"a":1},{"b":2}]}},"aot":[{"name":"a"},{"name":"b"}],"e":{},"ea":[],"u":"中文","key with space":1}';
    let t = await conv(RT_TOML, 'json', 'toml');
    let tb = t.ok ? await conv(t.text, 'toml', 'json') : t;
    check('JSON → TOML → JSON（不含 null 的对象）结构相等', t.ok && tb.ok && (await sorted('json', tb.text)) === (await sorted('json', RT_TOML)) && t.losses.length === 0, tb.ok ? tb.text.slice(0, 200) : tb.message);

    const RT_DATES = 'odt = 1979-05-27T07:32:00Z\nldt = 1979-05-27T07:32:00\nd = 1979-05-27\nlt = 07:32:00\nn = 1\n';
    y = await conv(RT_DATES, 'toml', 'yaml');
    check('TOML → YAML：日期时间输出为不带引号的标量', y.ok && /^odt: 1979-05-27T07:32:00Z$/m.test(y.text) && /^ldt: 1979-05-27T07:32:00$/m.test(y.text) && /^d: 1979-05-27$/m.test(y.text) && /^lt: 07:32:00$/m.test(y.text), JSON.stringify(y.text));
    tb = await conv(y.text, 'yaml', 'toml');
    // YAML 1.2 core 把日期读成字符串（§11.3），所以 YAML → TOML 这一步日期带引号；值本身不变
    check('TOML → YAML → TOML：值不变（YAML 1.2 下日期读回为字符串，回到 TOML 时带引号）', tb.ok && /^d = "1979-05-27"$/m.test(tb.text) && /^odt = "1979-05-27T07:32:00Z"$/m.test(tb.text) && /^n = 1$/m.test(tb.text), JSON.stringify(tb.text));
    t = await conv(RT_DATES, 'toml', 'toml');
    // smol-toml 输出时间部分会补 .000（§15.1 列为 TOML 规范化的表示层变化）
    check('TOML → TOML：日期保持不带引号', t.ok && /^d = 1979-05-27$/m.test(t.text) && /^odt = 1979-05-27T07:32:00(\.000)?Z$/m.test(t.text) && /^lt = 07:32:00(\.000)?$/m.test(t.text), JSON.stringify(t.text));

    const RT_XML = '<book id="1" lang="zh"><title>三体</title><author>刘慈欣</author><tag>科幻</tag><tag>长篇</tag><stock/>' +
      '<price cur="CNY">23.5</price><soap:x xmlns:soap="urn:s"><soap:y>1</soap:y></soap:x><esc a="&lt;&amp;&quot;">x &lt; y &amp; z</esc></book>';
    let j = await conv(RT_XML, 'xml', 'json');
    let xb = j.ok ? await conv(j.text, 'json', 'xml') : j;
    check('XML → JSON → XML 结构相等（无注释、无混合内容），且 JSON → XML 无实际损失', j.ok && xb.ok && (await sorted('xml', xb.text)) === (await sorted('xml', RT_XML)) && xb.losses.length === 0, xb.ok ? codes(xb) + ' ' + xb.text.slice(0, 300) : xb.message);

    const RT_OBJ = '{"r":{"@id":"1","#text":"t","a":"x","b":["1","2"],"c":{"@k":"v"},"d":"","e":{"f":{"g":"深"}}}}';
    let x = await conv(RT_OBJ, 'json', 'xml');
    j = x.ok ? await conv(x.text, 'xml', 'json') : x;
    check('对象 → XML → 对象（单键根）相等', x.ok && j.ok && JSON.stringify(JSON.parse(j.text)) === JSON.stringify(JSON.parse(RT_OBJ)), j.ok ? j.text.replace(/\s+/g, ' ').slice(0, 200) : j.message);

    const IDEM = [
      ['json', '{"a":[1,{"b":null}],"big":12345678901234567890,"s":"中文"}'],
      ['yaml', '# c\na: &x [1, 2]\nb: *x\nc: {d: "yes", e: 2001-12-14}\n'],
      ['yaml', 'a: 1\n---\nb: 2\n'],
      ['toml', '# c\nt = 1979-05-27T07:32:00Z\nbig = 12345678901234567890\n[s]\nx = 1.0\n[[p]]\nn = 1\n'],
      ['xml', '<?xml version="1.0"?><!-- c --><r a="1"><b>t</b><b>u</b><c/><d x="&lt;"/></r>']
    ];
    for (const [f, text] of IDEM) {
      const once = await conv(text, f, f), twice = once.ok ? await conv(once.text, f, f) : once;
      check(f.toUpperCase() + ' → ' + f.toUpperCase() + ' 规范化幂等：' + JSON.stringify(text).slice(0, 36), once.ok && twice.ok && once.text === twice.text, twice.ok ? JSON.stringify(twice.text).slice(0, 160) : twice.message);
    }
    const multi = await conv('a: 1\n---\nb: 2\n', 'yaml', 'yaml');
    check('多文档 YAML → YAML 用 --- 分隔', multi.ok && multi.text === '---\na: 1\n---\nb: 2\n', JSON.stringify(multi.text));
    const multiJ = await conv('a: 1\n---\nb: 2\n', 'yaml', 'json');
    check('多文档 YAML → JSON 得数组，固有损失注明合并', multiJ.ok && JSON.stringify(JSON.parse(multiJ.text)) === '[{"a":1},{"b":2}]' && multiJ.inherent.some(s => /多个文档/.test(s)), JSON.stringify(multiJ.inherent));

    console.log('损失：→ TOML');
    t = await conv('{"a":null,"b":{"c":null,"d":1},"e":2}', 'json', 'toml');
    check('值为 null 的键被丢弃并计数、给出路径', t.ok && t.text === 'e = 2\n\n[b]\nd = 1\n' && loss(t, 'toml-null-key') && loss(t, 'toml-null-key').count === 2 && loss(t, 'toml-null-key').paths.join() === '$.a,$.b.c', JSON.stringify(t.text) + ' ' + JSON.stringify(t.losses));
    t = await conv('{"arr":[1,null,3,null],"t":[{"x":null,"y":1}]}', 'json', 'toml');
    let li = loss(t, 'toml-null-item');
    check('数组内的 null 被丢弃，文案注明下标前移', t.ok && /^arr = \[ 1, 3 \]$/m.test(t.text) && li && li.count === 2 && li.paths.join() === '$.arr[1],$.arr[3]' && t.lossText.some(s => /下标前移/.test(s)) && loss(t, 'toml-null-key').paths[0] === '$.t[0].x', JSON.stringify(t.text) + ' ' + JSON.stringify(t.losses));
    t = await conv('[1,null,{"a":1}]', 'json', 'toml');
    check('顶层数组包装到 items（损失路径按源数据）', t.ok && t.text === 'items = [ 1, { a = 1 } ]\n' && loss(t, 'toml-wrap-array') && loss(t, 'toml-null-item').paths[0] === '$[1]' && t.lossText.some(s => /items/.test(s)), JSON.stringify(t.text) + ' ' + codes(t));
    t = await conv('"abc"', 'json', 'toml');
    let t2 = await conv('12345678901234567890', 'json', 'toml');
    check('顶层标量包装到 value（含大整数）', t.ok && t.text === 'value = "abc"\n' && loss(t, 'toml-wrap-scalar') && t2.ok && t2.text === 'value = 12345678901234567890\n', JSON.stringify([t.text, t2.text]));
    t = await conv('null', 'json', 'toml');
    check('顶层 null：输出空文档并记损失', t.ok && t.text === '' && loss(t, 'toml-wrap-scalar') && loss(t, 'toml-null-key'), JSON.stringify(t));
    t = await conv('{"pi":3.14159265358979323846,"big":-12345678901234567890}', 'json', 'toml');
    check('非整数 BigNum 转为浮点并记精度损失，整数 BigNum 原文输出', t.ok && /^pi = 3\.14159265358979\d*$/m.test(t.text) && /^big = -12345678901234567890$/m.test(t.text) && loss(t, 'toml-bignum') && loss(t, 'toml-bignum').count === 1, JSON.stringify(t.text) + ' ' + codes(t));
    const nomut = await page.evaluate(() => {
      const JV = window.JV, v = JV.parseJSON('{"a":null,"b":[null,{"c":null,"d":12345678901234567890}],"keep":{"x":[1,2]}}');
      const before = JV.stringifyJSON(v), keep = v.keep;
      JV.convert(v, 'toml', {}); JV.convert(v, 'xml', {}); JV.convert(v, 'json', {}); JV.convert(v, 'yaml', {});
      return JV.stringifyJSON(v) === before && v.keep === keep && v.b[1].d instanceof JV.BigNum;
    });
    check('转换不修改传入的模型', nomut);

    console.log('损失：→ XML');
    const NAMES = [['first name', 'first_name'], ['1abc', '_1abc'], ['', '_'], ['a:b', 'a_b'], ['a:b:c', 'a_b_c'], [':a', '_a'], ['-x', '_-x'], ['.x', '_.x'],
      ['a/b', 'a_b'], ['😀', '_'], ['a😀b', 'a_b'], ['#text2', '_text2'], ['x-y.z_1', 'x-y.z_1'], ['x·y', 'x·y'], ['中文键', '中文键'], ['Ünïcödé', 'Ünïcödé']];
    for (const [k, want] of NAMES) {
      const src = JSON.stringify({ r: { [k]: 'v' } });
      x = await conv(src, 'json', 'xml');
      const renamed = loss(x, 'xml-name');
      const ok = x.ok && x.text.includes('<' + want + '>v</' + want + '>') && (k === want ? !renamed : renamed && renamed.count === 1);
      check('键名 ' + JSON.stringify(k) + ' → ' + want + (k === want ? '（合法，原样保留）' : '（改写并记损失）'), ok, x.ok ? x.text.split('\n')[2] + ' ' + codes(x) : x.message);
    }
    x = await conv('{"r":{"first name":"a"}}', 'json', 'xml');
    check('键名改写的损失给出示例', x.ok && x.lossText[0] === '1 处键名不是合法的 XML 名称，已改写（例：first name → first_name）', x.lossText.join(' | '));
    x = await conv('{"r":{"@xmlns:s":"urn:s","s:a":"1","q:b":"2","@s:attr":"3","@q:attr":"4"}}', 'json', 'xml');
    check('冒号：前缀已声明时保留，未声明时改写（否则读不回）', x.ok && x.text.includes('<s:a>1</s:a>') && x.text.includes('<q_b>2</q_b>') && x.text.includes(' s:attr="3"') && x.text.includes(' q_attr="4"') && loss(x, 'xml-name').count === 2, x.ok ? x.text : x.message);
    x = await conv('{"根":{"名字":"值","列表":["甲","乙"]}}', 'json', 'xml');
    check('中文键名原样保留，单键对象作根', x.ok && x.text === '<?xml version="1.0" encoding="UTF-8"?>\n<根>\n    <名字>值</名字>\n    <列表>甲</列表>\n    <列表>乙</列表>\n</根>\n' && x.losses.length === 0, JSON.stringify(x.text));
    x = await conv('{"r":{"@id":"1","@n":2,"@b":true,"@z":null,"@big":12345678901234567890}}', 'json', 'xml');
    check('@ 键成属性（数字、布尔、null、大数都写成文本）', x.ok && x.text.includes('<r id="1" n="2" b="true" z="" big="12345678901234567890"/>') && x.losses.length === 0, x.ok ? x.text : x.message);
    x = await conv('{"r":{"@o":{"k":"v"},"@l":[1]}}', 'json', 'xml');
    check('@ 键的值为容器：按普通元素输出并记损失', x.ok && x.text.includes('<_o>') && x.text.includes('<_l>1</_l>') && loss(x, 'xml-attr-container') && loss(x, 'xml-attr-container').count === 2, x.ok ? codes(x) + ' ' + x.text : x.message);
    x = await conv('{"r":{"e":[],"a":"1","in":[[],[1]]}}', 'json', 'xml');
    check('空数组不输出并记损失', x.ok && !/<e[ />]/.test(x.text) && loss(x, 'xml-empty-array') && loss(x, 'xml-empty-array').paths.join() === '$.r.e,$.r.in[0]', x.ok ? codes(x) + ' ' + JSON.stringify(loss(x, 'xml-empty-array')) : x.message);
    x = await conv('{"r":{"m":[[1,2],[3,[4,5]]]}}', 'json', 'xml');
    check('数组以父键名重复，嵌套数组用 <item>', x.ok && x.text === '<?xml version="1.0" encoding="UTF-8"?>\n<r>\n    <m>\n        <item>1</item>\n        <item>2</item>\n    </m>\n    <m>\n        <item>3</item>\n        <item>\n            <item>4</item>\n            <item>5</item>\n        </item>\n    </m>\n</r>\n', JSON.stringify(x.text));
    x = await conv('[1,{"a":2}]', 'json', 'xml', { indent: 2 });
    check('顶层数组：<root><item>…</item></root>，缩进 2', x.ok && x.text === '<?xml version="1.0" encoding="UTF-8"?>\n<root>\n  <item>1</item>\n  <item>\n    <a>2</a>\n  </item>\n</root>\n' && loss(x, 'xml-root'), JSON.stringify(x.text));
    x = await conv('{"r":"a\\u0001b\\u001fc\\ud800d\\ufffe","s":{"@a":"x\\u0000"}}', 'json', 'xml');
    check('XML 不允许的控制字符替换为 U+FFFD 并记损失', x.ok && x.text.includes('<r>a�b�c�d�</r>') && x.text.includes('a="x�"') && loss(x, 'xml-control-char') && loss(x, 'xml-control-char').count === 5, x.ok ? codes(x) : x.message);
    x = await conv('{"a":1,"b":2}', 'json', 'xml');
    let x2 = await conv('{"a":{"b":1}}', 'json', 'xml');
    let x3 = await conv('{"a":[1,2]}', 'json', 'xml', { xmlRoot: 'data' });
    let x4 = await conv('{"first name":{"b":1}}', 'json', 'xml');
    let x5 = await conv('"hi"', 'json', 'xml');
    check('需要包 <root>：多键对象、单键但值为数组（根名可选）、单键但键名非法、顶层标量', x.ok && x.text.includes('<root>\n    <a>1</a>') && loss(x, 'xml-root') && x3.text.includes('<data>\n    <a>1</a>\n    <a>2</a>\n</data>') && loss(x3, 'xml-root').sample === 'data' &&
      x4.text.includes('<root>\n    <first_name>') && x5.text.includes('<root>hi</root>'), [x, x3, x4, x5].map(r => JSON.stringify(r.text)).join(' '));
    check('不需要包 <root>：单键对象、值不是数组、键名合法', x2.ok && x2.text === '<?xml version="1.0" encoding="UTF-8"?>\n<a>\n    <b>1</b>\n</a>\n' && x2.losses.length === 0, JSON.stringify(x2.text));
    x = await conv('{"r":{"@q":"a\\"<&>\\n\\t","#text":"x<&>y\\r","n":null,"s":""}}', 'json', 'xml');
    check('转义：文本 & < >，属性 & < " 与换行制表；null → <a/>，"" → <a></a>', x.ok && x.text.includes('<r q="a&quot;&lt;&amp;>&#10;&#9;">') && x.text.includes('x&lt;&amp;&gt;y&#13;') && x.text.includes('<n/>') && x.text.includes('<s></s>'), x.ok ? x.text : x.message);
    const parseBack = await page.evaluate(() => {
      const JV = window.JV, bad = [];
      const vals = ['{"a b":{"@c d":"1","@c_d":"2","1x":[[]],"x:y:z":null}}', '{"@x":1}', '{"#text":"t"}', '[[[]]]', '{"s:a":{"@xmlns:s":"u","s:b":"1"}}', '{"xmlns:a":"1"}', '{"r":{"@xmlns":"urn:d","@xml:lang":"zh"}}'];
      for (const s of vals) {
        try { JV.FORMATS.xml.parse(JV.convert(JV.parseJSON(s), 'xml', {}).text); } catch (e) { bad.push(s + ' → ' + e.message); }
      }
      return bad;
    });
    check('各种边界键名生成的 XML 都能被解析回来（含属性清洗后重名、声明自身的前缀）', parseBack.length === 0, parseBack.join(' | '));

    console.log('损失：→ JSON');
    j = await conv('a: .inf\nb: [.nan, -.inf]\nc: 1', 'yaml', 'json');
    check('inf / nan 写成 null 并计损失', j.ok && JSON.stringify(JSON.parse(j.text)) === '{"a":null,"b":[null,null],"c":1}' && loss(j, 'json-nonfinite') && loss(j, 'json-nonfinite').count === 3 && loss(j, 'json-nonfinite').paths.join() === '$.a,$.b[0],$.b[1]', j.ok ? codes(j) : j.message);
    j = await conv('d = 1979-05-27\nt = 1979-05-27T07:32:00Z\n', 'toml', 'json');
    check('TOML 日期写成字符串并记损失', j.ok && JSON.stringify(JSON.parse(j.text)) === '{"d":"1979-05-27","t":"1979-05-27T07:32:00Z"}' && loss(j, 'json-date') && loss(j, 'json-date').count === 2, j.ok ? codes(j) : j.message);
    j = await conv('{"a":[1,null,{"b":12345678901234567890}]}', 'json', 'json', { indent: 2 });
    check('JSON → JSON：无损、无固有损失，缩进 2', j.ok && j.losses.length === 0 && j.inherent.length === 0 && j.text === '{\n  "a": [\n    1,\n    null,\n    {\n      "b": 12345678901234567890\n    }\n  ]\n}', JSON.stringify(j.text));
    j = await conv('<r><!-- c --><a>1</a><b>2</b><a>3</a></r>', 'xml', 'json');
    check('XML 源的解析 warnings（注释、不连续同名元素）随结果返回', j.ok && j.warnings.includes('xml-comment') && j.warnings.includes('xml-order') && j.inherent.some(s => /推断类型/.test(s)), j.ok ? j.warnings.join() : j.message);
    j = await conv('<r><a>007</a><b>42</b></r>', 'xml', 'json', { inferTypes: true });
    check('XML 推断类型选项传到解析', j.ok && JSON.stringify(JSON.parse(j.text)) === '{"r":{"a":"007","b":42}}' && !j.inherent.some(s => /推断类型/.test(s)), j.ok ? j.text : j.message);
    const bad = await conv('{"a":', 'json', 'yaml');
    check('源解析失败时 convert reject FormatError', !bad.ok && bad.isFE, JSON.stringify(bad));

    check('无页面错误', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    srv.kill('SIGTERM');
  }
  console.log(failures ? '\n' + total + ' 项中失败 ' + failures + ' 项' : '\n全部通过（' + total + ' 项）');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
