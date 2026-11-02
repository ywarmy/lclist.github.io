/* 个人台账 SPA —— 复用 serve.mjs 内置 mock API（/api/product*、/api/holding*）
 * 路由：/assets-center 总览 | /trade-center/product?holdingId=&action=add 交易页 | /holding-assets | /profit-product
 * 兼容两种持仓结构：面板原生 {holdingId,productId,productName,trades内嵌} 与精简 {id,code,...}
 * 无构建、无外部依赖（CSP: script-src 'self'） */
"use strict";
const $ = (s, el) => (el || document).querySelector(s);
const app = $("#app");
const fmtN = (v, d) => (v == null || isNaN(v) ? "--" : Number(v).toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmt2 = (v) => fmtN(v, 2);
const pct = (v) => (v == null || isNaN(v) ? "--" : (v > 0 ? "+" : "") + (v * 100).toFixed(2) + "%");
const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
const today = () => new Date().toISOString().slice(0, 10);
const nowMs = () => Date.now();

/* ---------- 数据层 ---------- */
async function api(path, opt) {
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || "HTTP " + r.status), { body: j });
  return j;
}
let HOLDINGS = null;   // 原始对象数组（保留面板原生字段，原地更新）
async function loadHoldings() {
  const j = await api("/api/holding-backup");
  HOLDINGS = Array.isArray(j.holdings) ? j.holdings : [];
  // 补齐归一视图 + 解析缺 code 的（用 productId 反查）
  for (const h of HOLDINGS) {
    h._id = h.holdingId || h.id;
    h._pid = h.productId || null;
    h._code = h.code || null;
    h._name = h.productName || h.name || "";
    h._bank = h.agencyName || h.bank || "";
    h._trades = Array.isArray(h.trades) ? h.trades : [];
  }
  await Promise.all(HOLDINGS.filter((h) => !h._code && h._pid).map(async (h) => {
    try { const m = await api("/api/product/" + h._pid); h._code = m.sale_code; h._name = h._name || m.product_name; h._bank = h._bank || m.agency_name || ""; } catch (e) {}
  }));
}
async function saveHoldings() {
  for (const h of HOLDINGS) { h.updatedAt = nowMs(); h.trades = h._trades; }
  await api("/api/holding", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ holdings: HOLDINGS }) });
}
async function products(q) {
  return (await api("/api/products/latest?limit=500" + (q ? "&productName=" + encodeURIComponent(q) : ""))) || [];
}
async function productMeta(key) { return api("/api/product/" + encodeURIComponent(key)); }         // 接受 pid 或 code
async function productHistory(key, days) { return api("/api/product/" + encodeURIComponent(key) + "/history" + (days ? "?days=" + days : "")); }

function holdingOf(hid) { return HOLDINGS.find((h) => h._id === hid); }
function posOf(h) {
  const complete = h.amount > 0 && h.buyNav > 0;
  let shares = complete ? h.amount / h.buyNav : 0, cost = complete ? h.amount : 0;
  for (const t of h._trades) {
    if (t.type === "add") { shares += t.amount / t.nav; cost += t.amount; }
    else { const cut = Math.min(shares, t.shares); cost -= (cost * cut) / (shares || 1); shares -= cut; }
  }
  const latestNav = h._nav != null ? h._nav : (complete ? h.buyNav : null);
  const value = shares * (latestNav || 0);
  const pnl = value - cost;
  return { complete, shares, cost, value, pnl, pnlRate: cost > 0 ? pnl / cost : 0, latestNav, latestDate: h._navDate };
}
async function attachNav(h) {
  if (h._nav != null) return;
  const key = h._code || h._pid;
  if (!key) { h._nav = null; return; }
  try { const m = await productMeta(key); h._nav = m.nav; h._navDate = m.nav_date; } catch (e) { h._nav = null; }
}
const toast = (msg) => { const d = document.createElement("div"); d.className = "toast"; d.textContent = msg; document.body.appendChild(d); setTimeout(() => d.remove(), 2200); };

/* ---------- 弹窗 ---------- */
function dlg(html) { $("#dlgBox").innerHTML = html; $("#dlg").classList.remove("hidden"); }
function closeDlg() { $("#dlg").classList.add("hidden"); }
$("#dlg").addEventListener("click", (e) => { if (e.target.id === "dlg") closeDlg(); });

