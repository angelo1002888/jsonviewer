/*
 * 端到端测试：启动已编译的 ./jsonviewer，用本机 Chrome（puppeteer-core）跑功能、多格式查看（YAML / TOML / XML）与大 JSON 性能检查。
 * 用法：make build && npm install && npm run test:e2e
 * 环境变量：CHROME=/path/to/chrome（默认 /usr/bin/google-chrome）、BIG=200000（大 JSON 记录数，0 跳过性能测试）
 * 另起一个启用登录验证（auth = true）的实例，在独立的 BrowserContext 中测试初始设置、登录、用户菜单与用户管理。
 * 登录实例监听 0.0.0.0，并通过本机局域网 IPv4 访问（非安全上下文：无 Sec-Fetch-Site、Origin 可能为 null），没有则回退 127.0.0.1。
 */
const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const BIG = process.env.BIG === undefined ? 200000 : +process.env.BIG;
const BIN = path.join(__dirname, '..', 'jsonviewer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail !== undefined ? '  (' + detail + ')' : ''));
  if (!ok) failures++;
}
function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
}
// 本机第一个非回环 IPv4 地址，没有则回退 127.0.0.1
function lanIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}
// 等待服务开始监听（最多 5 秒）
async function waitPort(port) {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise(res => { const c = net.connect(port, '127.0.0.1', () => { c.end(); res(true); }); c.on('error', () => res(false)); });
    if (ok) return;
    await sleep(50);
  }
  throw new Error('服务未在 5 秒内监听端口 ' + port);
}

// 预期内的 4xx（登录失败 401、越权 403、限速 429、表单错误 400）会让 Chrome 打印
// "Failed to load resource" 控制台错误，这类不算页面错误。
const EXPECTED_HTTP_ERR = /^Failed to load resource: the server responded with a status of (400|401|403|429)\b/;

// 填写并提交表单，等待跳转完成，返回导航响应
async function submitForm(page, sel, values) {
  await page.$eval(sel, (f, v) => { for (const k in v) f.elements[k].value = v[k]; }, values);
  const [res] = await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.$eval(sel, f => f.requestSubmit())]);
  return res;
}

