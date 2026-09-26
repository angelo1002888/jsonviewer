/*
 * 端到端测试：启动已编译的 ./jsonviewer，用本机 Chrome（puppeteer-core）跑功能与大 JSON 性能检查。
 * 用法：make build && npm install && npm run test:e2e
 * 环境变量：CHROME=/path/to/chrome（默认 /usr/bin/google-chrome）、BIG=200000（大 JSON 记录数，0 跳过性能测试）
 */
const puppeteer = require('puppeteer-core');
const { spawn } = require('child_process');
const net = require('net');
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

(async () => {
  const port = await freePort();
  const srv = spawn(BIN, ['-listen', '127.0.0.1:' + port], { stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', d => process.env.VERBOSE && process.stderr.write(d));
  await sleep(400);
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
    check('无页面错误', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
    srv.kill('SIGTERM');
  }
  console.log(failures ? '\n失败 ' + failures + ' 项' : '\n全部通过');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('FAILED', e); process.exit(1); });