/* ---------- 添加新持仓 ---------- */
function addHoldingDlg(pre) {
  let picked = null;
  dlg(`<h3>添加持仓</h3>
    <div class="field"><label>搜索产品（名称/代码）</label><input id="fq" placeholder="输入代码或名称关键字" value="${pre && pre.productId ? pre.productId : ""}">
      <div class="searchlist hidden" id="flist"></div></div>
    <div id="fPick" class="muted">${pre && pre.productId ? "正在查询 " + pre.productId : "未选择产品"}</div>
    <div class="row">
      <div class="field"><label>买入本金（元）</label><input id="fAmt" type="number" placeholder="100000"></div>
      <div class="field"><label>买入净值</label><input id="fNav" type="number" step="0.0001" placeholder="自动填最新净值"></div>
    </div>
    <div class="row">
      <div class="field"><label>买入日期</label><input id="fDate" type="date" value="${today()}"></div>
      <div class="field"><label>备注</label><input id="fNote" placeholder="可选"></div>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px">
      <button class="btn" data-act="close">取消</button>
      <button class="btn p" id="fSave">保存</button></div>`);
  const list = $("#flist"), q = $("#fq");
  let timer;
  q.oninput = () => { clearTimeout(timer); timer = setTimeout(async () => {
    const kw = q.value.trim(); if (!kw) { list.classList.add("hidden"); return; }
    const ps = await products(kw); list.innerHTML = ps.slice(0, 30).map((p) =>
      `<div data-c="${p.sale_code}" data-n="${p.product_name}" data-nav="${p.nav ?? ""}" data-pid="${p.product_id}" data-b="${p.agency_name || ""}">${p.product_name} <span class="muted">${p.sale_code} · ${p.agency_name || ""}</span></div>`).join("") || '<div class="muted">无匹配</div>';
    list.classList.remove("hidden");
  }, 250); };
  list.onclick = (e) => {
    const d = e.target.closest("[data-c]"); if (!d) return;
    picked = { code: d.dataset.c, pid: d.dataset.pid, name: d.dataset.n, nav: d.dataset.nav, bank: d.dataset.b };
    $("#fPick").innerHTML = `已选：<b>${picked.name}</b> <span class="pill">${picked.code}</span>`;
    if (picked.nav) $("#fNav").value = picked.nav;
    list.classList.add("hidden");
  };
  if (pre && pre.productId) q.oninput();
  $("#fSave").onclick = async () => {
    if (!picked) return toast("请先选择产品");
    const amount = Number($("#fAmt").value), buyNav = Number($("#fNav").value);
    if (!(amount > 0) || !(buyNav > 0)) return toast("本金与净值必填且需大于 0");
    HOLDINGS.push({
      holdingId: "holding_" + picked.pid + "_" + nowMs(), productId: picked.pid, productName: picked.name,
      agencyName: picked.bank, amount, buyNav, buyDate: $("#fDate").value, note: $("#fNote").value,
      trades: [], createdAt: nowMs(),
      _id: null, _pid: picked.pid, _code: picked.code, _name: picked.name, _bank: picked.bank, _trades: [],
    });
    const h = HOLDINGS[HOLDINGS.length - 1]; h._id = h.holdingId;
    await saveHoldings(); closeDlg(); toast("已添加"); route();
  };
}