// 启用登录验证的第二个实例
async function authSuite(browser) {
  console.log('登录验证测试');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonviewer-e2e-'));
  const port = await freePort();
  const conf = path.join(tmp, 'jsonviewer.conf');
  fs.writeFileSync(conf, 'auth = true\nusers_file = ' + path.join(tmp, 'users.json') + '\nlisten = 0.0.0.0:' + port + '\n');
  const srv = spawn(BIN, ['-c', conf], { stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', d => process.env.VERBOSE && process.stderr.write(d));
  let ctx;
  try {
    await waitPort(port);
    ctx = await browser.createBrowserContext();   // 独立 Cookie / sessionStorage
    const page = await ctx.newPage();
    await page.setViewport({ width: 1400, height: 800 });
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    // 纯文本 403 页没有 <link rel=icon>，Chrome 会自动请求 /favicon.ico（404）；已移除的 /account 预期 404，同样不算
    page.on('console', m => {
      if (m.type() !== 'error' || EXPECTED_HTTP_ERR.test(m.text()) || /\/(favicon\.ico|account)$/.test((m.location() || {}).url || '')) return;
      errors.push('console: ' + m.text());
    });
    const base = 'http://' + lanIPv4() + ':' + port;
    console.log('  登录实例访问地址: ' + base);
    const where = () => new URL(page.url()).pathname;
    const menuInfo = async () => {
      await page.waitForSelector('#userMenu:not([hidden])', { timeout: 3000 });
      await page.click('#userBtn');
      const info = await page.evaluate(() => ({
        name: document.getElementById('userName').textContent,
        admin: document.getElementById('menuAdmin').offsetParent !== null
      }));
      await page.click('#userBtn');
      return info;
    };

    // 1. 未登录：进入 /setup；app.js 受保护，样式公开
    await page.goto(base + '/', { waitUntil: 'networkidle0' });
    check('未登录访问 / 跳转到 /setup', where() === '/setup', where());
    const st = await page.evaluate(async () => [(await fetch('/js/app.js', { redirect: 'manual' })).status, (await fetch('/css/style.css')).status]);
    check('未登录时 app.js 不可访问、style.css 200', st[0] !== 200 && st[1] === 200, st.join(','));

    // 2. 初始设置管理员
    check('/setup 用户名默认 admin', (await page.$eval('input[name=username]', e => e.value)) === 'admin');
    await submitForm(page, 'form', { password: 'adminpass1', confirm: 'adminpass1' });
    check('设置管理员后进入主页', where() === '/', where());
    let m = await menuInfo();
    check('用户菜单显示 admin，含"用户管理"', m.name === 'admin' && m.admin, JSON.stringify(m));

    // 9（auth 实例部分）. 登录后 /api/me 返回用户信息
    const me = await page.evaluate(() => fetch('api/me').then(r => r.json()));
    check('/api/me 返回登录用户', me.auth === true && me.user === 'admin' && me.admin === true, JSON.stringify(me));

    // 静态文件协商缓存：带上次的弱 ETag 作 If-None-Match 得 304
    const etag = await page.evaluate(async () => {
      const r1 = await fetch('/css/style.css', { cache: 'no-store' });
      const tag = r1.headers.get('ETag');
      const r2 = await fetch('/css/style.css', { headers: { 'If-None-Match': tag } });
      return [r1.status, tag, r1.headers.get('Cache-Control'), r2.status];
    });
    check('style.css 带弱 ETag、no-cache，If-None-Match 得 304', etag[0] === 200 && /^W\/"[0-9a-f]{16}"$/.test(etag[1]) && etag[2] === 'no-cache' && etag[3] === 304, etag.join(' '));

    // 多格式（§18.2 第 14 条）：登录后粘贴 YAML，受保护路径下的 vendor 包能懒加载
    await page.evaluate(() => window.jsonviewer.setText('auth:\n  yaml: true\n'));
    await page.evaluate(() => window.jsonviewer.whenIdle());
    const ay = await page.evaluate(() => [...document.querySelectorAll('#treeLayer .tn')].map(e => e.textContent));
    check('登录后粘贴 YAML 能懒加载解析器', JSON.stringify(ay) === '["YAML","auth"]', JSON.stringify(ay));
    // 左栏标题行（标题 + 格式下拉「自动 · YAML」）与中栏标题行（视图 + 标签 + 用户菜单）在 1400 / 1366 宽度下不换行、不重叠
    const headerLayout = () => page.evaluate(() => ['#leftPanel', '#treePanel'].map(sel => {
      const h = document.querySelector(sel + ' > .panel-header'), hr = h.getBoundingClientRect();
      const kids = [...h.children].filter(e => e.offsetParent !== null).map(e => e.getBoundingClientRect());
      let ok = h.scrollWidth <= h.clientWidth && kids.length >= 2;
      for (let i = 0; i < kids.length; i++) {
        if (kids[i].top < hr.top - 1 || kids[i].bottom > hr.bottom + 1 || kids[i].height > hr.height + 1) ok = false;   // 单行且在标题行内（行高 30px 的文字在 29px 内容区上下各溢出 0.5px，不算）
        if (i && kids[i].left < kids[i - 1].right) ok = false;                                         // 不重叠
      }
      return ok ? 'ok' : sel + ' ' + JSON.stringify(kids.map(r => [Math.round(r.left), Math.round(r.right), Math.round(r.height)]));
    }).join(','));
    await page.click('#tabConvert'); await page.evaluate(() => window.jsonviewer.whenIdle());
    const hl1400 = await headerLayout();
    await page.setViewport({ width: 1366, height: 768 });
    const hl1366 = await headerLayout();
    await page.setViewport({ width: 1400, height: 800 });
    await page.click('#tabTree');
    check('1400 / 1366 宽度下左栏与中栏标题行（含用户菜单）不换行、不重叠', hl1400 === 'ok,ok' && hl1366 === 'ok,ok', hl1400 + ' | ' + hl1366);
    await page.evaluate(() => window.jsonviewer.setText(''));

    // 3. 已设置后 /setup 不再可用
    await page.goto(base + '/setup', { waitUntil: 'networkidle0' });
    check('再次访问 /setup 被重定向', where() !== '/setup', where());

    // 4. 修改密码（查看器内弹窗）；独立的 /account 页面已移除
    let msg;
    let res = await page.goto(base + '/account', { waitUntil: 'networkidle0' });
    check('GET /account 已移除（非 200）', res.status() !== 200, res.status());
    await page.goto(base + '/', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#userMenu:not([hidden])', { timeout: 3000 });
    await page.click('#userBtn');
    await page.click('#menuPassword');
    await page.waitForSelector('#pwdMask:not([hidden])', { timeout: 3000 });
    const pwdOpen = await page.evaluate(() => [document.getElementById('userDrop').hidden, document.activeElement && document.activeElement.id, document.getElementById('pwdTitle').textContent]);
    check('点"修改密码"打开弹窗并聚焦当前密码框', pwdOpen[0] === true && pwdOpen[1] === 'pwdCurrent' && pwdOpen[2] === '修改密码', pwdOpen.join(','));
    const fillPwd = (cur, pw, cf) => page.evaluate((a, b, c) => {
      document.getElementById('pwdCurrent').value = a;
      document.getElementById('pwdNew').value = b;
      document.getElementById('pwdConfirm').value = c;
    }, cur, pw, cf);
    const submitPwd = async () => (await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/password') && r.request().method() === 'POST'), page.click('#pwdOk')]))[0];
    await fillPwd('wrong-pass', 'adminpass2', 'adminpass2');
    let pr = await submitPwd();
    await page.waitForFunction(() => document.getElementById('pwdError').textContent !== '', { timeout: 3000 }).catch(() => {});
    let pst = await page.evaluate(() => [document.getElementById('pwdMask').hidden, document.getElementById('pwdError').textContent, document.getElementById('pwdCurrent').value]);
    check('当前密码错误：400，弹窗内显示错误且不关闭、保留输入', pr.status() === 400 && pst[0] === false && pst[1] === '当前密码错误' && pst[2] === 'wrong-pass', pr.status() + ' ' + pst.join(','));
    await fillPwd('adminpass1', 'adminpass2', 'adminpass2');
    pr = await submitPwd();
    const prBody = await pr.json().catch(() => null);
    await page.waitForSelector('#pwdMask[hidden]', { timeout: 3000 }).catch(() => {});
    pst = await page.evaluate(() => [document.getElementById('pwdMask').hidden, document.getElementById('toast').hidden, document.getElementById('toast').textContent]);
    check('当前密码正确：弹窗关闭并提示成功', pr.status() === 200 && prBody && prBody.ok === true && pst[0] === true && pst[1] === false && pst[2] === '密码已修改，其它设备需重新登录', pr.status() + ' ' + pst.join(','));
    await page.click('#userBtn');
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#logoutForm button')]);
    res = await submitForm(page, 'form', { username: 'admin', password: 'adminpass2' });
    check('退出后用新密码登录成功', where() === '/', res.status() + ' ' + where());

    // 5. 用户管理：新增 bob；不能删除自己
    await page.goto(base + '/admin/users', { waitUntil: 'networkidle0' });
    await submitForm(page, 'form.auth-inline-form', { username: 'bob', password: 'bobpass1' });
    const names = await page.$$eval('.auth-table tbody tr td:first-child', tds => tds.map(t => t.textContent.trim()));
    check('新增用户 bob 后列表出现 bob', names.some(n => n === 'bob'), names.join(','));
    const selfDel = await page.$$eval('.auth-table tbody tr', trs => trs.filter(tr => /（我）/.test(tr.textContent)).map(tr => !!tr.querySelector('button.danger')));
    const del = await page.evaluate(() => fetch('/admin/users/delete', { method: 'POST', body: new URLSearchParams({ name: 'admin', csrf: document.querySelector('input[name=csrf]').value }) }).then(async r => [r.status, await r.text()]));
    check('不能删除自己（无删除按钮，且提交被拒）', selfDel.length === 1 && !selfDel[0] && del[0] === 400 && del[1].includes('不能删除自己'), selfDel + ' ' + del[0]);

    // 6. 退出登录：清除该用户的暂存内容
    await page.goto(base + '/', { waitUntil: 'networkidle0' });
    await page.evaluate(() => window.jsonviewer.setText('{"secret":1}'));
    const savedBefore = await page.evaluate(() => sessionStorage.getItem('jsonviewer_text:admin'));
    await page.click('#userBtn');
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#logoutForm button')]);
    const savedAfter = await page.evaluate(() => sessionStorage.getItem('jsonviewer_text:admin'));
    check('退出后落在 /login 且清除暂存内容', where() === '/login' && savedBefore === '{"secret":1}' && savedAfter === null, where() + ' ' + savedBefore + ' -> ' + savedAfter);

    // 7. 普通用户 bob
    await submitForm(page, 'form', { username: 'bob', password: 'bobpass1' });
    m = await menuInfo();
    check('bob 登录后菜单显示 bob，无"用户管理"', where() === '/' && m.name === 'bob' && !m.admin, JSON.stringify(m));
    res = await page.goto(base + '/admin/users', { waitUntil: 'networkidle0' });
    check('普通用户访问 /admin/users 返回 403', res.status() === 403, res.status());

    // 8. 登出后连续输错密码触发锁定（放在最后：同一 IP 会被锁 60 秒）
    await page.goto(base + '/', { waitUntil: 'networkidle0' });
    await page.click('#userBtn');
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#logoutForm button')]);
    const codes = [];
    for (let i = 0; i < 10; i++) codes.push((await submitForm(page, 'form', { username: 'bob', password: 'wrong-' + i })).status());
    res = await submitForm(page, 'form', { username: 'bob', password: 'bobpass1' });
    msg = await page.$eval('.auth-msg', e => e.textContent).catch(() => '');
    check('连续 10 次错误后第 11 次被锁定', codes.every(c => c === 401) && res.status() === 429 && msg.includes('尝试次数过多'), codes.join(',') + ' -> ' + res.status() + ' ' + msg);

    // 10. 无页面错误
    check('登录验证实例无页面错误', errors.length === 0, errors.join(' | '));
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    srv.kill('SIGTERM');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  const port = await freePort();
  const srv = spawn(BIN, ['-listen', '127.0.0.1:' + port], { stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', d => process.env.VERBOSE && process.stderr.write(d));
  await waitPort(port);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 800 });
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    // 懒加载包的请求计数（§18.2 第 11 条）：纯 JSON 阶段应为 0
    const vendorReqs = { yaml: 0, toml: 0 };
    page.on('request', r => { const m = /\/js\/vendor\/(yaml|toml)\.bundle\.js/.exec(r.url()); if (m) vendorReqs[m[1]]++; });
    const res = await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0' });
    check('页面加载 200', res.status() === 200);

    console.log('功能测试');
    const sample = '{"name":"张三","id":12345678901234567890,"price":9.99,"ok":true,"nothing":null,"tags":["a","b:c",{"deep":{"deeper":[1,2,3]}}],"empty":{},"emptyArr":[],"quote\\"key":"x<y>&z","nested":{"level1":{"level2":{"level3":"找到我"}}}}';
    await page.evaluate(s => window.jsonviewer.setText(s), sample);
    const rows1 = await page.$$eval('#treeLayer .tn', els => els.map(e => e.textContent));
    check('根节点展开显示第一层', rows1[0] === 'JSON' && rows1.length === 11, rows1.length);
    check('大整数不丢精度', rows1.includes('id : 12345678901234567890'));
    check('字符串带引号、HTML 转义正常', rows1.includes('quote"key : "x<y>&z"'));
    const grid = await page.$$eval('#gridRows tr', trs => trs.map(t => t.textContent));
    check('属性表显示子项，容器为 ...', grid.includes('tags...') && grid.includes('price9.99'), grid.length);
    await page.click('#btnExpandAll');
    check('全部展开', (await page.$$eval('#treeLayer .tn', els => els.length)) === 22);
    await page.click('#btnCollapseAll');
    check('全部收缩', (await page.$$eval('#treeLayer .tn', els => els.length)) === 1);

    // 双击非叶节点展开/折叠（用真实的 mousedown/up 序列，ElementHandle.click 的 clickCount 不会产生两次 click）
    await page.evaluate(() => window.jsonviewer.tree.expandAll());
    const dblClickRow = async text => {
      const [x, y] = await page.evaluate(t => { const el = [...document.querySelectorAll('#treeLayer .tn')].find(e => e.textContent === t).querySelector('a span'); const b = el.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; }, text);
      await page.mouse.move(x, y); await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 }); await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
    };
    await page.evaluate(() => window.jsonviewer.tree.collapseAll());
    await page.evaluate(() => { const t = window.jsonviewer.tree; t.root.expanded = true; t.flatten(); t.invalidate(); });
    const rowsBefore = await page.$$eval('#treeLayer .tn', els => els.length);
    await dblClickRow('tags');
    const afterOpen = await page.$$eval('#treeLayer .tn', els => els.length);
    await dblClickRow('tags');
    const afterClose = await page.$$eval('#treeLayer .tn', els => els.length);
    check('双击非叶节点展开再折叠', afterOpen > rowsBefore && afterClose === rowsBefore, rowsBefore + ' -> ' + afterOpen + ' -> ' + afterClose);

    await page.click('#searchText', { clickCount: 3 }); await page.keyboard.type('deeper'); await page.keyboard.press('Enter'); await sleep(300);
    check('查找命中并选中', (await page.$eval('#searchResult', e => e.textContent)) === '1/1' && (await page.$eval('#treeLayer .tn.sel', e => e.textContent)) === 'deeper');
    check('查找后属性表切换到命中节点', JSON.stringify(await page.$$eval('#gridRows tr', trs => trs.map(t => t.textContent))) === '["01","12","23"]');
    await page.evaluate(() => { document.getElementById('searchText').value = 'zzz-none'; }); await page.click('#btnSearch'); await sleep(300);
    check('查找未命中提示', (await page.$eval('#searchResult', e => e.textContent)) === 'Phrase not found!');

    await page.click('#btnExpandAll');
    const h = await page.evaluateHandle(() => [...document.querySelectorAll('#treeLayer .tn')].find(e => e.textContent.includes('level3')));
    await h.click({ button: 'right' });
    const items = await page.$$eval('#ctxMenu .ctx-item', els => els.map(e => e.textContent));
    check('右键菜单 7 项', items.length === 7 && items[0] === '复制Key' && items[6] === '收起所有节点', items.join('/'));
    await page.click('#ctxMenu [data-act="copyValue"]'); await sleep(50);
    check('复制 Value 提示', (await page.$eval('#toast', e => e.hidden ? '' : e.textContent)) === 'Value 复制成功');

    await page.click('#btnFormat');
    const formatted = await page.evaluate(() => window.jsonviewer.getText());
    check('格式化为多行且保留大数原文', formatted.split('\n').length > 20 && formatted.includes('12345678901234567890'));
    await page.click('#btnMinify');
    check('删除空格还原为原文', (await page.evaluate(() => window.jsonviewer.getText())) === sample);
    await page.click('#btnMinifyEscape');
    check('删除空格并转义', (await page.evaluate(() => window.jsonviewer.getText())).startsWith('{\\"name\\":'));
    await page.click('#btnUnescape');
    check('去除转义并重新解析', (await page.$$eval('#treeLayer .tn', els => els.length)) >= 11);

    await page.evaluate(() => window.jsonviewer.setText(''));
    await page.click('#edit .cm-content');
    await page.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', '{"pasted":[1,2]}'); document.querySelector('#edit .cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
    await sleep(100);
    check('粘贴后自动解析', JSON.stringify(await page.$$eval('#treeLayer .tn', els => els.map(e => e.textContent))) === '["JSON","pasted"]');
    await page.click('#edit .cm-content');
    await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control');
    await page.keyboard.type('{"typed": 42}');
    await page.click('#searchText'); await sleep(50);
    check('失焦后自动解析', JSON.stringify(await page.$$eval('#treeLayer .tn', els => els.map(e => e.textContent))) === '["JSON","typed : 42"]');

    await page.evaluate(() => window.jsonviewer.setText('{"a": 1,\n  "b": [1, 2,]\n}'));
    const body = await page.$eval('#dialogBody', e => e.innerText);
    check('错误对话框含行列定位', (await page.$eval('#dialogMask', e => !e.hidden)) && /第 2 行，第 14 列/.test(body), body.split('\n')[2]);
    await page.click('#dialogOk');

    // 拖动分割条
    const before = await page.$eval('#leftPanel', e => e.getBoundingClientRect().width);
    const sp = await page.$('#splitLeft'); const bb = await sp.boundingBox();
    await page.mouse.move(bb.x + 2, bb.y + 300); await page.mouse.down(); await page.mouse.move(bb.x + 152, bb.y + 300, { steps: 5 }); await page.mouse.up();
    const after = await page.$eval('#leftPanel', e => e.getBoundingClientRect().width);
    check('分割条可拖动', Math.round(after - before) === 150, before + ' -> ' + after);

    if (BIG > 0) {
      console.log('性能测试（' + BIG + ' 条记录）');
      const big = await page.evaluate(n => {
        const arr = []; for (let i = 0; i < n; i++) arr.push({ id: i, name: 'user_' + i, email: 'user' + i + '@example.com', active: i % 2 === 0, score: i * 1.5, tags: ['x', 'y', 'z'], meta: { a: i, b: null, c: 'str' } });
        const s = JSON.stringify({ users: arr }); const t0 = performance.now(); window.jsonviewer.setText(s);
        return { mb: (s.length / 1048576).toFixed(1), ms: Math.round(performance.now() - t0) };
      }, BIG);
      check('载入+解析 ' + big.mb + 'MB', big.ms < 5000, big.ms + 'ms');
      const raf = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      let t = await page.evaluate(() => { const t0 = performance.now(); document.getElementById('btnExpandAll').click(); return Math.round(performance.now() - t0); }); await raf();
      const rows = await page.evaluate(() => window.jsonviewer.tree.rows.length);
      check('全部展开 ' + rows + ' 行', t < 5000 && (await page.$$eval('#treeLayer .tn', els => els.length)) < 100, t + 'ms, DOM 行数受控');
      await page.evaluate(() => { const b = document.getElementById('treeBody'); b.scrollTop = b.scrollHeight; }); await raf(); await raf();
      check('滚动到底部显示最后一行', (await page.$$eval('#treeLayer .tn', els => els.slice(-1)[0].textContent)) === 'c : "str"');
      t = await page.evaluate(n => { document.getElementById('searchText').value = 'user_' + (n - 1); const t0 = performance.now(); document.getElementById('btnSearch').click(); return new Promise(r => setTimeout(() => r(Math.round(performance.now() - t0 - 150)), 500)); }, BIG); await raf();
      const vis = await page.evaluate(() => { const s = document.querySelector('#treeLayer .tn.sel'); if (!s) return false; const r = s.getBoundingClientRect(), b = document.getElementById('treeBody').getBoundingClientRect(); return r.top >= b.top && r.bottom <= b.bottom; });
      check('查找末尾节点并定位可见', vis, t + 'ms');
      t = await page.evaluate(() => { const t0 = performance.now(); document.getElementById('btnFormat').click(); return Math.round(performance.now() - t0); }); await raf();
      check('格式化大文本', t < 15000, t + 'ms');
      t = await page.evaluate(() => { const t0 = performance.now(); window.jsonviewer.parse(); return Math.round(performance.now() - t0); });
      check('重新解析格式化后文本', t < 5000, t + 'ms');
    }
    // ---------- 多格式查看（§18.2 第 1–6、11 条） ----------
    console.log('多格式查看');
    check('纯 JSON 会话没有请求 yaml / toml 包', vendorReqs.yaml === 0 && vendorReqs.toml === 0, JSON.stringify(vendorReqs));
    const cmCount = await page.$$eval('.cm-editor', els => els.length);
    check('停在树视图时不创建转换结果编辑器（页面上只有一个 CodeMirror）', cmCount === 1, cmCount);
    const treeRows = () => page.$$eval('#treeLayer .tn', els => els.map(e => e.textContent));
    const badge = () => page.$eval('#fmtSelect', s => s.options[s.selectedIndex].textContent);
    const leftTitle = () => page.$eval('#leftTitle', e => e.textContent);
    const pasteText = async text => {
      await page.evaluate(() => window.jsonviewer.setText(''));
      await page.click('#edit .cm-content');
      await page.evaluate(t => { const dt = new DataTransfer(); dt.setData('text/plain', t); document.querySelector('#edit .cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, text);
      await sleep(50);
      await page.evaluate(() => window.jsonviewer.whenIdle());
    };

    // 1. 粘贴 YAML：懒加载 yaml 包恰好一次，徽标「自动 · YAML」，根节点 YAML
    await pasteText('server:\n  host: a\n  port: 80\nlist:\n  - 1\n  - two\n  - 12345678901234567890\n');
    let rowsF = await treeRows();
    check('粘贴 YAML：徽标「自动 · YAML」、标题 YAML数据、根节点 YAML、树行数正确', (await badge()) === '自动 · YAML' && (await leftTitle()) === 'YAML数据' && JSON.stringify(rowsF) === '["YAML","server","list"]', (await badge()) + ' ' + JSON.stringify(rowsF));
    check('首次粘贴 YAML 后恰好请求一次 yaml 包，没有请求 toml 包', vendorReqs.yaml === 1 && vendorReqs.toml === 0, JSON.stringify(vendorReqs));
    await page.click('#btnExpandAll');
    rowsF = await treeRows();
    check('YAML 长整数保留原文', rowsF.includes('2 : 12345678901234567890') && rowsF.includes('port : 80'), JSON.stringify(rowsF));
    await page.evaluate(() => window.jsonviewer.setText('a: 1\n---\nb: 2\n'));
    check('多文档 YAML 的根标签', (await treeRows())[0] === 'YAML（2 个文档）', (await treeRows())[0]);

    // 6（YAML 部分）. 工具栏：删除空格 / 删除空格并转义 / 去除转义禁用，格式化可用且提示注释未保留
    await page.evaluate(() => window.jsonviewer.setText('# 注释\nb:   [1, 2]\na: {x: 1}\n'));
    const btnState = () => page.evaluate(() => ['btnFormat', 'btnMinify', 'btnMinifyEscape', 'btnUnescape'].map(id => { const b = document.getElementById(id); return (b.disabled ? 'off' : 'on') + (b.disabled && !b.title ? '(无 title)' : ''); }).join(','));
    let bs = await btnState();
    check('YAML 下「删除空格」「删除空格并转义」「去除转义」禁用且有说明', bs === 'on,off,off,off', bs);
    await page.click('#btnFormat'); await sleep(50);
    check('YAML 格式化：解析后重排并提示注释未保留', (await page.evaluate(() => window.jsonviewer.getText())) === 'b:\n  - 1\n  - 2\na:\n  x: 1' && (await page.$eval('#toast', e => e.hidden ? '' : e.textContent)) === '注释未保留，Ctrl+Z 可撤销', JSON.stringify(await page.evaluate(() => window.jsonviewer.getText())));
    await page.click('#btnMinify');
    check('禁用的按钮点击无效', (await page.evaluate(() => window.jsonviewer.getText())).startsWith('b:\n'));

    // 2. 粘贴 TOML：日期节点不带引号、使用 date 图标；懒加载 toml 包一次
    await pasteText('title = "TOML 示例"\n\n[owner]\nname = "Tom"\ndob = 1979-05-27T07:32:00-08:00\nday = 1979-05-27\n\n[[products]]\nname = "Hammer"\n\n[[products]]\nname = "Nail"\n');
    await page.click('#btnExpandAll');
    rowsF = await treeRows();
    const dateIcon = await page.evaluate(() => { const r = [...document.querySelectorAll('#treeLayer .tn')].find(e => e.textContent.startsWith('dob : ')); return r ? r.querySelector('.ni').className : ''; });
    check('粘贴 TOML：根节点 TOML，日期不带引号且使用 date 图标', rowsF[0] === 'TOML' && (await badge()) === '自动 · TOML' && rowsF.includes('dob : 1979-05-27T07:32:00-08:00') && rowsF.includes('day : 1979-05-27') && dateIcon === 'ni date', JSON.stringify(rowsF) + ' ' + dateIcon);
    check('TOML 表数组成为数组节点', rowsF.includes('products') && rowsF.includes('name : "Nail"'));
    check('首次粘贴 TOML 后恰好请求一次 toml 包', vendorReqs.yaml === 1 && vendorReqs.toml === 1, JSON.stringify(vendorReqs));
    bs = await btnState();
    check('TOML 下「删除空格」禁用', bs === 'on,off,off,off', bs);

    // 3. 粘贴 XML：@id 与 #text 节点出现
    await pasteText('<book id="1">\n  <title lang="zh">三体</title>\n  <tag>科幻</tag>\n  <tag>长篇</tag>\n</book>');
    await page.click('#btnExpandAll');
    rowsF = await treeRows();
    check('粘贴 XML：根节点 XML，@id 与 #text 节点出现，重复元素成数组', rowsF[0] === 'XML' && (await badge()) === '自动 · XML' && rowsF.includes('@id : "1"') && rowsF.includes('#text : "三体"') && rowsF.includes('tag') && rowsF.includes('0 : "科幻"'), JSON.stringify(rowsF));

    // 6（XML 部分）. 格式化与删除空格可用且保留注释
    await page.evaluate(() => window.jsonviewer.setText('<r><!-- 注释 --><a>1</a>\n<b x="1"/></r>'));
    bs = await btnState();
    check('XML 下「格式化」「删除空格」可用，转义类禁用', bs === 'on,on,off,off', bs);
    await page.click('#btnFormat');
    let xt = await page.evaluate(() => window.jsonviewer.getText());
    check('XML 格式化：缩进重排并保留注释', xt === '<r>\n    <!-- 注释 -->\n    <a>1</a>\n    <b x="1"/>\n</r>', JSON.stringify(xt));
    await page.click('#btnMinify');
    xt = await page.evaluate(() => window.jsonviewer.getText());
    check('XML 删除空格：去除元素间空白并保留注释', xt === '<r><!-- 注释 --><a>1</a><b x="1"/></r>', JSON.stringify(xt));

    // 5. 各格式的语法错误：对话框标题、行列、光标定位
    const errCase = async (text, title, re, line) => {
      await page.evaluate(t => window.jsonviewer.setText(t), text);
      await page.evaluate(() => window.jsonviewer.whenIdle());
      const d = await page.evaluate(() => ({ open: !document.getElementById('dialogMask').hidden, title: document.getElementById('dialogTitle').textContent, body: document.getElementById('dialogBody').innerText, active: (document.querySelector('#edit .cm-activeLine') || {}).textContent }));
      check(title + '：对话框标题、行列与光标定位', d.open && d.title === title && re.test(d.body) && d.active === line && /自动识别/.test(d.body), d.title + ' | ' + d.body.split('\n').slice(0, 2).join(' / ') + ' | 光标行 ' + JSON.stringify(d.active));
      await page.click('#dialogOk');
    };
    await errCase('a: 1\nb: [1, 2\nc: 3', 'YAML 错误', /第 3 行，第 1 列/, 'c: 3');
    await errCase('a = 1\nb = = 2', 'TOML 错误', /第 2 行，第 5 列/, 'b = = 2');
    await errCase('<a>\n  <b>1</c>\n</a>', 'XML 错误', /位置（近似）：第 2 行/, '  <b>1</c>');

    // 4. 手动指定格式覆盖自动识别；刷新后手动模式仍在
    await page.evaluate(() => window.jsonviewer.setText('a = 1'));
    check('自动识别 a = 1 为 TOML', (await treeRows())[0] === 'TOML' && (await badge()) === '自动 · TOML');
    await page.select('#fmtSelect', 'yaml');
    await page.evaluate(() => window.jsonviewer.whenIdle());
    check('手动选择 YAML 后按 YAML 解析', JSON.stringify(await treeRows()) === '["YAML : \\"a = 1\\""]' && (await leftTitle()) === 'YAML数据', JSON.stringify(await treeRows()));
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.querySelectorAll('#treeLayer .tn').length > 0, { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => window.jsonviewer.whenIdle());
    const afterReload = await page.evaluate(() => ({ f: window.jsonviewer.getFormat(), sel: document.getElementById('fmtSelect').value, text: window.jsonviewer.getText() }));
    check('刷新后手动模式仍在且按 YAML 解析', afterReload.f.mode === 'yaml' && afterReload.f.format === 'yaml' && afterReload.sel === 'yaml' && afterReload.text === 'a = 1' && (await treeRows())[0] === 'YAML : "a = 1"', JSON.stringify(afterReload) + ' ' + JSON.stringify(await treeRows()));
    await page.evaluate(() => { window.jsonviewer.setFormat('auto'); return window.jsonviewer.whenIdle(); });   // 刷新后的新页面要重新懒加载 toml 包
    check('切回自动后重新识别为 TOML', (await treeRows())[0] === 'TOML' && (await page.evaluate(() => window.jsonviewer.getFormat().mode)) === 'auto');
    await page.evaluate(() => window.jsonviewer.setText('{"back": "json"}'));
    bs = await btnState();
    check('回到 JSON：根节点 JSON、标题 JSON数据、工具栏全部可用', JSON.stringify(await treeRows()) === '["JSON","back : \\"json\\""]' && (await leftTitle()) === 'JSON数据' && bs === 'on,on,on,on', bs);

    // ---------- 转换（§18.2 第 7–10 条） ----------
    console.log('转换');
    const conv = () => page.evaluate(() => {
      const ed = document.querySelector('#convEdit .cm-editor');
      return {
        target: (document.querySelector('#convTargets button.on') || {}).textContent,
        bar: !document.getElementById('convBar').hidden,
        warn: document.getElementById('convBar').classList.contains('warn'),
        barText: document.getElementById('convBarText').textContent,
        msg: document.getElementById('convMsg').hidden ? '' : document.getElementById('convMsg').textContent,
        text: ed && !document.getElementById('convEdit').hidden ? window.CM.EditorView.findFromDOM(ed).state.doc.toString() : null,
        treeHidden: document.getElementById('treePane').hidden,
        convHidden: document.getElementById('convPane').hidden
      };
    });
    const idle = () => page.evaluate(() => window.jsonviewer.whenIdle());
    const pickTarget = async id => { await page.click('#convTargets [data-fmt="' + id + '"]'); await idle(); return conv(); };
    const toastText = () => page.$eval('#toast', e => e.hidden ? '' : e.textContent);

    // 7. 默认目标、四个目标都有结果、提示条有损时出现 / 无损时不出现
    const convJson = '{"name":"x","list":[1,2],"n":null,"sub":{"k":"v"}}';
    await page.evaluate(t => window.jsonviewer.setText(t), convJson);
    await page.click('#tabConvert'); await idle();
    let cs = await conv();
    check('切到转换标签：源为 JSON 时默认目标 YAML，结果正确，无损时不显示提示条', cs.target === 'YAML' && cs.text === "name: x\nlist:\n  - 1\n  - 2\n'n': null\nsub:\n  k: v\n" && !cs.bar && cs.treeHidden && !cs.convHidden, JSON.stringify(cs));
    check('首次切到转换标签后才创建结果编辑器', (await page.$$eval('.cm-editor', els => els.length)) === 2);
    cs = await pickTarget('json');
    check('目标 JSON：缩进 4，无损不显示提示条', cs.target === 'JSON' && cs.text === JSON.stringify(JSON.parse(convJson), null, 4) && !cs.bar, JSON.stringify(cs));
    cs = await pickTarget('toml');
    check('目标 TOML：null 被丢弃，提示条（警告色）给出数量与路径', cs.target === 'TOML' && cs.text === 'name = "x"\nlist = [ 1, 2 ]\n\n[sub]\nk = "v"\n' && cs.bar && cs.warn && /1 个值为 null 的键已丢弃/.test(cs.barText) && cs.barText.includes('$.n'), JSON.stringify(cs));
    cs = await pickTarget('xml');
    check('目标 XML：包 <root>，提示条出现', cs.target === 'XML' && cs.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<root>\n    <name>x</name>\n    <list>1</list>') && cs.bar && cs.warn && /root/.test(cs.barText), JSON.stringify(cs).slice(0, 300));
    await page.click('#convDetail');
    const det = await page.evaluate(() => ({ open: !document.getElementById('dialogMask').hidden, title: document.getElementById('dialogTitle').textContent, items: document.querySelectorAll('#dialogBody .loss-list li').length }));
    check('「详情」弹出对话框列出损失', det.open && det.title === '转换说明：JSON → XML' && det.items >= 2, JSON.stringify(det));
    await page.click('#dialogOk');
    cs = await pickTarget('yaml');
    check('切回 YAML：命中缓存，提示条隐藏', cs.target === 'YAML' && cs.text.startsWith('name: x') && !cs.bar, JSON.stringify(cs));
    // 转换工具栏在 1400 与 1366 宽度下不换行
    const noWrap = () => page.evaluate(() => {
      const tb = document.querySelector('.conv-toolbar'), tops = [...tb.children].filter(e => e.offsetParent).map(e => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2));
      return tb.scrollWidth <= tb.clientWidth && new Set(tops).size === 1 && tb.getBoundingClientRect().height <= 33;
    });
    const nw1400 = await noWrap();
    await page.setViewport({ width: 1366, height: 768 });
    const nw1366 = await noWrap();
    await page.setViewport({ width: 1400, height: 800 });
    check('转换工具栏在 1400 与 1366 宽度下不换行', nw1400 && nw1366, nw1400 + ' ' + nw1366);
    // 源不是 JSON 时默认目标 JSON；固有损失为灰色提示
    await page.evaluate(() => window.jsonviewer.setText('# 注释\na: 1\nb: [x, y]\n')); await idle();
    cs = await conv();
    check('源为 YAML 时默认目标 JSON，固有损失（注释不保留）以灰色提示', cs.target === 'JSON' && cs.text === '{\n    "a": 1,\n    "b": [\n        "x",\n        "y"\n    ]\n}' && cs.bar && !cs.warn && /注释/.test(cs.barText), JSON.stringify(cs));
    // 源解析失败：提示并可定位
    await page.evaluate(() => window.jsonviewer.setText('{"a": 1,\n "b": ]}'));
    await page.click('#dialogOk');
    cs = await conv();
    check('源解析失败：面板提示先修正，结果区清空', /左侧文本解析失败/.test(cs.msg) && cs.text === null && !cs.bar && (await page.$eval('#convApply', b => b.disabled)), JSON.stringify(cs));
    await page.click('#convMsg [data-act="locate"]');
    const loc = await page.evaluate(() => ({ open: !document.getElementById('dialogMask').hidden, title: document.getElementById('dialogTitle').textContent, body: document.getElementById('dialogBody').innerText }));
    check('「定位错误」弹出错误并定位', loc.open && loc.title === 'JSON 错误' && /第 2 行/.test(loc.body), JSON.stringify(loc).slice(0, 200));
    await page.click('#dialogOk');
    await page.evaluate(() => window.jsonviewer.setText(''));
    cs = await conv();
    check('源为空：提示先粘贴内容', /请先粘贴/.test(cs.msg) && cs.text === null, cs.msg);

    // 9. 复制给出 toast；下载生成 Blob 与 download 文件名
    await page.evaluate(() => window.jsonviewer.setText('a: 1\nb: [x, y]\n')); await idle();
    await page.click('#convCopy'); await sleep(50);
    check('复制结果给出 toast', (await toastText()) === '复制成功', await toastText());
    await page.evaluate(() => {
      window.__dl = null;
      const orig = URL.createObjectURL, origClick = HTMLAnchorElement.prototype.click;
      URL.createObjectURL = b => { window.__blob = b; return orig.call(URL, b); };
      HTMLAnchorElement.prototype.click = function () { window.__dl = { name: this.download, href: this.href }; };
      window.__restoreDl = () => { URL.createObjectURL = orig; HTMLAnchorElement.prototype.click = origClick; };
    });
    await page.click('#convDownload');
    const dl = await page.evaluate(async () => { const r = { dl: window.__dl, type: window.__blob && window.__blob.type, text: window.__blob && await window.__blob.text() }; window.__restoreDl(); return r; });
    check('下载：converted.json，Blob 内容为转换结果', dl.dl && dl.dl.name === 'converted.json' && /^blob:/.test(dl.dl.href) && /^application\/json/.test(dl.type) && dl.text === '{\n    "a": 1,\n    "b": [\n        "x",\n        "y"\n    ]\n}', JSON.stringify(dl));

    // 8. 应用到左侧：替换左侧文本、切回树视图、按新格式重建树；Ctrl+Z 能恢复
    await page.click('#convApply'); await idle();
    let applied = await page.evaluate(() => ({ text: window.jsonviewer.getText(), f: window.jsonviewer.getFormat() }));
    cs = await conv();
    check('应用到左侧：文本被替换，切回树视图，树按 JSON 重建，自动模式保持自动', applied.text.startsWith('{\n    "a": 1') && applied.f.mode === 'auto' && applied.f.format === 'json' && !cs.treeHidden && cs.convHidden && JSON.stringify(await treeRows()) === '["JSON","a : 1","b"]' && (await badge()) === '自动 · JSON', JSON.stringify(applied) + ' ' + JSON.stringify(await treeRows()));
    check('应用后提示「已应用，Ctrl+Z 可撤销」', (await toastText()) === '已应用，Ctrl+Z 可撤销', await toastText());
    await page.click('#edit .cm-content');
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    await page.click('#searchText'); await idle();
    check('Ctrl+Z 恢复原文并重新按 YAML 解析', (await page.evaluate(() => window.jsonviewer.getText())) === 'a: 1\nb: [x, y]\n' && (await treeRows())[0] === 'YAML', JSON.stringify(await page.evaluate(() => window.jsonviewer.getText())));
    // 手动模式下应用：切到目标格式
    await page.evaluate(() => { window.jsonviewer.setFormat('yaml'); return window.jsonviewer.whenIdle(); });
    await page.evaluate(() => window.jsonviewer.showTab('convert'));
    await pickTarget('toml');
    await page.click('#convApply'); await idle();
    applied = await page.evaluate(() => ({ text: window.jsonviewer.getText(), f: window.jsonviewer.getFormat(), sel: document.getElementById('fmtSelect').value }));
    check('手动模式下应用：格式切到目标格式 TOML', applied.f.mode === 'toml' && applied.sel === 'toml' && applied.text === 'a = 1\nb = [ "x", "y" ]\n' && (await treeRows())[0] === 'TOML', JSON.stringify(applied));
    await page.evaluate(() => { window.jsonviewer.setFormat('auto'); return window.jsonviewer.whenIdle(); });

    // 10. 在转换标签期间重新解析，切回树视图后树行按真实高度渲染（防 clientHeight 为 0 的回归）
    await page.evaluate(() => window.jsonviewer.showTab('convert'));
    const many = {}; for (let i = 0; i < 60; i++) many['key' + i] = i;
    await page.evaluate(t => window.jsonviewer.setText(t), JSON.stringify(many)); await idle();
    await page.click('#tabTree');
    const treeOk = await page.evaluate(() => ({ rows: document.querySelectorAll('#treeLayer .tn').length, h: document.getElementById('treeBody').clientHeight }));
    check('从转换标签切回树视图后树行正常渲染', treeOk.h > 300 && treeOk.rows >= Math.floor(treeOk.h / 18), JSON.stringify(treeOk));

    // XML 推断类型开关：切换后重新解析左侧，树与转换结果同步变化
    await page.evaluate(() => window.jsonviewer.setText('<r><n>42</n><z>007</z></r>'));
    await page.click('#tabConvert'); await idle();
    await page.click('#convOptBtn');
    const optVis = await page.evaluate(() => ({ open: !document.getElementById('convOpts').hidden, infer: !document.getElementById('optInferRow').hidden, root: !document.getElementById('optRootRow').hidden }));
    await page.click('#optInfer'); await idle();
    cs = await conv();
    await page.keyboard.press('Escape');
    await page.click('#tabTree'); await page.click('#btnExpandAll');
    const inferRows = await treeRows();
    check('选项下拉：源为 XML 时显示「推断类型」，开启后树与结果都按推断类型', optVis.open && optVis.infer && !optVis.root && cs.text === '{\n    "r": {\n        "n": 42,\n        "z": "007"\n    }\n}' && inferRows.includes('n : 42') && inferRows.includes('z : "007"'), JSON.stringify(optVis) + ' ' + JSON.stringify(cs.text) + ' ' + JSON.stringify(inferRows));
    await page.evaluate(() => { localStorage.removeItem('jsonviewer_conv'); });
    await page.evaluate(() => window.jsonviewer.setText('{"back": "json"}'));

    // ---------- 大文本确认框与忙碌提示（§16.2）：用 _setLimits 临时调小阈值 ----------
    // 注意：确认框打开期间 whenIdle 不会 resolve，必须先点按钮再 idle()
    console.log('大文本确认与忙碌提示');
    await page.click('#tabTree');
    const origLimits = await page.evaluate(() => window.jsonviewer._setLimits({ confirmBytes: 200 }));
    const confirmState = () => page.evaluate(() => ({ open: !document.getElementById('confirmMask').hidden, title: document.getElementById('confirmTitle').textContent, body: document.getElementById('confirmBody').textContent }));
    const waitConfirm = () => page.waitForSelector('#confirmMask:not([hidden])', { timeout: 3000 }).then(() => confirmState());
    const bigYamlSmall = 'items:\n' + Array.from({ length: 20 }, (_, i) => '  - name: item' + i + '\n').join('');
    const bigJsonSmall = JSON.stringify({ list: Array.from({ length: 40 }, (_, i) => 'value' + i) });
    let rv = await page.evaluate(t => window.jsonviewer.setText(t), bigJsonSmall);
    check('JSON 源超过阈值：同步解析，不弹确认框', rv === true && !(await confirmState()).open && (await treeRows())[0] === 'JSON', String(rv));
    const rowsKeep = await treeRows();
    rv = await page.evaluate(t => window.jsonviewer.setText(t), bigYamlSmall);
    let cf = await waitConfirm();
    check('YAML 超过阈值：弹确认框并按速率给出预计耗时', rv === null && cf.title === '解析大文本' && /^文本约 \d+ KB，按 YAML 解析预计需要不到 1 秒，期间页面无响应，是否继续？$/.test(cf.body), JSON.stringify(cf));
    await page.click('#confirmCancel'); await idle();
    check('取消后不解析：树、格式徽标、标题保持原状态', !(await confirmState()).open && JSON.stringify(await treeRows()) === JSON.stringify(rowsKeep) && (await badge()) === '自动 · JSON' && (await leftTitle()) === 'JSON数据', JSON.stringify(await treeRows()) + ' ' + (await badge()));
    await page.evaluate(() => window.jsonviewer.parse());
    await waitConfirm();
    await page.click('#confirmOk'); await idle();
    check('确认后按 YAML 解析', JSON.stringify(await treeRows()) === '["YAML","items"]' && (await badge()) === '自动 · YAML', JSON.stringify(await treeRows()));
    await page.evaluate(() => { window.jsonviewer.setFormat('toml'); });
    await waitConfirm();
    await page.keyboard.press('Escape'); await idle();
    const fmAfter = await page.evaluate(() => [window.jsonviewer.getFormat().mode, document.getElementById('fmtSelect').value]);
    check('手动切换格式时取消（Esc）：格式模式退回自动，树不变', fmAfter.join() === 'auto,auto' && (await treeRows())[0] === 'YAML', fmAfter.join() + ' ' + (await treeRows())[0]);

    // 转换：源文本超过阈值时确认；取消后不转换，有当前结果则退回原目标
    await page.click('#tabConvert');
    cf = await waitConfirm();
    check('转换前确认：给出目标格式与预计耗时', cf.title === '转换大文本' && /^文本约 \d+ KB，转换为 JSON 预计需要不到 1 秒，期间页面无响应，是否继续？$/.test(cf.body), JSON.stringify(cf));
    await page.click('#confirmCancel'); await idle();
    cs = await conv();
    check('取消转换：不出结果，提示已取消并可继续', /已取消转换/.test(cs.msg) && cs.text === null && (await page.$eval('#convApply', b => b.disabled)), JSON.stringify(cs));
    await page.click('#convMsg [data-act="convert"]'); await idle();
    cs = await conv();
    check('点「继续转换」后得到结果（不再确认）', !(await confirmState()).open && cs.target === 'JSON' && cs.text && cs.text.startsWith('{\n    "items": ['), JSON.stringify(cs).slice(0, 200));
    await page.click('#convTargets [data-fmt="toml"]');
    await waitConfirm();
    await page.click('#confirmCancel'); await idle();
    cs = await conv();
    check('切换目标时取消：目标退回 JSON，原结果保持显示', cs.target === 'JSON' && cs.text && cs.text.startsWith('{\n    "items": ['), JSON.stringify(cs).slice(0, 200));
    await page.click('#convTargets [data-fmt="toml"]');
    await waitConfirm();
    await page.click('#confirmOk'); await idle();
    cs = await conv();
    check('切换目标时确认：得到 TOML 结果', cs.target === 'TOML' && cs.text && cs.text.startsWith('[[items]]\nname = "item0"'), JSON.stringify(cs).slice(0, 200));

    // 忙碌提示：预计耗时超过 busyMs 时先显示提示、两帧后再计算；JSON 路径始终同步
    await page.evaluate(() => window.jsonviewer._setLimits({ confirmBytes: 1e12, busyMs: 0 }));
    const busyConv = await page.evaluate(() => { document.querySelector('#convTargets [data-fmt="yaml"]').click(); return document.getElementById('convMsg').hidden ? '' : document.getElementById('convMsg').textContent; });
    await idle();
    cs = await conv();
    check('转换：先显示「正在转换…」再出结果', busyConv === '正在转换…' && cs.target === 'YAML' && cs.text && cs.text.startsWith('items:\n  - name: item0'), busyConv + ' ' + JSON.stringify(cs).slice(0, 120));
    await page.click('#tabTree');
    const busyParse = await page.evaluate(() => { const r = window.jsonviewer.setText('busy:\n  parse: 1\n'); const el = document.getElementById('busyTip'); return [r, el.hidden ? '' : el.textContent]; });
    await idle();
    check('解析：先显示「正在解析…」，完成后隐藏并出树', busyParse[0] === null && busyParse[1] === '正在解析…' && (await page.$eval('#busyTip', e => e.hidden)) && JSON.stringify(await treeRows()) === '["YAML","busy"]', JSON.stringify(busyParse) + ' ' + JSON.stringify(await treeRows()));
    const busyJson = await page.evaluate(() => { const r = window.jsonviewer.setText('{"sync": true}'); return [r, document.getElementById('busyTip').hidden]; });
    check('JSON 解析不经忙碌提示（同步返回）', busyJson[0] === true && busyJson[1] === true && JSON.stringify(await treeRows()) === '["JSON","sync : true"]', JSON.stringify(busyJson));
    await page.evaluate(l => window.jsonviewer._setLimits(l), origLimits);

    // ---------- 目标解析器按需懒加载：新页面只粘贴 JSON，转换到 TOML 时才请求 toml 包且恰好一次 ----------
    {
      const p2 = await browser.newPage();
      await p2.setViewport({ width: 1400, height: 800 });
      p2.on('pageerror', e => errors.push('pageerror(p2): ' + e.message));
      p2.on('console', m => { if (m.type() === 'error') errors.push('console(p2): ' + m.text()); });
      const reqs2 = { yaml: 0, toml: 0 };
      p2.on('request', r => { const m = /\/js\/vendor\/(yaml|toml)\.bundle\.js/.exec(r.url()); if (m) reqs2[m[1]]++; });
      await p2.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'networkidle0' });
      await p2.click('#edit .cm-content');
      await p2.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', '{"lazy": {"a": 1, "b": [true, "x"]}}'); document.querySelector('#edit .cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
      await sleep(50);
      await p2.click('#tabConvert'); await p2.evaluate(() => window.jsonviewer.whenIdle());
      const before2 = reqs2.toml;
      await p2.click('#convTargets [data-fmt="toml"]'); await p2.evaluate(() => window.jsonviewer.whenIdle());
      const out2 = await p2.evaluate(() => window.CM.EditorView.findFromDOM(document.querySelector('#convEdit .cm-editor')).state.doc.toString());
      check('新页面只粘贴 JSON：选 TOML 目标时才请求 toml 包且恰好一次，结果正确', before2 === 0 && reqs2.toml === 1 && out2 === '[lazy]\na = 1\nb = [ true, "x" ]\n', before2 + ' -> ' + reqs2.toml + ' ' + JSON.stringify(out2));
      await p2.close();
    }

    // ---------- 多格式性能（§18.2 第 13 条），数据与上面的大 JSON 同构 ----------
    if (BIG > 0) {
      console.log('多格式性能');
      await page.click('#tabTree');
      const pf = await page.evaluate(async () => {
        const jv = window.jsonviewer, out = {}, target = 5 * 1048576;
        const yamlRec = i => '  - id: ' + i + '\n    name: user_' + i + '\n    email: user' + i + '@example.com\n    active: ' + (i % 2 === 0) + '\n    score: ' + i * 1.5 +
          '\n    tags:\n      - x\n      - y\n      - z\n    meta:\n      a: ' + i + '\n      b: null\n      c: str\n';
        const xmlRec = i => '  <users>\n    <id>' + i + '</id>\n    <name>user_' + i + '</name>\n    <email>user' + i + '@example.com</email>\n    <active>' + (i % 2 === 0) + '</active>\n    <score>' + i * 1.5 +
          '</score>\n    <tags>x</tags>\n    <tags>y</tags>\n    <tags>z</tags>\n    <meta>\n      <a>' + i + '</a>\n      <b/>\n      <c>str</c>\n    </meta>\n  </users>\n';
        const build = (head, rec, tail, size) => { const parts = [head]; let len = head.length, n = 0; while (len < size) { const s = rec(n++); parts.push(s); len += s.length; } parts.push(tail); return { text: parts.join(''), n }; };
        const timeParse = async text => { const t0 = performance.now(); jv.setText(text); await jv.whenIdle(); return Math.round(performance.now() - t0); };
        const rootRows = () => [...document.querySelectorAll('#treeLayer .tn')].map(e => e.textContent).join(',');
        let d = build('users:\n', yamlRec, '', target);
        out.yaml = { mb: (d.text.length / 1048576).toFixed(1), n: d.n, ms: await timeParse(d.text), rows: rootRows() };
        d = build('<root>\n', xmlRec, '</root>\n', target);
        out.xml = { mb: (d.text.length / 1048576).toFixed(1), n: d.n, ms: await timeParse(d.text), rows: rootRows() };
        const arr = []; let len = 0;
        for (let i = 0; len < 4 * 1048576; i++) { const r = { id: i, name: 'user_' + i, email: 'user' + i + '@example.com', active: i % 2 === 0, score: i * 1.5, tags: ['x', 'y', 'z'], meta: { a: i, b: null, c: 'str' } }; arr.push(r); len += JSON.stringify(r).length + 1; }
        const js = JSON.stringify({ users: arr });
        jv.setText(js);
        const t0 = performance.now(); await jv.showTab('convert'); await jv.whenIdle();
        const ed = document.querySelector('#convEdit .cm-editor'), txt = window.CM.EditorView.findFromDOM(ed).state.doc.toString();
        out.conv = { mb: (js.length / 1048576).toFixed(1), ms: Math.round(performance.now() - t0), target: document.querySelector('#convTargets button.on').textContent, head: txt.slice(0, 17), outMb: (txt.length / 1048576).toFixed(1) };
        await jv.showTab('tree');
        jv.setText('{"done": true}');
        return out;
      });
      check('YAML 解析 ' + pf.yaml.mb + 'MB（' + pf.yaml.n + ' 条）< 3s', pf.yaml.ms < 3000 && pf.yaml.rows === 'YAML,users', pf.yaml.ms + 'ms ' + pf.yaml.rows);
      check('XML 解析 ' + pf.xml.mb + 'MB（' + pf.xml.n + ' 条）< 3s', pf.xml.ms < 3000 && pf.xml.rows === 'XML,root', pf.xml.ms + 'ms ' + pf.xml.rows);
      check('JSON ' + pf.conv.mb + 'MB 转 YAML（' + pf.conv.outMb + 'MB）< 3s', pf.conv.ms < 3000 && pf.conv.target === 'YAML' && pf.conv.head === 'users:\n  - id: 0\n', pf.conv.ms + 'ms ' + JSON.stringify(pf.conv.head));
    }

    // ---------- 移动端布局：≤ 800px 单栏 + 顶部切换栏 ----------
    {
      console.log('移动端布局');
      const raf2 = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await page.reload({ waitUntil: 'networkidle0' });
      // 元素可见：offsetParent 非 null 且有尺寸
      const vis = sel => page.$eval(sel, e => e.offsetParent !== null && e.getBoundingClientRect().width > 0);
      let m = await page.evaluate(() => {
        const bar = document.getElementById('paneBar'), tops = [...bar.querySelectorAll('button')].map(b => b.offsetTop);
        return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, leftW: document.getElementById('leftPanel').getBoundingClientRect().width, oneLine: new Set(tops).size === 1 && tops.length === 3 };
      });
      check('窄屏无横向溢出', m.sw <= m.iw, m.sw + ' <= ' + m.iw);
      check('窄屏显示切换栏且不换行', (await vis('#paneBar')) && m.oneLine);
      check('窄屏默认只显示数据栏且占满宽度', (await vis('#leftPanel')) && Math.abs(m.leftW - m.iw) <= 12 && !(await vis('#treePanel')) && !(await vis('#gridPanel')), m.leftW + ' / ' + m.iw);
      m = await page.evaluate(() => {
        const p = document.getElementById('leftPanel');
        p.style.width = '700px'; p.style.flexBasis = '700px';   // 模拟桌面上拖过分割条后写入的内联宽度
        const w = p.getBoundingClientRect().width, ok = document.documentElement.scrollWidth <= window.innerWidth;
        p.style.width = ''; p.style.flexBasis = '';
        return { w, iw: window.innerWidth, ok };
      });
      check('窄屏下分割条写入的内联宽度被覆盖', Math.abs(m.w - m.iw) <= 12 && m.ok, m.w + ' / ' + m.iw);

      await page.evaluate(s => window.jsonviewer.setText(s), sample);
      await page.evaluate(() => window.jsonviewer.showPane('center'));
      await raf2();
      m = await page.evaluate(() => {
        const first = document.querySelector('#treeLayer .tn'), r = first ? first.getBoundingClientRect() : null;
        return { n: document.querySelectorAll('#treeLayer .tn').length, top: r ? r.top : -1, bottom: r ? r.bottom : -1, ih: window.innerHeight, sel: document.querySelector('#paneBar .on').getAttribute('data-pane') };
      });
      check('切到视图栏：树可见、数据栏隐藏', (await vis('#treePanel')) && !(await vis('#leftPanel')) && m.sel === 'center');
      check('视图栏树有行且首行在视口内', m.n > 0 && m.top >= 0 && m.bottom <= m.ih, m.n + ' 行, top=' + m.top);
      await page.click('#tabConvert'); await page.evaluate(() => window.jsonviewer.whenIdle()); await raf2();
      m = await page.$eval('.conv-toolbar', e => ({ sw: e.scrollWidth, cw: e.clientWidth }));
      check('窄屏转换工具栏不溢出（允许换行）', m.cw > 0 && m.sw <= m.cw, m.sw + ' <= ' + m.cw);
      m = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      check('转换标签下仍无横向溢出', m);
      await page.click('#tabTree'); await raf2();

      await page.evaluate(() => window.jsonviewer.showPane('right'));
      check('切到属性栏：属性表有行', (await vis('#gridPanel')) && !(await vis('#treePanel')) && (await page.$$eval('#gridRows tr', trs => trs.length)) > 0);
      await page.evaluate(() => window.jsonviewer.showPane('left'));
      await raf2();
      m = await page.evaluate(() => { const c = document.querySelector('#edit .cm-content'); return c ? c.getBoundingClientRect().width : 0; });
      check('切回数据栏：编辑器可见且有宽度', (await vis('#edit .cm-editor')) && m > 0, m);

      // 退出窄屏：三栏都显示、切换栏隐藏、树按真实高度重新渲染（树栏隐藏时重新解析，只按 0 高度渲染了部分行）
      await page.evaluate(s => window.jsonviewer.setText(s), sample);
      await page.setViewport({ width: 1400, height: 800 });
      await raf2();
      m = await page.evaluate(() => {
        const b = document.getElementById('treeBody');
        return { n: document.querySelectorAll('#treeLayer .tn').length, h: b.clientHeight };
      });
      check('恢复桌面宽度：三栏可见、切换栏隐藏', (await vis('#leftPanel')) && (await vis('#treePanel')) && (await vis('#gridPanel')) && !(await vis('#paneBar')));
      check('恢复桌面宽度：树按真实高度重绘全部第一层', m.n === 11 && m.h > 0, m.n + ' 行, 高 ' + m.h);
    }

    const me = await page.evaluate(() => fetch('api/me').then(r => r.text()));
    check('未启用登录验证：/api/me 返回 {"auth":false}，用户菜单隐藏', JSON.stringify(JSON.parse(me)) === '{"auth":false}' && (await page.$eval('#userMenu', e => e.hidden)), me.trim());
    check('无页面错误', errors.length === 0, errors.join(' | '));

    await authSuite(browser);
  } finally {
    await browser.close();
    srv.kill('SIGTERM');
  }
  console.log(failures ? '\n失败 ' + failures + ' 项' : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
