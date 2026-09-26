/*
 * 端到端测试：启动已编译的 ./jsonviewer，用本机 Chrome（puppeteer-core）跑功能与大 JSON 性能检查。
 * 用法：make build && npm install && npm run test:e2e
 * 环境变量：CHROME=/path/to/chrome（默认 /usr/bin/google-chrome）、BIG=200000（大 JSON 记录数，0 跳过性能测试）
 * 另起一个启用登录验证（auth = true）的实例，在独立的 BrowserContext 中测试初始设置、登录、用户菜单与用户管理。
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
  fs.writeFileSync(conf, 'auth = true\nusers_file = ' + path.join(tmp, 'users.json') + '\nlisten = 127.0.0.1:' + port + '\n');
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
    // 纯文本 403 页没有 <link rel=icon>，Chrome 会自动请求 /favicon.ico（404），同样不算
    page.on('console', m => {
      if (m.type() !== 'error' || EXPECTED_HTTP_ERR.test(m.text()) || /\/favicon\.ico$/.test((m.location() || {}).url || '')) return;
      errors.push('console: ' + m.text());
    });
    const base = 'http://127.0.0.1:' + port;
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

    // 3. 已设置后 /setup 不再可用
    await page.goto(base + '/setup', { waitUntil: 'networkidle0' });
    check('再次访问 /setup 被重定向', where() !== '/setup', where());

    // 4. 修改密码
    await page.goto(base + '/account', { waitUntil: 'networkidle0' });
    let res = await submitForm(page, 'form.auth-form', { current: 'wrong-pass', password: 'adminpass2', confirm: 'adminpass2' });
    let msg = await page.$eval('.auth-msg', e => e.className + ':' + e.textContent).catch(() => '');
    check('当前密码错误被拒绝', res.status() === 400 && /error:.*当前密码错误/.test(msg), res.status() + ' ' + msg);
    res = await submitForm(page, 'form.auth-form', { current: 'adminpass1', password: 'adminpass2', confirm: 'adminpass2' });
    msg = await page.$eval('.auth-msg', e => e.className + ':' + e.textContent).catch(() => '');
    check('当前密码正确时修改成功', res.status() === 200 && /\bok:/.test(msg), msg);

    // 5. 用户管理：新增 bob；不能删除自己
    await page.goto(base + '/admin/users', { waitUntil: 'networkidle0' });
    await submitForm(page, 'form.auth-inline-form', { username: 'bob', password: 'bobpass1' });
    const names = await page.$$eval('.auth-table tbody tr td:first-child', tds => tds.map(t => t.textContent.trim()));
    check('新增用户 bob 后列表出现 bob', names.some(n => n === 'bob'), names.join(','));
    const selfDel = await page.$$eval('.auth-table tbody tr', trs => trs.filter(tr => /（我）/.test(tr.textContent)).map(tr => !!tr.querySelector('button.danger')));
    const del = await page.evaluate(() => fetch('/admin/users/delete', { method: 'POST', body: new URLSearchParams({ name: 'admin' }) }).then(async r => [r.status, await r.text()]));
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