/* ---------- 完善既有持仓（面板建的空仓：缺金额/净值） ---------- */
function completeDlg(hid) {
  const h = holdingOf(hid); if (!h) return;
  dlg(`<h3>完善持仓信息</h3><div class="muted" style="margin-bottom:8px">${h._name} <span class="pill">${h._code || h._pid}</span></div>
    <div class="row">
      <div class="field"><label>买入本金（元）</label><input id="cAmt" type="number" value="${h.amount || ""}"></div>
      <div class="field"><label>买入净值</label><input id="cNav" type="number" step="0.0001" value="${h._nav || h.buyNav || ""}" placeholder="正在获取最新净值…"></div>
    </div>
    <div class="field"><label>买入日期</label><input id="cDate" type="date" value="${h.buyDate || today()}"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn" data-act="close">取消</button>
      <button class="btn p" id="cSave">保存</button></div>`);
  // 打开时主动拉最新净值回填（交易页/面板链路进来时 h._nav 可能尚未加载）
  const navInput = $("#cNav");
  if (!(Number(navInput.value) > 0)) {
    const key = h._code || h._pid;
    if (key) productMeta(key).then((m) => {
      if (m && m.nav > 0 && !(Number(navInput.value) > 0)) { h._nav = m.nav; h._navDate = m.nav_date; navInput.value = m.nav; }
      else if (!m || !(m.nav > 0)) navInput.placeholder = "该产品暂无净值，请手动填写";
    }).catch(() => { navInput.placeholder = "净值获取失败，请手动填写"; });
  }
  $("#cSave").onclick = async () => {
    const amount = Number($("#cAmt").value), buyNav = Number($("#cNav").value);
    if (!(amount > 0) || !(buyNav > 0)) return toast("本金与净值必填");
    h.amount = amount; h.buyNav = buyNav; h.buyDate = $("#cDate").value;
    await saveHoldings(); closeDlg(); toast("已完善"); route();
  };
}

/* ---------- 加仓 / 减仓 ---------- */
function tradeDlg(hid, type) {
  const h = holdingOf(hid); if (!h) return toast("持仓不存在");
  if (!h.amount) return completeDlg(hid);
  const pos = posOf(h);
  dlg(`<h3>${type === "add" ? "加仓" : "减仓"} · ${h._name}</h3>
    <div class="kv"><span class="k">当前份额</span><span>${fmt2(pos.shares)}</span>
    <span class="k">当前成本</span><span>${fmt2(pos.cost)} 元</span>
    <span class="k">最新净值</span><span>${fmtN(pos.latestNav, 4)}（${pos.latestDate || "--"}）</span></div>
    <div class="row">
      <div class="field"><label>${type === "add" ? "投入金额（元）" : "赎回份额"}</label><input id="tAmt" type="number" step="0.01"></div>
      <div class="field"><label>成交净值</label><input id="tNav" type="number" step="0.0001" value="${pos.latestNav || ""}"></div>
    </div>
    <div class="field"><label>日期</label><input id="tDate" type="date" value="${today()}"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn" data-act="close">取消</button>
      <button class="btn p" id="tSave">确认</button></div>`);
  $("#tSave").onclick = async () => {
    const amount = Number($("#tAmt").value), nav = Number($("#tNav").value);
    if (!(amount > 0) || !(nav > 0)) return toast("金额/净值必填");
    if (type === "add") h._trades.push({ type, amount, nav, date: $("#tDate").value });
    else h._trades.push({ type, shares: amount, amount: amount * nav, nav, date: $("#tDate").value });
    await saveHoldings(); closeDlg(); toast("已记录"); route();
  };
}

async function delHolding(hid) {
  const h = holdingOf(hid); if (!h) return;
  if (!confirm(`删除持仓「${h._name || h._code}」及其全部交易记录？`)) return;
  HOLDINGS = HOLDINGS.filter((x) => x._id !== hid);
  await saveHoldings(); toast("已删除"); route();
}

/* ---------- 页面：台账总览 ---------- */
async function pageAssets(q) {
  if (!HOLDINGS) await loadHoldings();
  await Promise.all(HOLDINGS.map(attachNav));
  const poses = HOLDINGS.map((h) => ({ h, p: posOf(h) }));
  const done = poses.filter(({ p }) => p.complete);
  const sum = done.reduce((a, { p }) => (a.cost += p.cost, a.value += p.value, a), { cost: 0, value: 0 });
  const pnl = sum.value - sum.cost;
  const qkw = (q || "").toLowerCase();
  const rows = poses.filter(({ h }) => !qkw || (h._name + (h._code || "")).toLowerCase().includes(qkw));
  app.innerHTML = `
    <div class="cards">
      <div class="card"><div class="l">总投入成本</div><div class="v">${fmt2(sum.cost)}</div></div>
      <div class="card"><div class="l">当前市值</div><div class="v">${fmt2(sum.value)}</div></div>
      <div class="card"><div class="l">持仓收益</div><div class="v ${cls(pnl)}">${fmt2(pnl)}（${pct(sum.cost ? pnl / sum.cost : 0)}）</div></div>
      <div class="card"><div class="l">持仓笔数</div><div class="v">${poses.length}${poses.length !== done.length ? ` <span class="muted" style="font-size:12px">（${poses.length - done.length} 笔待完善）</span>` : ""}</div></div>
    </div>
    <div class="toolbar">
      <input id="qk" placeholder="搜索名称/代码" value="${q || ""}" style="width:220px">
      <button class="btn p" id="btnAdd">＋ 添加持仓</button>
      <span class="muted">数据落盘 台账数据.json · 净值取自本地净值库</span></div>
    ${rows.length ? `<table><thead><tr><th>产品</th><th>渠道</th><th>买入日</th><th>买入净值</th><th>最新净值</th><th>份额</th><th>成本</th><th>市值</th><th>收益</th><th>操作</th></tr></thead><tbody>
      ${rows.map(({ h, p }) => `<tr>
        <td><a href="/trade-center/product?holdingId=${h._id}" style="color:var(--blue);text-decoration:none">${h._name || h._code}</a> ${h._code ? `<span class="pill">${h._code}</span>` : ""}${h.note ? `<div class="muted">${h.note}</div>` : ""}</td>
        <td class="muted">${h._bank || ""}</td><td>${h.buyDate || "--"}</td><td>${fmtN(h.buyNav, 4)}</td>
        <td>${fmtN(p.latestNav, 4)}<div class="muted">${p.latestDate || ""}</div></td>
        <td>${p.complete ? fmt2(p.shares) : '<span class="muted">待完善</span>'}</td><td>${p.complete ? fmt2(p.cost) : "--"}</td><td>${p.complete ? fmt2(p.value) : "--"}</td>
        <td class="${cls(p.pnl)}">${p.complete ? fmt2(p.pnl) + "<div>" + pct(p.pnlRate) + "</div>" : '<button class="btn sm p" data-act="complete" data-id="' + h._id + '">完善</button>'}</td>
        <td>${p.complete ? `<button class="btn sm" data-act="add" data-id="${h._id}">加仓</button>
            <button class="btn sm" data-act="reduce" data-id="${h._id}">减仓</button>` : ""}
            <button class="btn sm d" data-act="del" data-id="${h._id}">删</button></td></tr>`).join("")}
      </tbody></table>` : `<div class="empty">还没有持仓 —— 点「＋ 添加持仓」从本地净值库选产品建仓</div>`}`;
  $("#btnAdd").onclick = () => addHoldingDlg(null);
  $("#qk").onchange = () => { location.href = "/assets-center" + ($("#qk").value ? "?q=" + encodeURIComponent($("#qk").value) : ""); };
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.dataset.r === "assets"));
}

/* ---------- 页面：产品交易页 ---------- */
function sparkline(points) {
  if (!points || points.length < 2) return "";
  const w = 600, h = 110, pad = 4;
  const vs = points.map((p) => p.nav), mn = Math.min(...vs), mx = Math.max(...vs), rg = mx - mn || 1;
  const xy = (p, i) => `${pad + (i / (points.length - 1)) * (w - 2 * pad)},${h - pad - ((p.nav - mn) / rg) * (h - 2 * pad)}`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <polyline fill="none" stroke="var(--blue)" stroke-width="1.6" points="${points.map(xy).join(" ")}"/>
    <text x="${w - 4}" y="12" text-anchor="end" font-size="11" fill="var(--sub)">高 ${mx.toFixed(4)} · 低 ${mn.toFixed(4)}</text></svg>`;
}
async function pageTrade(params) {
  if (!HOLDINGS) await loadHoldings();
  const hid = params.get("holdingId");
  const key = hid ? hid.split("_")[1] : (params.get("productId") || params.get("code"));
  let meta; try { meta = await productMeta(key); } catch (e) {
    app.innerHTML = `<div class="empty">未找到产品（${key}）<br><span class="muted">${e.message}</span></div>`; return;
  }
  const h = hid ? holdingOf(hid) : HOLDINGS.find((x) => (x._code || x._pid) == meta.sale_code);
  const hist = await productHistory(meta.sale_code, 120).catch(() => []);
  const pos = h ? posOf(h) : null;
  app.innerHTML = `
    <div class="toolbar"><a class="btn" href="/assets-center">← 返回台账</a></div>
    <div class="card" style="margin-bottom:12px">
      <h3>${meta.product_name || meta.sale_code}</h3>
      <div class="kv">
        <span class="k">代码 / 渠道</span><span>${meta.sale_code} · ${meta.agency_name || meta.manager_org || "--"}</span>
        <span class="k">最新净值</span><span><b>${fmtN(meta.nav, 4)}</b>（${meta.nav_date || "--"}）</span>
        <span class="k">风险 / 期限</span><span>${meta.risk_level || "--"} · ${meta.term ? meta.term + " 天" : "--"}</span>
        <span class="k">成立日</span><span>${meta.establish_date || "--"}</span>
        <span class="k">业绩基准</span><span>${meta.benchmark || "--"}</span></div>
      ${sparkline(hist)}
    </div>
    ${h ? (pos.complete ? `
      <div class="cards">
        <div class="card"><div class="l">持有份额</div><div class="v">${fmt2(pos.shares)}</div></div>
        <div class="card"><div class="l">投入成本</div><div class="v">${fmt2(pos.cost)}</div></div>
        <div class="card"><div class="l">当前市值</div><div class="v">${fmt2(pos.value)}</div></div>
        <div class="card"><div class="l">持仓收益</div><div class="v ${cls(pos.pnl)}">${fmt2(pos.pnl)}（${pct(pos.pnlRate)}）</div></div></div>
      <div class="toolbar">
        <button class="btn p" data-act="add" data-id="${h._id}">＋ 加仓</button>
        <button class="btn" data-act="reduce" data-id="${h._id}">－ 减仓</button></div>
      ${h._trades.length ? `<table><thead><tr><th>日期</th><th>类型</th><th>金额</th><th>净值</th><th>份额</th></tr></thead><tbody>
        ${h._trades.map((t) => `<tr><td>${t.date}</td><td>${t.type === "add" ? "加仓" : "减仓"}</td><td>${fmt2(t.amount)}</td><td>${fmtN(t.nav, 4)}</td><td>${fmt2(t.type === "add" ? t.amount / t.nav : t.shares)}</td></tr>`).join("")}</tbody></table>`
        : '<div class="muted">暂无交易记录</div>'}` : `
      <div class="toolbar"><button class="btn p" data-act="complete" data-id="${h._id}">完善持仓信息（本金/净值）</button>
        <span class="muted">这笔持仓由面板创建，还缺买入本金与净值</span></div>`)
      : `<div class="toolbar"><button class="btn p" id="btnHold">建立该产品持仓</button>
         <span class="muted">当前台账没有这只产品的持仓</span></div>`}`;
  const bh = $("#btnHold");
  if (bh) bh.onclick = async () => {
    if (!(meta.nav > 0)) return toast("该产品暂无净值，无法建仓");
    const amount = Number(prompt("买入本金（元）", "100000")); if (!(amount > 0)) return;
    const nh = { holdingId: "holding_" + meta.product_id + "_" + nowMs(), productId: String(meta.product_id), productName: meta.product_name, agencyName: meta.agency_name || "", amount, buyNav: meta.nav, buyDate: today(), trades: [], createdAt: nowMs(),
      _id: null, _pid: String(meta.product_id), _code: meta.sale_code, _name: meta.product_name, _bank: meta.agency_name || "", _trades: [] };
    nh._id = nh.holdingId; HOLDINGS.push(nh);
    await saveHoldings(); toast("已建仓"); route();
  };
  document.querySelectorAll("nav a").forEach((a) => a.classList.remove("on"));
  if (params.get("action") === "add" && h) { pos && pos.complete ? tradeDlg(h._id, "add") : completeDlg(h._id); }
}

/* ---------- 页面：持仓资产（按渠道分组） ---------- */
async function pageHold() {
  if (!HOLDINGS) await loadHoldings();
  await Promise.all(HOLDINGS.map(attachNav));
  const byBank = {};
  for (const h of HOLDINGS) {
    const p = posOf(h); if (!p.complete) continue;
    const b = h._bank || "未分组";
    (byBank[b] = byBank[b] || { cost: 0, value: 0, n: 0 });
    byBank[b].cost += p.cost; byBank[b].value += p.value; byBank[b].n++;
  }
  app.innerHTML = `<h3 style="margin-bottom:10px">持仓资产 · 按渠道</h3>` +
    (Object.keys(byBank).length ? `<table><thead><tr><th>渠道</th><th>笔数</th><th>成本</th><th>市值</th><th>收益</th><th>收益率</th></tr></thead><tbody>
      ${Object.entries(byBank).map(([b, v]) => { const pnl = v.value - v.cost; return `<tr><td>${b}</td><td>${v.n}</td><td>${fmt2(v.cost)}</td><td>${fmt2(v.value)}</td><td class="${cls(pnl)}">${fmt2(pnl)}</td><td class="${cls(pnl)}">${pct(v.cost ? pnl / v.cost : 0)}</td></tr>`; }).join("")}
      </tbody></table>` : '<div class="empty">暂无已完善持仓</div>');
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.dataset.r === "hold"));
}

/* ---------- 页面：产品收益 ---------- */
async function pageProfit() {
  if (!HOLDINGS) await loadHoldings();
  await Promise.all(HOLDINGS.map(attachNav));
  const rows = [];
  for (const h of HOLDINGS) {
    const pos = posOf(h); if (!pos.complete) continue;
    let d7 = null, d30 = null;
    try {
      const hist = await productHistory(h._code || h._pid, 30);
      if (hist.length) {
        const last = hist[hist.length - 1].nav;
        const at = (n) => hist[Math.max(0, hist.length - 1 - n)] || hist[0];
        if (at(7).nav > 0) d7 = last / at(7).nav - 1;
        if (hist[0].nav > 0) d30 = last / hist[0].nav - 1;
      }
    } catch (e) {}
    rows.push({ h, pos, d7, d30 });
  }
  rows.sort((a, b) => (b.pos.pnlRate || 0) - (a.pos.pnlRate || 0));
  app.innerHTML = `<h3 style="margin-bottom:10px">产品收益排行（持仓收益 + 近期净值区间涨幅）</h3>` +
    (rows.length ? `<table><thead><tr><th>产品</th><th>持仓收益率</th><th>持仓收益</th><th>近7日</th><th>近30日</th><th>最新净值</th></tr></thead><tbody>
      ${rows.map(({ h, pos, d7, d30 }) => `<tr><td><a href="/trade-center/product?holdingId=${h._id}" style="color:var(--blue);text-decoration:none">${h._name || h._code}</a></td>
        <td class="${cls(pos.pnl)}">${pct(pos.pnlRate)}</td><td class="${cls(pos.pnl)}">${fmt2(pos.pnl)}</td>
        <td class="${cls(d7)}">${pct(d7)}</td><td class="${cls(d30)}">${pct(d30)}</td>
        <td>${fmtN(pos.latestNav, 4)}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">暂无已完善持仓</div>');
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.dataset.r === "profit"));
}

/* ---------- 路由 ---------- */
async function route() {
  const u = new URL(location.href);
  const p = u.pathname.replace(/\/+$/, "") || "/assets-center";
  const q = u.searchParams;
  $("#hdrSub").textContent = " · " + today();
  try {
    if (p === "/assets-center") await pageAssets(q.get("q") || "");
    else if (p === "/trade-center" || p.startsWith("/trade-center/")) await pageTrade(q);
    else if (p === "/holding-assets") await pageHold();
    else if (p === "/profit-product") await pageProfit();
    else app.innerHTML = '<div class="empty">未知页面</div>';
  } catch (e) { app.innerHTML = `<div class="empty">加载失败：${e.message}</div>`; }
}
/* 事件委托：CSP 禁内联 onclick，全部 data-act 分发 */
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act, id = b.dataset.id;
  if (act === "close") closeDlg();
  else if (act === "complete") completeDlg(id);
  else if (act === "add") tradeDlg(id, "add");
  else if (act === "reduce") tradeDlg(id, "reduce");
  else if (act === "del") delHolding(id);
});
window.addEventListener("popstate", route);
route();
window.closeDlg = closeDlg; window.tradeDlg = tradeDlg; window.delHolding = delHolding; window.completeDlg = completeDlg;
