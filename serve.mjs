#!/usr/bin/env node
/*
 * 理财产品聚焦 —— 本地代理服务器
 *
 * 作用：让 index.html / add.html / manage.html / detail.html 在本地运行时，
 *       也能**实时**抓取银行真实净值与产品信息（含宁波银行），无需部署 Cloudflare Workers。
 *
 * 为什么必须要有它：
 *   各银行披露接口（尤其宁银理财 www.wmbnb.com、宁波银行移动端 e.nbcb.com.cn）都不返回
 *   CORS 头，宁银理财官网还会对不带反爬令牌的裸请求直接返回 403 —— 浏览器直连必被拦截，
 *   只能由本地服务端转发。
 *
 * 抓取逻辑直接复用 src/serverless/worker.js（与线上 Workers 同一份源码），
 * 只把传输层换成 Node 的 test_transport.js（解决部分银行的旧版 TLS 重协商问题）。
 *
 * 运行：
 *   node serve.mjs            # 默认 http://localhost:8766/
 *   node serve.mjs 9000       # 指定端口
 * 然后用浏览器打开 http://localhost:8766/（务必用 http://，不要用 file://，否则无法抓取）。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CACHE_ROOT } from "./deliver/cache_root.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || 8766;

// ---- 产品数据持久化（2026-10-14）----
// 浏览器 localStorage 里的 observer_* 数据（产品目录/精选/候选/净值缓存/运行日志）
// 会自动同步到项目目录下；克隆文件夹或换端口后自动恢复。详见 data-sync.js。
//
// 2026-10-14 起：服务端由「单个 产品数据.json」拆成 3 个文件，按数据性质分家 ——
//   ① 产品数据.json  目录 / 精选 / 候选 / 偏好      ~24 KB   小而常改，缩进 2 空格，可读可 diff
//   ② 净值数据.json  observer_lookup_*              ~561 KB  两个重键，占总量 83%
//   ③ 运行日志.json  observer_refresh_* / fetch_fail ~87 KB  纯抓取调试数据，可随时删
// ⚠ 对外接口（GET/POST /api/state）**形状完全不变**：GET 仍然把所有文件的 data 合并成
//    一个 { data:{...} } 返回，POST 仍然收 { data:{...} }。所以 data-sync.js 一行都不用改，
//    拆分纯属服务端落盘布局调整。（早期配套的「数据迁移.html」迁移辅助页已随旧键一同移除。）
const STATE_PREFIX = "observer_";
const STATE_MAX_BYTES = 64 * 1024 * 1024;
const STATE_KINDS = ["core", "nav", "log"];
const STATE_FILES = {
  core: { file: "产品数据.json", bak: "产品数据.备份.json", label: "产品目录与偏好" },
  nav:  { file: "净值数据.json", bak: "净值数据.备份.json", label: "净值缓存" },
  log:  { file: "运行日志.json", bak: "运行日志.备份.json", label: "运行日志（抓取调试）" },
};

// 键 → 归属文件。先精确匹配已知键，再用前缀兜底，将来新增同族键会自动归位。
// 2026-10-22：observer_lookup_icbc 分桶已废弃（早期给工行独立抓取通道单开的分桶），
// 全部净值统一存 observer_lookup_real。下方 stateBucketOf 的 observer_lookup_ 前缀兜底
// 仍会兜住万一出现的旧键，保证不会误落到 core 文件里。
const NAV_KEYS = ["observer_lookup_real"];
const LOG_KEYS = ["observer_refresh_breakdown", "observer_refresh_at", "observer_refresh_dur", "observer_fetch_fail"];
function stateBucketOf(k) {
  if (NAV_KEYS.indexOf(k) >= 0) return "nav";
  if (LOG_KEYS.indexOf(k) >= 0) return "log";
  if (k.indexOf("observer_lookup_") === 0) return "nav";              // 净值族
  if (k.indexOf("observer_refresh_") === 0) return "log";             // 刷新耗时/时间分解
  if (k.indexOf("observer_fetch_fail") === 0) return "log";
  if (k.indexOf("observer_breakdown_reset") === 0) return "log";
  return "core";                                                      // 其余一律归「产品数据」
}

function statePath(kind) { return path.join(ROOT, STATE_FILES[kind].file); }
function stateBakPath(kind) { return path.join(ROOT, STATE_FILES[kind].bak); }

// ---- 净值总表读取（模块级：启动迁移与 /api 接口共用）----
// 2026-10-22：icbc 分桶已废弃，净值只存 observer_lookup_real 单键。
// 为兼容「旧文件里仍留着 observer_lookup_icbc」的情况，读取时按日期并集并入 real
// （同日期以末点更晚的一侧为准），对外只暴露合并后的单表。
function navLastDate(o) {
  const s = (o && o.series) || [];
  for (let i = s.length - 1; i >= 0; i--) if (s[i] && s[i][0]) return String(s[i][0]);
  return "";
}
function navUnionSeries(a, b, preferB) {
  const m = new Map();
  const first = preferB ? b : a, second = preferB ? a : b;
  for (const p of first || []) if (p && p[0]) m.set(String(p[0]), p);
  for (const p of second || []) if (p && p[0]) m.set(String(p[0]), p);
  return [...m.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map((e) => e[1]);
}
function navMergeEntry(a, b) {
  if (!a) return b;
  if (!b) return a;
  const preferB = navLastDate(b) > navLastDate(a);
  const main = preferB ? b : a, side = preferB ? a : b;
  const out = {};
  for (const k of Object.keys(main)) if (k !== "series") out[k] = main[k];
  for (const k of Object.keys(side)) {
    if (k === "series") continue;
    if (out[k] === undefined || out[k] === null || out[k] === "") out[k] = side[k];
  }
  out.series = navUnionSeries(a.series, b.series, preferB);
  return out;
}
const parseNavValue = (v) => {
  if (typeof v === "string") { try { return JSON.parse(v); } catch (e) { return null; } }
  return v && typeof v === "object" ? v : null;
};
function readNavMap() {
  try {
    const nav = JSON.parse(fs.readFileSync(path.join(ROOT, "净值数据.json"), "utf8"));
    const data = nav.data || {};
    const real = parseNavValue(data.observer_lookup_real) || {};
    const legacy = parseNavValue(data.observer_lookup_icbc);
    if (legacy) for (const c of Object.keys(legacy)) real[c] = navMergeEntry(real[c], legacy[c]);
    return real;
  } catch (e) { return {}; }
}

function readStateFile(kind) {
  try {
    const j = JSON.parse(fs.readFileSync(statePath(kind), "utf8"));
    if (j && j.data && typeof j.data === "object" && !Array.isArray(j.data)) return j;
  } catch (e) { /* 文件不存在或损坏 -> 按空处理 */ }
  return null;
}

// 业绩比较基准剪短（2026-10-29 用户口径）：≤150 字，在接近 150 字的最近句末标点处截断。
// 为什么要在这里做：净值表由浏览器 localStorage 回灌（data-sync.js），若不剪短，
// 下次抓取回来的 400+ 字监管披露原文会再次落盘 → 在窄列里折成 50+ 行 → 把表格行撑到
// 800px+ → 同行「时间分解」格被拉高、内容只占顶部，下方全空白（用户报告的「空白占格」）。
// 原文另存 benchmarkFull，详情抽屉仍可看全文。
const BENCH_MAX = 150;
const BENCH_END = /[。！？；）]/;
function trimBenchmarkText(s) {
  if (typeof s !== "string") return s;
  const t = s.trim();
  if (!t || t.length <= BENCH_MAX) return s;
  let best = -1;
  for (let i = 0; i < Math.min(t.length, BENCH_MAX); i++) if (BENCH_END.test(t[i])) best = i + 1;
  if (best < 0) return t.slice(0, BENCH_MAX) + "…";
  return t.slice(0, best).replace(/\s+$/, "") + "…";
}
// 对 observer_lookup_real 里每条记录的 benchmark 生效（幂等）
function trimBenchmarksInNav(raw) {
  const map = parseNavValue(raw);
  if (!map) return raw;
  let n = 0;
  for (const code of Object.keys(map)) {
    const rec = map[code];
    if (!rec || typeof rec !== "object") continue;
    const b = rec.benchmark;
    if (typeof b !== "string" || !b || b.length <= BENCH_MAX) continue;
    const full = rec.benchmarkFull || b;
    rec.benchmarkFull = full;
    rec.benchmark = trimBenchmarkText(b);
    n++;
  }
  if (n) console.log("[state] 净值表业绩比较基准剪短 " + n + " 条（≤" + BENCH_MAX + " 字）");
  return n ? JSON.stringify(map) : raw;
}

// 原子写 + 上一版留备份。stamp 由调用方统一传入，保证同一次 POST 的 3 个文件时间戳一致
// （否则 data-sync.js 下次加载会认为「文件比本页新」而反复回灌）。
function writeStateFile(kind, data, stamp) {
  const cfg = STATE_FILES[kind];
  const out = {
    savedAt: stamp, port: PORT, kind, label: cfg.label,
    count: Object.keys(data).length, data,
  };
  // 净值表写盘前统一剪短业绩比较基准（见 trimBenchmarksInNav 注释）
  if (kind === "nav" && typeof out.data.observer_lookup_real === "string") {
    out.data.observer_lookup_real = trimBenchmarksInNav(out.data.observer_lookup_real);
  }
  const f = statePath(kind), b = stateBakPath(kind);
  if (fs.existsSync(f)) {
    try { fs.copyFileSync(f, b); } catch (e) { /* 备份失败不阻断主流程 */ }
  }
  const tmp = f + ".tmp";
  // 目录/偏好文件小，缩进 2 空格方便人工查看与 diff；两个大文件保持紧凑省体积
  fs.writeFileSync(tmp, kind === "core" ? JSON.stringify(out, null, 2) : JSON.stringify(out), "utf8");
  fs.renameSync(tmp, f);   // 原子替换，避免写入中断留下半截文件
  return out;
}

// ---- 刷新顺序.xls 自动重建（用户规则 2026-10-13：刷新顺序日志以 .xls 交付，中文不乱码）----
// CSV 仅作内部追加存储（UTF-8 BOM）；每次追加后防抖 3s 调 Python(xlwt) 全量重建 .xls。
// macOS/Linux 走 PATH（python3）；Windows 保留原 workbuddy 内置路径。
// 找不到时 scheduleXlsRebuild 里有兜底（existsSync → python3/python），失败静默不影响主链路。
const PY_XLS =
  process.platform === "win32"
    ? "C:\\Users\\a\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe"
    : "python3";
let _xlsTimer = null;
function scheduleXlsRebuild() {
  if (_xlsTimer) return; // 防抖：3s 内的多次追加只起一次 Python
  _xlsTimer = setTimeout(() => {
    _xlsTimer = null;
    try {
      const py = fs.existsSync(PY_XLS) ? PY_XLS : (process.platform === "win32" ? "python" : "python3");
      spawn(py, [path.join(ROOT, "refresh_log_xls.py")], { cwd: ROOT, stdio: "ignore" })
        .on("error", () => {});
    } catch (e) { /* 静默：日志转换失败不影响抓取主链路 */ }
  }, 3000);
}

// 抓取源码位置：优先用随本目录一起打包的 ./scrape（自包含，整个文件夹可任意拷贝/搬移），
// 缺失时再回退到开发机上的原始 serverless 目录。
const LOCAL_DIR = path.join(ROOT, "scrape");
const FALLBACK_DIR = "F:/a/2026-09-28-19-56-07/src/serverless";
const SERVERLESS_DIR = fs.existsSync(path.join(LOCAL_DIR, "worker.js")) ? LOCAL_DIR : FALLBACK_DIR;
const modUrl = (f) => pathToFileURL(path.join(SERVERLESS_DIR, f)).href;

let nodeTransport;
let W;
try {
  nodeTransport = (await import(modUrl("test_transport.js"))).nodeTransport;
  W = await import(modUrl("worker.js"));
} catch (e) {
  console.error("无法加载抓取模块（" + SERVERLESS_DIR + "）：" + e.message);
  process.exit(1);
}

// 网商说明书解析模块的「按文件改动自动重载」加载器（2026-10-26）。
// 为什么需要：Node 的 ESM 缓存按 URL 生效——同一个 URL 的模块在进程内**只加载一次**，
//   改了 deliver/mybank_manual_lookup.mjs 之后，运行中的 serve.mjs 再 await import() 拿到的
//   仍是旧模块（已实测：改文件后再 import 仍返回旧值，只有加 ?v=2 查询串才会拿到新值）。
//   → 以前改完模块必须重启服务器，否则用户看到的还是旧行为（曾导致「产品名称」修复不生效）。
// 现在用「文件 mtime」当缓存键：文件没变就复用已加载模块（零开销、保持 cookie/JShield 会话），
//   文件一改就带新 mtime 重新 import —— 改完模块下一次请求即生效，不必重启。
const MYBANK_MOD_PATH = path.join(ROOT, "deliver", "mybank_manual_lookup.mjs");
let _mybankMod = null;
let _mybankModStamp = "";
async function loadMybankManualLookup() {
  let stamp = "";
  try { stamp = String(fs.statSync(MYBANK_MOD_PATH).mtimeMs); } catch (e) { stamp = ""; }
  if (!_mybankMod || stamp !== _mybankModStamp) {
    const href = pathToFileURL(MYBANK_MOD_PATH).href + "?mtime=" + stamp;
    const mod = await import(href);
    _mybankMod = mod.mybankManualLookup;
    _mybankModStamp = stamp;
    if (_mybankModStamp) console.log("[mybank-manual] 模块已加载（mtime=" + _mybankModStamp + "）");
  }
  return _mybankMod;
}

// 额度字段逆向探针：QPROBE=1 时 worker 内 dump 各家银行详情接口原始字段（默认关闭，生产不影响）。
if (process.env.QPROBE === "1") {
  globalThis.__QPROBE = true;
  console.log("[qprobe] 已启用：worker 内部将打印 QPROBE:* 原始详情字段");
}

// Phase 4 A/B：NAV_MOCK=1 时启用 mock 数据源（不触真实银行/中国理财网），
// 用于离线确定性验证 /api/product 与前端刷新链路。生产（不带该变量）行为不变。
if (process.env.NAV_MOCK) {
  try {
    const { installNavMock, defaultMock } = await import(new URL("./phase4_fixtures.mjs", import.meta.url).href);
    installNavMock(defaultMock());
    console.log("[mock] NAV_MOCK 已启用：/api/product 返回确定性 mock 数据（不触真实银行）");
  } catch (e) {
    console.error("[mock] 加载失败：" + e.message);
  }
}

// 销售代码 -> 抓取银行顺序预判（Node 版，端口自 predict_银行.py v4）。
// 仅供 /api/predict 使用：前端据此把「查询」改成多银行有序尝试，
// 不再只查下拉框所选的一家。predict 模块加载失败时不致命——前端会回退单银行查询。
let predictBanks = null;
try {
  const pbUrl = pathToFileURL(path.join(ROOT, "predict_bank.js")).href;
  predictBanks = (await import(pbUrl)).default.predictBanks;
  console.log("预判模块已加载：/api/predict 可用");
} catch (e) {
  console.error("预判模块加载失败（/api/predict 将不可用，前端回退单银行查询）：" + e.message);
}

// 银行 key -> 抓取函数（均为 fn(code, { transport }) 形式）
const BANK_FNS = {
  icbc: W.icbcLive,
  boc: W.bocFetch,
  psbc: W.psbcFetch,
  ceb: W.cebFetch,
  abc: W.abcFetch,
  bob: W.bobFetch,
  cmb: W.cmbFetch,
  bosc: W.boscFetch,
  spdb: W.spdbFetch,
  ccb: W.ccbFetch,
  cib: W.cibFetch,
  comm: W.bocomFetch,
  citic: W.citicFetch,
  cgb: W.cgbFetch,
  fminbank: W.fminbankFetch,
  nbcb: W.nbcbFetch,
  cmbc: W.cmbcFetch,
  jsb: W.jsbFetch,
  pingan: W.pinganFetch,
  dongguan: W.dongguanFetch,
  mybank: W.mybankFetch,
  webank: W.webankFetch,
  nanyin: W.nanyinFetch,
  huaxia: W.huaxiaFetch,
};

// 2026-10-22：清理孤儿 puppeteer 临时 profile。每次无头 Chrome 启动都会在 %TEMP% 生成
// ~85MB 的 puppeteer_dev_chrome_profile-*；serve 重启/会话关闭后不会自动删除，堆积可占满
// 系统盘（实测 52 个 / 3.3GB 曾把 C: 写满，node 直接 ENOSPC）。
// 安全策略：启动时先扫所有 chrome.exe 的 --user-data-dir，只删【无进程占用】的孤儿
// （本机另一 serve 实例预热中的 Chrome 自动跳过）；探测失败则保守不删。
// 时序：本清理 3s 先跑，预热推到 10s 之后，避免删到本实例刚拉起的 Chrome。
setTimeout(() => {
  (async () => {
    let freed = 0, n = 0;
    try {
      const { execSync } = await import("node:child_process");
      const os = await import("node:os");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const live = new Set();
      try {
        const cmd =
          process.platform === "win32"
            ? "powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter \\\"Name='chrome.exe'\\\" | ForEach-Object { $_.CommandLine }\""
            : "ps ax -o command="; // macOS/Linux：一行一进程完整命令行，效果等同
        const ps = execSync(cmd, {
          encoding: "utf8", timeout: 20000,
          ...(process.platform === "win32" ? { windowsHide: true } : {}),
        });
        for (const m of String(ps).matchAll(/--user-data-dir=([^\s"]+)/g)) live.add(path.basename(m[1]));
      } catch (e) { return; } // 探测失败 → 不删
      const temp = os.tmpdir();
      // 2026-10-26：除 puppeteer 外，本项目自产的 jsign-*（JShield 签名器）与 pdfc-*（PDF 渲染）
      // 也是「只 kill Chrome 不删 profile」，各约 200MB —— 实测残留 96 + 317 个、共 12GB，
      // 把系统盘写满 → ENOSPC → 说明书 PDF 下载失败 → 七字段全丢 → 「产品名称」为空、保存被拦。
      // 现已在产出端（deliver/jshield_signer.mjs、deliver/pdf_extract.mjs）改为用完即删，
      // 这里再兜底清历史残留（deliver/.cache、项目根 .cache）+ 新目录（项目外的 网商银行cache）。
      const ORPHAN = /^(puppeteer_dev_chrome_profile-|jsign-|pdfc-)/;
      const roots = [temp, CACHE_ROOT, path.join(ROOT, "deliver", ".cache"), path.join(ROOT, ".cache")];
      for (const root of roots) {
        let ents = [];
        try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { continue; }
        for (const ent of ents) {
          if (!ent.isDirectory() || !ORPHAN.test(ent.name)) continue;
          if (live.has(ent.name)) continue; // 在用（另一 serve 实例的 Chrome）
          const full = path.join(root, ent.name);
          try {
            for (const f of fs.readdirSync(full, { withFileTypes: true, recursive: true })) {
              if (f.isFile()) { try { freed += fs.statSync(path.join(f.parentPath, f.name)).size; } catch (e) {} }
            }
            fs.rmSync(full, { recursive: true, force: true });
            n++;
          } catch (e) { /* 单个删失败不影响其余 */ }
        }
      }
      if (n) console.log(`[cleanup] 已清理 ${n} 个孤儿无头浏览器临时 profile（释放 ${(freed / 1048576).toFixed(0)}MB）`);
    } catch (e) { /* 清理失败不影响服务 */ }
  })();
}, 3000);

// 2026-10-22：江苏银行 App 端口走无头 Chrome（YT 加密库在页面上下文），冷启动 ~13s。
// 启动 10s 后后台预热（拉 Chrome + 种子页；10s 是为上面的孤儿 profile 清理让路，避免竞态），
// 首个江苏产品抓取即命中 ~1.3s 热路径；失败不致命（抓取时仍会自愈重建）。
setTimeout(() => {
  import(new URL("./scrape/jsb_app.mjs", import.meta.url).href)
    .then((m) => m.jsbWarmup())
    .then((ok) => { if (ok) console.log("江苏银行 App 端口预热完成（Chrome + 种子页就绪）"); })
    .catch(() => {});
}, 10000);

// 2026-10-22：北京银行 App 端口无头 Chrome 放行 + 预热（用户要求实测 132040B 抓取耗时）。
// 北银 Chrome 与江苏是各自独立的浏览器实例（sharedBrowser 单例按模块隔离），故单独预热；
// 启动 10s 后后台拉起，冷启 ~10s 挪到开机期，用户刷 132040B 时直接走热路径。
// 失败不致命（bobAppCapture 命中 sharedBrowser() 仍会自愈启动）。
setTimeout(() => {
  import(new URL("./scrape/bob_app.mjs", import.meta.url).href)
    .then((m) => m.bobWarmup())
    .then((ok) => { if (ok) console.log("北京银行 App 端口预热完成（无头 Chrome 就绪）"); })
    .catch(() => {});
}, 10000);

// 2026-10-23：光大官网「历史业绩」静态页端口预热（cebWebNav）。
// 用户实测「刷净值 41.6s / 单产品 38.3s」后定位：①共享会话页并发竞态（已改页面池）
// ②官网无数据产品要烧 10-19s 才判失败（已加「暂无历史业绩数据」快速失败）
// ③浏览器冷启动 + 首开页超时（实测首码 15.6s 失败）→ 本预热把 Chrome + 种子页拉到开机期。
// 光大 Chrome 与江苏/北银各自独立单例，故单独预热。失败不致命（抓取时会自愈重建）。
setTimeout(() => {
  import(new URL("./scrape/ceb_direct_nav.mjs", import.meta.url).href)
    .then((m) => m.cebWebWarmup())
    .then((ok) => { if (ok) console.log("光大银行官网净值端口预热完成（Chrome + 种子页就绪）"); })
    .catch(() => {});
}, 10000);

// 2026-10-31：招银理财官网（www.cmbchinawm.com）端口预热（cmbwm_app.mjs）。
// 该端口必须走无头 Chrome（请求体 SM2 加密，密钥与算法编译在 660KB 混淆 bundle 里，
// 只能在真实页面上下文里调 vm.SmAencrypt 当加密器），且 bundle 加载慢（实测 15~25s）。
// 预热把 Chrome + 页面拉到开机期，用户刷招银产品时直接走热路径（实测热路径 0.5~1.5s）。
// 招银 Chrome 与江苏/北银/光大各自独立单例，故单独预热。失败不致命（抓取时会自愈重建）。
setTimeout(() => {
  import(new URL("./scrape/cmbwm_app.mjs", import.meta.url).href)
    .then((m) => m.cmbwmWarmup())
    .then((ok) => { if (ok) console.log("招银理财官网端口预热完成（Chrome + SmAencrypt 就绪）"); })
    .catch(() => {});
}, 10000);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Length": body.length,
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  let u;
  try {
    u = new URL(req.url, "http://localhost");
  } catch {
    return sendJson(res, 400, { error: "bad url" });
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    return res.end();
  }

  if (u.pathname === "/api/fetch") {
    const bank = (u.searchParams.get("bank") || "").toLowerCase();
    const code = (u.searchParams.get("code") || "").trim().toUpperCase();
    if (!code) return sendJson(res, 400, { error: "missing code" });
    const fn = BANK_FNS[bank];
    if (!fn) return sendJson(res, 404, { error: "unsupported bank", bank });
    let out = null;
    const t0 = Date.now();
    try {
      out = await fn(code, { transport: nodeTransport });
    } catch (e) {
      console.log("[fetch] " + bank + " " + code + " 失败：" + e.message);
      return sendJson(res, 502, { error: "upstream error: " + e.message });
    }
    const ms = Date.now() - t0;
    if (!out) {
      console.log("[fetch] " + bank + " " + code + " -> 未收录 (" + ms + "ms)");
      return sendJson(res, 404, { error: "not found", bank, code });
    }
    const pts = (out.series && out.series.length) || 0;
    console.log("[fetch] " + bank + " " + code + " -> " + (out.name || "(无名)") + " / " + pts + " 点 (" + ms + "ms)");
    return sendJson(res, 200, out);
  }

  if (u.pathname === "/api/meta") {
    // 产品信息补全（成立日期/最短持有天数/风险/登记编码）：
    // 直接复用 Worker 的 fetchMeta（含中国理财网跨库匹配与各行详情接口），
    // 净值不走这里（按需求，净值只从银行/发行方通道取，不消耗中国理财网额度）。
    const bank = (u.searchParams.get("bank") || "").toLowerCase();
    const code = (u.searchParams.get("code") || "").trim().toUpperCase();
    if (!code) return sendJson(res, 400, { error: "missing code" });
    try {
      const meta = await W.fetchMeta(bank, code, nodeTransport);
      if (meta && (meta.risk || meta.established || meta.holdDays != null || meta.name)) {
        return sendJson(res, 200, meta);
      }
      return sendJson(res, 404, { error: "no meta", bank, code });
    } catch (e) {
      return sendJson(res, 500, { error: "meta error: " + e.message });
    }
  }

  if (u.pathname === "/api/predict") {
    // 销售代码 -> 抓取银行顺序预判。前端用返回的顺序做多银行有序查询。
    const code = (u.searchParams.get("code") || "").trim().toUpperCase();
    if (!code) return sendJson(res, 400, { error: "missing code" });
    if (!predictBanks) return sendJson(res, 503, { error: "predict module unavailable" });
    try {
      return sendJson(res, 200, predictBanks(code));
    } catch (e) {
      return sendJson(res, 500, { error: "predict error: " + e.message });
    }
  }

  if (u.pathname === "/api/cgbapp") {
    // 广发银行 App 端口（2026-10-16 打通）：wap.cgbchina.com.cn 的 MDP/H5 网关。
    //   GET /api/cgbapp?code=132112D            按产品代码取七字段（净值走 fn10003 全量分页）
    //   GET /api/cgbapp?flowNo=<分享链flowNo>    按 App 分享链反查产品代码再取
    // 与 /api/product 的 cgb 通道（官网 financing_details.jsp，仅单点净值）互补：
    // 这里能拿全净值序列 + 风险等级 + 最短持有 + 成立日 + 业绩基准。
    // 注：登记编码不从说明书 PDF 解析（用户规则 2026-10-16），需要登记编码请走 /api/meta（中国理财网补齐）。
    const code = (u.searchParams.get("code") || "").trim().toUpperCase();
    const flowNo = (u.searchParams.get("flowNo") || "").trim();
    const shortCode = (u.searchParams.get("shortCode") || "N").trim();
    if (!code && !flowNo) return sendJson(res, 400, { error: "missing code or flowNo" });
    const t0 = Date.now();
    try {
      const { cgbAppFetch } = await import(new URL("./scrape/cgb_app.mjs", import.meta.url).href);
      const out = await cgbAppFetch({ prdCode: code, flowNo, shortCode });
      const ms = Date.now() - t0;
      console.log("[cgbapp] " + (out.prdCode || flowNo) + " 净值=" + out.navCount + " 点 最新=" +
        out.latestNAV + "@" + out.latestNAVDate + " (" + ms + "ms)");
      if (!out.prdCode) return sendJson(res, 404, { error: "flow 未解析出产品代码", flowNo });
      return sendJson(res, 200, out);
    } catch (e) {
      console.log("[cgbapp] 失败：" + e.message + " (" + (Date.now() - t0) + "ms)");
      return sendJson(res, 502, { error: "cgbapp error: " + e.message });
    }
  }

  if (u.pathname === "/api/cebapp") {
    // 光大银行 App 端口（eoap 营销 H5，2026-10-16 打通）：eoap.cebbank.com/uiap/ebdcService。
    //   GET /api/cebapp?code=EW6210A                 按产品代码取（须已登记 accessId）
    //   GET /api/cebapp?link=<微信分享链>              从分享链里抠 accessId，抓完自动把 code→accessId 落盘
    //   GET /api/cebapp?code=EW6210A&accessId=xxx     显式给 accessId（同样会自动落盘）
    //   &period=Y1（默认）/&infoOnly=1（只取产品信息，跳过净值曲线）
    // ⚠ 一个 accessId 只对应一个产品：想抓新产品必须拿到它自己的分享链接。
    // ⚠ 需要本机 Chrome；首次调用冷启约 15s，同 accessId 8 分钟内的后续调用复用会话（约 3s）。
    const code = (u.searchParams.get("code") || "").trim().toUpperCase();
    const link = (u.searchParams.get("link") || "").trim();
    let accessId = (u.searchParams.get("accessId") || "").trim();
    const period = (u.searchParams.get("period") || "Y1").trim();
    const infoOnly = u.searchParams.get("infoOnly") === "1";
    if (!code && !link && !accessId) return sendJson(res, 400, { error: "missing code / link / accessId" });
    const t0 = Date.now();
    try {
      const mod = await import(new URL("./scrape/ceb_eoap.mjs", import.meta.url).href);
      if (!accessId && link) accessId = mod.cebAccessIdOf(link);
      // 只给 code 时，从 code→accessId 登记表里取（一个 accessId 只对应一个产品）
      const accessFile = new URL("./scrape/ceb_eoap_access.json", import.meta.url);
      if (!accessId && code) {
        try { accessId = (JSON.parse(fs.readFileSync(accessFile, "utf8")) || {})[code] || ""; } catch (e) { accessId = ""; }
        if (!accessId) return sendJson(res, 404, { error: "该产品尚未登记分享链 accessId，请用 ?link=<微信分享链> 首次抓取", code });
      }
      const out = await mod.cebEoapFetch({ accessId, proCode: code, period, infoOnly });
      const ms = Date.now() - t0;
      if (!out) return sendJson(res, 502, { error: "ceb eoap 未取到数据（会话/分享链可能已失效）" });
      // 自动登记 code→accessId，方便下次直接按 code 抓
      try {
        let map = {};
        try { map = JSON.parse(fs.readFileSync(accessFile, "utf8")) || {}; } catch (e) { map = {}; }
        if (out.code && out.accessId && map[out.code] !== out.accessId) {
          map[out.code] = out.accessId;
          fs.writeFileSync(accessFile, JSON.stringify(map, null, 2) + "\n");
          console.log("[cebapp] 已登记 " + out.code + " → accessId " + out.accessId);
        }
      } catch (e) { /* 落盘失败不影响返回 */ }
      console.log("[cebapp] " + out.code + " 净值=" + (out.series || []).length + " 点 最新=" +
        (out.netvalueDate || "-") + " (" + ms + "ms)");
      return sendJson(res, 200, out);
    } catch (e) {
      console.log("[cebapp] 失败：" + e.message + " (" + (Date.now() - t0) + "ms)");
      return sendJson(res, 502, { error: "cebapp error: " + e.message });
    }
  }

  if (u.pathname === "/api/bobapp") {
    // 北京银行 App 端口（cdnmobibank 手机银行 H5，SM2/SM4 国密加密，2026-10-17 打通）：
    //   GET /api/bobapp?code=YJ01260316A
    //   GET /api/bobapp?code=YJ01260316A&detailOnly=1   只取详情（成立日/额度/风险/持有/基准），不点时间 tab，约 4-6s
    // 借无头 Chrome 解密拿 净值+信息+额度；仅供本机 Node 调试/单测（worker.js bobFetch 热路径已内置）。
    // ⚠ 需要本机 Chrome；首次冷启约 12s，之后复用浏览器约 2-3s。
    const code = (u.searchParams.get("code") || "").trim().toUpperCase();
    if (!code) return sendJson(res, 400, { error: "missing code" });
    const detailOnly = u.searchParams.get("detailOnly") === "1";
    const t0 = Date.now();
    try {
      const mod = await import(new URL("./scrape/bob_app.mjs", import.meta.url).href);
      const out = await mod.bobAppCapture(code, { detailOnly });
      const ms = Date.now() - t0;
      if (!out) return sendJson(res, 502, { error: "bobapp 未取到数据（Chrome/网络/页面结构可能变化）" });
      console.log("[bobapp] " + out.prdCode + " nav=" + (out.nav || "-") + " quota=" + (out.remainQuota != null ? out.remainQuota : "-") + " (" + ms + "ms)");
      return sendJson(res, 200, out);
    } catch (e) {
      console.log("[bobapp] 失败：" + e.message + " (" + (Date.now() - t0) + "ms)");
      return sendJson(res, 502, { error: "bobapp error: " + e.message });
    }
  }

  if (u.pathname === "/api/abcapp") {
    // 农业银行 App 端口（wx.abchina.com/webank 分享落地页，2026-10-17 打通）：
    //   GET /api/abcapp?code=<分享码>      分享码 = 链接 ?code= 参数，形如 <ACCESSID>_<f产品码>
    //   例：/api/abcapp?code=92d72d55785a42c587ac0b25_fNYJXLD  → NYJXLDKJLH90 匠心灵动90天(科技领航)
    // 借无头 Chrome（移动端 MicroMessenger/iPhone UA）拦截 shareInfo 明文响应拿产品信息。
    // ⚠ 必须传「分享码」而非裸产品代码（accessId 无法反推）；净值/登记编码/额度该页不提供
    //   （净值走 web 端口 ewealth，登记编码/额度农行公开接口均不返回）。需要本机 Chrome。
    const code = (u.searchParams.get("code") || "").trim();
    if (!code) return sendJson(res, 400, { error: "missing code (分享码 ?code= 参数)" });
    const t0 = Date.now();
    try {
      const mod = await import(new URL("./scrape/abc_app.mjs", import.meta.url).href);
      const out = await mod.abcAppCapture(code);
      const ms = Date.now() - t0;
      if (!out) return sendJson(res, 502, { error: "abcapp 未取到数据（Chrome/网络/页面结构可能变化，或分享码无效）" });
      console.log("[abcapp] " + out.productCode + " est=" + out.established + " risk=" + out.risk + " hold=" + out.holdDays + "d (" + ms + "ms)");
      return sendJson(res, 200, out);
    } catch (e) {
      console.log("[abcapp] 失败：" + e.message + " (" + (Date.now() - t0) + "ms)");
      return sendJson(res, 502, { error: "abcapp error: " + e.message });
    }
  }

  if (u.pathname === "/api/jsbapp") {
    // 江苏银行 App 端口（mbank5h5.jsbchina.cn 手机银行 H5，2026-10-18 打通 + 二次打通）：
    //   GET /api/jsbapp?code=J09652          ← ★常规：只需产品代码（已证实 shareCode 与产品无关）
    //   GET /api/jsbapp?url=<完整分享链接>    ← 兼容旧调用（内部解析 prdCode 后按码直查）
    //   例：/api/jsbapp?code=J04946 → 苏银理财恒源天添鑫12号A 全量净值+七字段+额度+登记编码。
    //   实现：无参种子页加载 YT 加密库 → 页面内调页面自己的 YT.ajaxData（加密/解密由页面完成）
    //         → 净值用 dateFlag=4 取「成立以来」全量。需要本机 Chrome；不调用中国理财网。
    const url = (u.searchParams.get("url") || "").trim();
    const code = (u.searchParams.get("code") || "").trim().toUpperCase();
    if (!url && !code) return sendJson(res, 400, { error: "missing code 或 url（?code=J09652 或 ?url=<分享链接>）" });
    const t0 = Date.now();
    try {
      const mod = await import(new URL("./scrape/jsb_app.mjs", import.meta.url).href);
      // 冷启动偶发拿不到（Chrome/网络/会话），最多 3 次，预算递减
      const budgets = [30000, 25000, 20000];
      let out = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const budget = budgets[attempt - 1];
        out = code
          ? await mod.jsbAppByCode(code, { timeoutMs: budget })
          : await mod.jsbAppCapture(url, { timeoutMs: budget });
        if (out) break;
        console.log("[jsbapp] 第" + attempt + "次未取到，重试 (" + (Date.now() - t0) + "ms)");
      }
      const ms = Date.now() - t0;
      if (!out) return sendJson(res, 502, { error: "jsbapp 未取到数据（Chrome/网络/接口变化，或该产品码在江苏银行查无）" });
      console.log("[jsbapp] " + out.productCode + " " + out.name + " nav=" + out.nav + " est=" + out.established + " risk=" + out.risk + " reg=" + out.registryCode + " hold=" + out.holdDays + " series=" + out.series.length + " (" + ms + "ms)");
      return sendJson(res, 200, out);
    } catch (e) {
      console.log("[jsbapp] 失败：" + e.message + " (" + (Date.now() - t0) + "ms)");
      return sendJson(res, 502, { error: "jsbapp error: " + e.message });
    }
  }

  if (u.pathname === "/api/commapp") {
    // 交通银行 App 端口（mbank.95559.com.cn 手机银行网关，2026-10-17 打通，免登录直连）：
    //   GET /api/commapp?link=<分享链>      从分享链抠 productNo+registerCode，抓完自动落盘登记表
    //   GET /api/commapp?code=5811226426    按产品代码取（须已登记 registerCode）
    //   GET /api/commapp?code=5811226426&registerCode=JY   显式给 registerCode（同样自动落盘）
    // registerCode（份额码）只在分享链里出现，故新产物必须先用 ?link= 登记一次。
    const code = (u.searchParams.get("code") || "").trim().toUpperCase();
    const link = (u.searchParams.get("link") || "").trim();
    let rc = (u.searchParams.get("registerCode") || "").trim();
    let prodNo = code;
    if (!rc && link) {
      try {
        const lu = new URL(link);
        prodNo = (lu.searchParams.get("productNo") || "").trim().toUpperCase() || prodNo;
        rc = (lu.searchParams.get("registerCode") || "").trim();
      } catch (e) { /* 非法链接 */ }
    }
    if (!prodNo && !rc) return sendJson(res, 400, { error: "missing code / link / registerCode" });
    const t0 = Date.now();
    try {
      const regFile = new URL("./scrape/comm_register.json", import.meta.url);
      if (!rc && prodNo) {
        try { rc = (JSON.parse(fs.readFileSync(regFile, "utf8")) || {})[prodNo] || ""; } catch (e) { rc = ""; }
        if (!rc) return sendJson(res, 404, { error: "该产品尚未登记 registerCode，请用 ?link=<微信分享链> 首次抓取", code: prodNo });
      }
      if (prodNo && rc) W.setCommRegisterCode(prodNo, rc);
      const out = await W.commAppFetch(prodNo, { registerCode: rc, transport: nodeTransport });
      const ms = Date.now() - t0;
      if (!out) return sendJson(res, 502, { error: "comm app 未取到数据（registerCode 可能不对 / 网络波动）" });
      // 自动落盘 code→registerCode，方便下次直接按 code 抓
      try {
        let map = {};
        try { map = JSON.parse(fs.readFileSync(regFile, "utf8")) || {}; } catch (e) { map = {}; }
        if (out.navViaCode && out.registerCode && map[out.navViaCode] !== out.registerCode) {
          map[out.navViaCode] = out.registerCode;
          fs.writeFileSync(regFile, JSON.stringify(map, null, 2) + "\n");
          console.log("[commapp] 已登记 " + out.navViaCode + " → registerCode " + out.registerCode);
        }
      } catch (e) { /* 落盘失败不影响返回 */ }
      console.log("[commapp] " + out.navViaCode + " 净值=" + (out.series || []).length + " 点 最新=" +
        (out.navLatestDate || "-") + " (" + ms + "ms)");
      return sendJson(res, 200, out);
    } catch (e) {
      console.log("[commapp] 失败：" + e.message + " (" + (Date.now() - t0) + "ms)");
      return sendJson(res, 502, { error: "commapp error: " + e.message });
    }
  }

  if (u.pathname === "/api/bocapp") {
    // 中国银行 App 端口（ebsnew.boc.cn 手机银行 bocFinanceDetail H5，2026-10-17 打通）
    //   GET /api/bocapp?code=668313D                 历史净值序列 + 七字段（详情 isNewVersion:"Y"）
    //   GET /api/bocapp?code=668313D&infoOnly=1     只取七字段，不抓净值序列
    //   GET /api/bocapp?code=668313D&circle=1Y       指定净值区间 3M/6M/1Y/3Y（默认 3Y 最稳）
    // 免登录、免签名、约 1.4s（详情 1 枪 + 净值 1 枪）。
    const code = (u.searchParams.get("code") || "").trim().toUpperCase();
    if (!code) return sendJson(res, 400, { error: "missing code" });
    const infoOnly = u.searchParams.get("infoOnly") === "1";
    const circle = (u.searchParams.get("circle") || "").trim().toUpperCase() || undefined;
    const t0 = Date.now();
    try {
      const out = await W.bocFetch(code, { infoOnly, circle });
      const ms = Date.now() - t0;
      if (!out) return sendJson(res, 404, { error: "not found", code });
      const n = (out.series || []).length;
      console.log("[bocapp] " + code + " " + (out.name || "").slice(0, 24) +
        " 净值=" + n + " 点 最新=" + (out.navDate || "-") + " " + (out.latestNav != null ? out.latestNav : "-") +
        " holdDays=" + (out.holdDays != null ? out.holdDays : "-") +
        " risk=" + (out.risk || "-") + " reg=" + (out.registryCode || "-") +
        " manager=" + (out.manager || "-") + " quota=" + (out.quotaText || "-") + " (" + ms + "ms)");
      return sendJson(res, 200, out);
    } catch (e) {
      console.log("[bocapp] 失败：" + e.message + " (" + (Date.now() - t0) + "ms)");
      return sendJson(res, 502, { error: "bocapp error: " + e.message });
    }
  }

  if (u.pathname === "/api/webankapp") {
    // 微众银行 App 端口（personal.webank.com 理财网关，2026-10-17 打通）
    //   GET /api/webankapp?code=NYJXLD1409G            产品信息全字段 + 最新净值单点
    //   GET /api/webankapp?code=NYJXLD1409G&probe=1    额外探测净值历史接口的拒绝码（诊断用）
    // 免登录、免签名、约 0.7s。
    // ⚠ 净值历史拿不到：wm-pqs / wm-htrserver.finance 对免登录请求恒回 23525003 / 21405001，
    //   与产品/请求头/TLS 指纹/域名/会话均无关（详见 scrape/webank_app.mjs 文件头）。
    const code = (u.searchParams.get("code") || "").trim().toUpperCase();
    if (!code) return sendJson(res, 400, { error: "missing code" });
    const probe = u.searchParams.get("probe") === "1";
    const infoOnly = u.searchParams.get("infoOnly") === "1";
    const t0 = Date.now();
    try {
      const mod = await import(new URL("./scrape/webank_app.mjs", import.meta.url).href);
      const out = await mod.webankAppFetch(code, { infoOnly, probe });
      const ms = Date.now() - t0;
      if (!out || out.error) return sendJson(res, 502, { error: "webank app 未取到数据", detail: out || null, code });
      console.log("[webankapp] " + code + " 净值=" + (out.latestNav != null ? out.latestNav : "-") +
        " @ " + (out.netvalueDate || "-") + " 序列=" + (out.series || []).length + " (" + ms + "ms)");
      return sendJson(res, 200, out);
    } catch (e) {
      console.log("[webankapp] 失败：" + e.message + " (" + (Date.now() - t0) + "ms)");
      return sendJson(res, 502, { error: "webankapp error: " + e.message });
    }
  }

  if (u.pathname === "/api/product") {
    // 新统一抓取编排（2026-10-10 重构；2026-10-15 净值顺序翻转为代销优先）：
    // 净值(代销→发行→中国理财网；7 家无直连端口银行在代销位跳过) /
    // 产品信息(仅中国理财网) / 业绩比较基准(发行→代销) / 额度(发行→代销,平安)。
    const code = (u.searchParams.get("code") || "").trim().toUpperCase();
    const issuer = (u.searchParams.get("issuer") || "").trim().toLowerCase();
    const agent = (u.searchParams.get("agent") || "").trim().toLowerCase();
    // 发行机构（产品记录里已存的 manager，详情卡红圈字段）：issuer 为空时由
    // fetchProductFull 按 MANAGER_TO_KEY 换算成发行银行 key（不按 code 预判）。
    const manager = (u.searchParams.get("manager") || "").trim();
    const name = (u.searchParams.get("name") || "").trim();
    const regCode = (u.searchParams.get("regCode") || "").trim().toUpperCase();
    const full = u.searchParams.get("full") === "1";
    const infoComplete = u.searchParams.get("infoComplete") === "1";
    // 业绩比较基准本地缓存复用（前端在「已查过」的产品刷新时透传，跳过中国理财网/银行重查）
    const benchmark = u.searchParams.has("benchmark") ? (u.searchParams.get("benchmark") || "") : null;
    const benchmarkKnown = u.searchParams.get("benchmarkKnown") === "1";
    // 偏好银行标记（首次双抓定标后由前端持久化；以后只抓该银行，不再试另一家）
    const preferBank = (u.searchParams.get("preferBank") || "").trim().toLowerCase();
    // 概要齐全标记（中行 ProductSummaryQueryOutlay 含 名称/登记编码/风险/基准，抓一次即齐全 → 跳过该请求）
    const summaryComplete = u.searchParams.get("summaryComplete") === "1";
    const sName = u.searchParams.get("sName") || "";
    const sRegCode = (u.searchParams.get("sRegCode") || "").trim().toUpperCase();
    const sRisk = (u.searchParams.get("sRisk") || "").trim();
    const sBenchmark = (u.searchParams.get("sBenchmark") || "").trim();
    // noCache=1：用户主动刷新（刷净值/刷信息/详情页刷新）时透传，令平安等带 60s 进程内
    // 缓存的银行绕过缓存、真实回源（否则 60s 内二次刷新命中缓存恒为 0ms）。
    const noCache = u.searchParams.get("noCache") === "1";
    // 增量抓取：刷新（非添加产品）时前端透传本地序列最后净值日；后端只翻到追上该日的页、只回新增点。
    // 缺失/为空 → 全量历史（添加产品 / 旧前端兼容）。
    const since = (u.searchParams.get("since") || "").trim();
    // 2026-10-22 用户规则（额度和净值拆分）：mode 决定本次只抓哪一类数据，透传给 fetchProductFull——
    //   nav   只抓净值（不调产品信息、不抓额度）
    //   info  只抓产品信息 + 业绩基准（不抓净值、不抓额度）
    //   quota 只抓额度
    //   all   全抓（兼容详情页完整刷新 / 调试端点）
    const mode = (u.searchParams.get("mode") || "all");
    if (!code) return sendJson(res, 400, { error: "missing code" });
    const t0 = Date.now();
    try {
      const out = await W.fetchProductFull(code, { issuer, agent, manager, name, regCode: regCode || undefined, fullInfo: full, infoComplete, benchmark, benchmarkKnown, transport: nodeTransport, preferBank: preferBank || null, summaryComplete, sName, sRegCode, sRisk, sBenchmark, noCache, mode, since: since || undefined });
      const ms = Date.now() - t0;
      // 现金管理类（isCash）也必须按 200 下发：这是「按项目规则主动排除」，
      // 不是「查无此码」。前端据 isCash 提示「该产品为现金管理类」并拒绝收录；
      // 若这里落到 404，前端只会显示「未查到该产品」，用户无法区分原因（2026-10-23）。
      if (out && (out.isCash === true || out.nav || out.info || out.benchmark || out.quota != null || mode === "quota")) {
        if (out.isCash === true) {
          console.log("[product] " + code + " -> 现金管理类，按项目铁律不收录 (" + ms + "ms)");
        }
        console.log("[product] " + code + " 发行=" + (issuer || W.managerToBankKey(manager) || "-") +
          "(mgr=" + (manager || "-") + ") 代销=" + agent +
          " -> navVia=" + out.navVia + " / info=" + (out.info ? "Y" : "N") +
          " / bench=" + (out.benchmark ? "Y" : "N") + " / quota=" + (out.quota != null ? "Y" : "N") + " (" + ms + "ms)");
        return sendJson(res, 200, out);
      }
      console.log("[product] " + code + " -> 未抓到 (" + ms + "ms)");
      // 未抓到也要把分阶段耗时带给前端：list「时间分解」列据此显示失败轮次的耗时明细
      // （此前 404 只回 error，前端 httpJson 抛错时丢掉 body，失败产品的时间分解恒为「--」）
      return sendJson(res, 404, {
        error: "not found", code, issuer, agent,
        timings: (out && Array.isArray(out.timings)) ? out.timings : undefined,
      });
    } catch (e) {
      const ms = Date.now() - t0;
      console.log("[product] " + code + " 失败：" + e.message + " (" + ms + "ms)");
      return sendJson(res, 500, { error: "product error: " + e.message });
    }
  }

  if (u.pathname === "/api/mybank-manual") {
    // 网商银行「按产品代码 → 七字段」查询（2026-10-26 接入）：
    //   GET /api/mybank-manual?code=<网商产品码>
    //   免登录取「理财产品说明书」PDF → 解析出 发行银行/产品名称/登记编码/最短持有天数/
    //   风险等级(R1-R5)/成立日期/业绩比较基准。前端「添加产品·查询」当代销行=网商时调用，
    //   拿到的发行行 + 登记编码再交给 /api/product（mode=nav）抓净值，中国理财网按登记编码兜底。
    //   需要本机 Chrome（pdf_extract 渲染 PDF + jshield 离线签名）。
    const code = (u.searchParams.get("code") || "").trim().toUpperCase();
    if (!code) return sendJson(res, 400, { error: "missing code" });
    const t0 = Date.now();
    try {
      const mybankManualLookup = await loadMybankManualLookup();
      const out = await mybankManualLookup(code);
      const ms = Date.now() - t0;
      console.log("[mybank-manual] " + code + " ok=" + out.ok + " issuer=" + (out.issuer || "-") +
        " name=" + (out.name || "-") + " nameSource=" + (out.nameSource || "-") +
        " reg=" + (out.regCode || "-") + " (" + ms + "ms)");
      return sendJson(res, out.ok ? 200 : 502, out);
    } catch (e) {
      console.log("[mybank-manual] 失败：" + e.message + " (" + (Date.now() - t0) + "ms)");
      return sendJson(res, 500, { error: "mybank-manual error: " + e.message });
    }
  }

  if (u.pathname === "/api/refreshlog") {
    // 刷新顺序日志：POST {bank, name} -> 追加到 刷新顺序.csv（第1列银行、第2列产品名称），
    // 并防抖重建 刷新顺序.xls（中文正常显示的交付格式）。
    // 每个产品抓取完成即记一行（并发 4 路，行序 = 实际完成顺序）。CSV 用 UTF-8 BOM + CRLF。
    if (req.method !== "POST") return sendJson(res, 405, { error: "POST only" });
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      try {
        const j = JSON.parse(body || "{}");
        const bank = String(j.bank || "").trim();
        const name = String(j.name || "").trim();
        if (!bank && !name) return sendJson(res, 400, { error: "empty row" });
        const cell = (v) => /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
        const line = cell(bank) + "," + cell(name) + "\r\n";
        const file = path.join(ROOT, "刷新顺序.csv");
        try {
          if (!fs.existsSync(file)) fs.writeFileSync(file, "\uFEFF银行,产品名称\r\n", "utf8");
          fs.appendFileSync(file, line, "utf8");
          scheduleXlsRebuild(); // -> 刷新顺序.xls（refresh_log_xls.py，xlwt）
        } catch (e) {
          return sendJson(res, 500, { error: "write failed: " + e.message });
        }
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { error: "bad json" });
      }
    });
    return;
  }

  // ============ React 个人台账（克隆自 F:\WorkBuddy\理财产品参谋长 oldox）API mock ============
  // 该前端是参谋长版 React 构建产物原样复用（_ledger_app/），故按其 /api 契约提供本地数据。
  const LEDGER_DIR = path.join(ROOT, "_ledger_app");
  // 台账持仓的「服务端」存储：放在项目根目录，与 产品数据.json / 净值数据.json 同级，便于备份与查看
  const LEDGER_DATA = path.join(ROOT, "台账数据.json");
  function readLedgerData() {
    try {
      const d = JSON.parse(fs.readFileSync(LEDGER_DATA, "utf8"));
      if (d && typeof d === "object") return Object.assign({ version: 1, holdings: [], aliases: {}, savedAt: null }, d);
    } catch (e) {}
    return { version: 1, holdings: [], aliases: {}, savedAt: null };
  }
  function writeLedgerData(d) {
    try {
      const tmp = LEDGER_DATA + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(d, null, 1));
      fs.renameSync(tmp, LEDGER_DATA);
      return true;
    } catch (e) { return false; }
  }
  function readBody(req, cb) {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 8 * 1024 * 1024) req.destroy(); });
    req.on("end", () => { let j = null; try { j = JSON.parse(body || "null"); } catch (e) {} cb(j, body); });
  }
  // —— 主页产品数据 → React 台账：格式适配层 ——
  // 台账（参谋长版 React）内部把「数字 product_id」当产品主键：$u() / Xu() / tm() 都做
  //   Number(productId) > 0 判断，非数字 id 直接被丢弃 ——
  //   表现为「收益明细 · 未更新 / 0.00」「趋势与构成」为空、「已更新 n/m」永远 0。
  // 而主页两套数据用「字母数字销售代码」做主键（26G2188A / NYJXLDKJLH90 / 2501260735 …）。
  // 故此处加一层适配：代码 → 稳定数字 id（持久化到 product-id-map.json，重启后不变），
  // 并把 净值数据.json（净值序列）+ 产品数据.json（代销行/期限/成立日/基准）两源合并成台账字段。
  const PID_MAP_FILE = path.join(LEDGER_DIR, "product-id-map.json");
  function readPidMap() {
    try {
      const m = JSON.parse(fs.readFileSync(PID_MAP_FILE, "utf8"));
      if (m && m.byCode && m.byId && Number(m.next) > 0) return m;
    } catch (e) {}
    return { byCode: {}, byId: {}, next: 100001 };
  }
  function savePidMap(m) {
    try { fs.writeFileSync(PID_MAP_FILE, JSON.stringify(m, null, 1)); } catch (e) {}
  }
  function pidFor(code, m) {
    if (m.byCode[code]) return m.byCode[code];
    let id = m.next;
    while (m.byId[id]) id += 1;
    m.next = id + 1;
    m.byCode[code] = id;
    m.byId[id] = code;
    return id;
  }
  // 数字 id → 销售代码；直接传代码也放行（便于手工调试）
  function codeFromPid(pid) {
    const s = String(pid == null ? "" : pid).trim();
    if (!s) return "";
    const m = readPidMap();
    return m.byId[s] || s;
  }
  // 代销机构代码 → 银行名（与主页 index.html 的 BANK_NAMES 一致）
  const LEDGER_BANK_NAMES = {
    icbc: "工商银行", bob: "北京银行", bosc: "上海银行", ccb: "建设银行", abc: "农业银行",
    citic: "中信银行", boc: "中国银行", ceb: "光大银行", cib: "兴业银行", pingan: "平安银行",
    cmb: "招商银行", cmbc: "民生银行", jsb: "江苏银行", spdb: "浦发银行", psbc: "邮储银行",
    nbcb: "宁波银行", comm: "交通银行", cgb: "广发银行", fminbank: "富民银行",
    dongguan: "东莞银行", huaxia: "华夏银行", nanyin: "南京银行", mybank: "网商银行",
    webank: "微众银行", weiyin: "微银",
  };
  // 期限字符串 → 天数（台账按 term 天数分桶：≤1 日开 / 7 / 14 / 14-30 / 其他）
  const LEDGER_TERM_DAYS = { daily: 1, "1d": 1, "7d": 7, "14d": 14, "30d": 30, "60d": 60, "90d": 90, quarterly: 90 };
  // 产品名称 → 类别标签（台账仅用于分组展示，不参与收益计算）
  function ledgerCategory(name) {
    const s = String(name || "");
    if (/现金|时时付|天天|日日|活期|添利宝|货币/.test(s)) return "现金管理类";
    if (/权益|股票|混合|增强|全球|配置|挂钩/.test(s)) return "混合类";
    return "固收类";
  }
  // 产品数据.json 的 observer_reg_v1（字符串存 JSON）→ { 销售代码: 登记行 }
  function loadRegIndex() {
    const idx = {};
    try {
      const prod = JSON.parse(fs.readFileSync(path.join(ROOT, "产品数据.json"), "utf8"));
      let reg = prod && prod.data ? prod.data.observer_reg_v1 : null;
      if (typeof reg === "string") { try { reg = JSON.parse(reg); } catch (e) { reg = null; } }
      const rows = [];
      if (reg && Array.isArray(reg.custom)) rows.push(...reg.custom);
      if (reg && Array.isArray(reg.deleted)) rows.push(...reg.deleted);
      for (const r of rows) if (r && r.code) idx[r.code] = r;
    } catch (e) {}
    return idx;
  }
  // 净值总表读取见顶层 readNavMap()（2026-10-22 提为模块级，供启动迁移与接口共用）
  // 两源合并 → 台账产品对象（/api/products/latest 与 /api/product/{id} 共用同一形状）
  function buildLedgerProducts() {
    const pidMap = readPidMap();
    const reg = loadRegIndex();
    const out = [];
    const seen = new Set();
    let dirty = false;
    const push = (code, p) => {
      if (!code || seen.has(code)) return;
      seen.add(code);
      const r = reg[code] || {};
      const series = Array.isArray(p.series) ? p.series : [];
      const last = series.length ? series[series.length - 1] : null;
      const name = p.name || r.name || code;
      const manager = r.manager || p.manager || "";
      // 代销机构：产品登记表的 bank 最准 → 净值来源行 navVia 兜底 → 管理人兜底
      const bankName = LEDGER_BANK_NAMES[r.bank] || LEDGER_BANK_NAMES[p.navVia] || "";
      const agency = bankName || manager;
      const termNum = Number(p.holdDays) > 0 ? Number(p.holdDays) : (LEDGER_TERM_DAYS[r.term] || null);
      const before = pidMap.byCode[code];
      const pid = pidFor(code, pidMap);
      if (pid !== before) dirty = true;
      out.push({
        product_id: pid,
        productId: pid,
        product_name: name,
        product_full_name: name,
        sale_code: code,
        sales_id: code,
        product_code: code,
        manager_org: manager,
        managerOrg: manager,
        agent_org: agency,
        agency_name: agency,
        agencyName: agency,
        nav: last ? last[1] : null,
        nav_date: last ? last[0] : null,
        risk_level: r.risk || p.risk || "",
        riskLevel: r.risk || p.risk || "",
        term: termNum,
        establish_date: r.established || p.established || "",
        benchmark: (p.benchmark && p.benchmark !== "—" ? p.benchmark : r.benchmark) || "—",
        product_category: ledgerCategory(name),
        productCategory: ledgerCategory(name),
        status: "在售",
        daily_income: null,
        avg_7d_income: null,
      });
    };
    try {
      const navMap = readNavMap();
      for (const [code, p] of Object.entries(navMap)) push(code, p || {});
    } catch (e) {}
    if (dirty) savePidMap(pidMap);
    return out;
  }
  // —— 产品净值历史（主页 净值数据.json → React 台账收益计算）——
  function findHomeProduct(code) {
    try {
      const navMap = readNavMap();
      if (navMap[code]) return navMap[code];
    } catch (e) {}
    return null;
  }
  const prodMatch = u.pathname.match(/^\/api\/product\/([^/]+)(?:\/(history|trend))?$/);
  if (prodMatch) {
    const raw = decodeURIComponent(prodMatch[1]);
    const code = codeFromPid(raw);
    const sub = prodMatch[2] || "";
    const p = findHomeProduct(code);
    if (!p) return sendJson(res, 404, { error: "not found" });
    const series = Array.isArray(p.series) ? p.series : [];
    const points = series.map((s) => ({ date: s[0], nav: s[1] }));
    if (sub === "history") {
      let list = points;
      const start = u.searchParams.get("startDate");
      const end = u.searchParams.get("endDate");
      const days = Number(u.searchParams.get("days") || 0);
      if (start) list = list.filter((x) => x.date >= start);
      if (end && end < "2099-01-01") list = list.filter((x) => x.date <= end);
      if (days > 0) list = list.slice(-days);
      return sendJson(res, 200, list);
    }
    if (sub === "trend") {
      const limit = Number(u.searchParams.get("limit") || 200);
      return sendJson(res, 200, { trendList: points.slice(-limit) });
    }
    const meta = buildLedgerProducts().find((x) => x.sale_code === code) || {};
    const last = points.length ? points[points.length - 1] : null;
    return sendJson(res, 200, Object.assign({}, meta, {
      product_id: meta.product_id || raw,
      product_name: p.name || code,
      product_series: p.series_name || "",
      nav: last ? last.nav : null,
      nav_date: last ? last.date : null,
      establish_date: meta.establish_date || p.established || "",
      benchmark: meta.benchmark || p.benchmark || "—",
    }));
  }
  if (u.pathname === "/api/products/latest") {
    const q = (u.searchParams.get("productName") || "").trim().toLowerCase();
    const inst = (u.searchParams.get("institution") || "").trim();
    const idsRaw = (u.searchParams.get("productIds") || "").trim();
    const oneId = (u.searchParams.get("productId") || "").trim();
    const limit = Math.min(Number(u.searchParams.get("limit") || 100) || 100, 500);
    let list = buildLedgerProducts();
    const want = [...idsRaw.split(","), oneId].map((s) => s.trim()).filter(Boolean);
    if (want.length) {
      const codes = new Set(want.map((s) => codeFromPid(s)));
      const ids = new Set(want);
      list = list.filter((p) => ids.has(String(p.product_id)) || codes.has(String(p.sale_code)));
    }
    if (q) {
      list = list.filter((p) =>
        (p.product_name || "").toLowerCase().includes(q) ||
        (p.sale_code || "").toLowerCase().includes(q) ||
        String(p.product_id).includes(q)
      );
    }
    if (inst) list = list.filter((p) => (p.agent_org || "").includes(inst) || (p.manager_org || "").includes(inst));
    return sendJson(res, 200, list.slice(0, limit));
  }
  // 产品系列筛选（台账「系列对比」用）：本适配层无系列维度，返回空集合而非 404
  if (u.pathname === "/api/products-by-series") {
    return sendJson(res, 200, { code: 0, agencies: [], terms: [], products: [], total: 0 });
  }
  if (u.pathname.startsWith("/api/auth/")) {
    const user = { id: 1, username: "local", nickname: "本地用户", membership: "vip", is_admin: false };
    if (u.pathname === "/api/auth/validate") return sendJson(res, 200, { valid: true, user });
    if (u.pathname === "/api/auth/profile") return sendJson(res, 200, user);
    return sendJson(res, 200, { ok: true });
  }
  // —— 持仓存储接口（台账前端的直接数据源）——
  // 台账前端的持仓读写已改为直接调本接口（_ledger_app/static/js/main.*.js 内的 j()/b()）：
  //   首次进入 GET 拉快照 → 之后读写在 localStorage 缓存与本地接口之间同步。
  // 存盘文件：项目根目录 台账数据.json（与 产品数据.json / 净值数据.json 同级）。
  // 不再有额外注入的桥接脚本，前端自身即本地数据客户端。
  if (u.pathname === "/api/holding-store") {
    const d = readLedgerData();
    if (req.method === "GET") {
      return sendJson(res, 200, {
        version: d.version || 1,
        holdings: Array.isArray(d.holdings) ? d.holdings : [],
        savedAt: d.savedAt || null,
        rev: d.rev || 0,
      });
    }
    return readBody(req, (j) => {
      const next = readLedgerData();
      let incoming = null;
      if (Array.isArray(j)) incoming = j;
      else if (j && Array.isArray(j.holdings)) incoming = j.holdings;
      else if (j && j.data && Array.isArray(j.data.holdings)) incoming = j.data.holdings;
      if (!incoming) return sendJson(res, 400, { ok: false, error: "holdings 字段缺失" });
      next.holdings = incoming;
      if (j && j.version) next.version = j.version;
      next.rev = (next.rev || 0) + 1;
      next.savedAt = new Date().toISOString();
      const ok = writeLedgerData(next);
      return sendJson(res, ok ? 200 : 500, {
        ok, rev: next.rev, count: next.holdings.length, savedAt: next.savedAt,
      });
    });
  }
  if (u.pathname === "/api/holding" || u.pathname === "/api/holding-backup" || u.pathname === "/api/holding-auto-backup") {
    const d = readLedgerData();
    if (req.method === "GET") {
      if (u.pathname === "/api/holding") return sendJson(res, 200, d.holdings || []);
      return sendJson(res, 200, { holdings: d.holdings || [], trades: d.trades || [], savedAt: d.savedAt || null });
    }
    return readBody(req, (j) => {
      const next = readLedgerData();
      if (Array.isArray(j)) next.holdings = j;
      else if (j && Array.isArray(j.holdings)) next.holdings = j.holdings;
      else if (j && j.data && Array.isArray(j.data.holdings)) next.holdings = j.data.holdings;
      if (j && Array.isArray(j.trades)) next.trades = j.trades;
      next.savedAt = new Date().toISOString();
      writeLedgerData(next);
      return sendJson(res, 200, { ok: true, savedAt: next.savedAt });
    });
  }
  if (u.pathname === "/api/product-aliases" || u.pathname.startsWith("/api/product-aliases/")) {
    if (req.method === "GET") return sendJson(res, 200, readLedgerData().aliases || {});
    return readBody(req, (j) => {
      const next = readLedgerData();
      next.aliases = (j && (j.aliases || j)) || {};
      writeLedgerData(next);
      return sendJson(res, 200, { ok: true });
    });
  }
  if (u.pathname === "/api/institutions" || u.pathname === "/api/managers") return sendJson(res, 200, []);
  // 待办：前端读 { items: [] }
  if (u.pathname === "/api/finance-todos" || u.pathname.startsWith("/api/finance-todos/")) {
    return sendJson(res, 200, { items: [], total: 0 });
  }
  // 公告：前端判 e.data.success 才取 data，裸数组会触发「获取公告失败」并弹测试公告
  if (u.pathname === "/api/announcements" || u.pathname === "/api/modal-announcements") {
    return sendJson(res, 200, { success: true, data: [] });
  }
  if (u.pathname === "/api/config") return sendJson(res, 200, {});

  if (u.pathname === "/api/state") {
    // 产品数据持久化（3 文件版）：
    //   GET  → 把 产品数据.json / 净值数据.json / 运行日志.json 三份 data 合并后返回（形状与旧版一致）
    //   POST → 收 { data:{...} }，按 stateBucketOf() 分桶，分别原子写回 3 个文件
    //   POST → 另支持 { dropLogs:true }：删除 运行日志.json 及其备份（清理调试数据用）
    if (req.method === "GET") {
      const merged = {};
      const files = {};
      let newest = "";
      for (const kind of STATE_KINDS) {
        const j = readStateFile(kind);
        const n = j ? Object.keys(j.data).length : 0;
        files[kind] = {
          file: STATE_FILES[kind].file, label: STATE_FILES[kind].label,
          count: n, savedAt: j ? j.savedAt || null : null,
        };
        if (j) {
          Object.assign(merged, j.data);          // 旧版单文件里遗留的键也会被一起读出，自动完成迁移
          if (j.savedAt && j.savedAt > newest) newest = j.savedAt;
        }
      }
      const n = Object.keys(merged).length;
      return sendJson(res, 200, {
        file: STATE_FILES.core.file, empty: n === 0,      // file 保持「主文件名」，兼容 data-sync.js
        savedAt: newest || null, port: PORT, count: n, data: merged, files,
      });
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > STATE_MAX_BYTES) req.destroy(); });
      req.on("end", () => {
        let j;
        try {
          j = JSON.parse(body || "{}");
        } catch (e) {
          return sendJson(res, 400, { error: "bad json" });
        }

        // —— 清理运行日志：删掉 运行日志.json + 运行日志.备份.json ——
        if (j && j.dropLogs === true) {
          let removed = [];
          for (const p of [statePath("log"), stateBakPath("log")]) {
            try { if (fs.existsSync(p)) { fs.unlinkSync(p); removed.push(path.basename(p)); } } catch (e) {}
          }
          console.log("[state] 已删除运行日志：" + (removed.join("、") || "无文件可删"));
          return sendJson(res, 200, { ok: true, dropped: "log", removed });
        }

        const data = j && j.data;
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          return sendJson(res, 400, { error: "need {data:{...}}" });
        }
        const clean = {};
        for (const k of Object.keys(data)) {
          if (k.indexOf(STATE_PREFIX) === 0 && typeof data[k] === "string") clean[k] = data[k];
        }

        const buckets = { core: {}, nav: {}, log: {} };
        for (const k of Object.keys(clean)) buckets[stateBucketOf(k)][k] = clean[k];

        // —— 防误覆盖：净值表「断崖式缩水」拒绝写盘 ——
        // 场景：浏览器 localStorage 被清空 / 换设备 / 无痕窗口首次打开，前端把「几乎为空」的
        // observer_lookup_real 推上来，一次就把服务端 100+ 条净值历史清成几条（本项目实际发生过）。
        // 规则：新条数 < 旧条数 × 0.3 且旧条数 ≥ 20 → 拒绝该键（保留磁盘旧数据）并显式告警。
        // 真要清空净值缓存，请直接删除 净值数据.json，而不是靠前端推送。
        const navWarn = [];
        try {
          const incomingRaw = buckets.nav.observer_lookup_real;
          if (incomingRaw) {
            const curN = Object.keys(readNavMap()).length;
            const incN = Object.keys(parseNavValue(incomingRaw) || {}).length;
            if (curN >= 20 && incN < curN * 0.3) {
              delete buckets.nav.observer_lookup_real;
              navWarn.push("净值表缩水保护：磁盘 " + curN + " 条，前端仅推送 " + incN + " 条，已拒绝覆盖");
              console.warn("[state] " + navWarn[0]);
            }
          }
        } catch (e) { /* 保护逻辑异常不阻断正常写入 */ }

        const stamp = new Date().toISOString();   // 同一次 POST 三个文件共用一个时间戳
        const files = {};
        const written = [];
        for (const kind of STATE_KINDS) {
          const n = Object.keys(buckets[kind]).length;
          // 空桶不写：万一前端只推了部分键，也不会把某个文件误清空
          if (n === 0) { files[kind] = { file: STATE_FILES[kind].file, count: 0, written: false }; continue; }
          try {
            writeStateFile(kind, buckets[kind], stamp);
          } catch (e) {
            return sendJson(res, 500, { error: "write failed (" + STATE_FILES[kind].file + "): " + e.message });
          }
          files[kind] = { file: STATE_FILES[kind].file, count: n, written: true };
          written.push(STATE_FILES[kind].file + "(" + n + ")");
        }
        const total = Object.keys(clean).length;
        console.log("[state] 已保存 " + total + " 个键 -> " + (written.join(" + ") || "（无键，未写盘）"));
        return sendJson(res, 200, {
          ok: true, file: STATE_FILES.core.file, savedAt: stamp, count: total, files,
          warnings: navWarn.length ? navWarn : undefined,
        });
      });
      return;
    }
    return sendJson(res, 405, { error: "GET/POST only" });
  }

  // React 个人台账（参谋长版构建产物原样复用）：根路径路由 + /static 资源
  if (u.pathname === "/static" || u.pathname.startsWith("/static/")) {
    const STATIC_DIR = path.join(LEDGER_DIR, "static");
    let sub = u.pathname.slice("/static".length) || "/index.html";
    let lf = path.normalize(path.join(STATIC_DIR, sub));
    if (!lf.startsWith(STATIC_DIR)) return sendJson(res, 403, { error: "forbidden" });
    return fs.readFile(lf, (err, data) => {
      if (err) return sendJson(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": MIME[path.extname(lf).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(data);
    });
  }
  // 2026-10-23：台账页（/assets-center 等）标签页图标统一为红色 SVG favicon（与排行榜 index.html 完全一致）。
  // 用户反馈「进端口个人台账后，理财产品排行榜标签页图标变成默认灰」。根因：这些路由返回的是
  // _ledger_app/index.html（React 构建产物），自带 图标-64/192.png；而排行榜 index.html 用内联红色 SVG。
  // 构建产物改了就丢（rebuild 覆盖），故在读文件后把台账自带 icon link 替换注入同一个红色 SVG。
  const RED_FAVICON = `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='%23e23b3b'/><path d='M50 12 Q60 40 88 50 Q60 60 50 88 Q40 60 12 50 Q40 40 50 12 Z' fill='white'/></svg>">`;
  // 顶栏品牌星星 .brand-icon：其 path fill=currentColor，颜色继承父级 CSS color（深底显白色）。
  // 注入这段把 color 改成红色，与主页红色四角星一致（用户 2026-10-23 要求「个人台账最上面白星也变红」）。
  const LEDGER_BRAND_CSS = `<style>.brand-icon{color:#e23b3b !important}</style>`;
  const LEDGER_ROUTES = ["/assets-center", "/trade-center", "/holding-assets", "/profit-product"];
  if (LEDGER_ROUTES.some((r) => u.pathname === r || u.pathname.startsWith(r + "/"))) {
    return fs.readFile(path.join(LEDGER_DIR, "index.html"), (err, data) => {
      if (err) return sendJson(res, 404, { error: "not found" });
      let html = data.toString("utf8")
        .replace(/<link[^>]*rel=["']icon["'][^>]*>/gi, "")
        .replace(/<link[^>]*rel=["']apple-touch-icon["'][^>]*>/gi, "");
      html = html.replace("</head>", RED_FAVICON + LEDGER_BRAND_CSS + "</head>");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        // 硬约束：台账只允许访问本机资源；任何外部域名（oldox / GA / 广告 / 第三方 API）一律阻断
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; " +
          "media-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end(html);
    });
  }
  // 台账构建产物里有 serviceWorker.register()，但本项目不需要离线缓存（会与「本地数据为准」冲突）。
  // 这里返回一个自注销的空 SW：既消掉 404 报错，也保证不会留下任何缓存层。
  if (u.pathname === "/service-worker.js") {
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
    return res.end(
      "self.addEventListener('install',function(){self.skipWaiting()});" +
      "self.addEventListener('activate',function(e){e.waitUntil(self.registration.unregister())});"
    );
  }
  // 台账壳的根级静态资源（PWA manifest / 图标）住在 _ledger_app/ 下，需单独映射
  const LEDGER_ROOT_ASSETS = ["/manifest.json", "/favicon.ico", "/图标-64.png", "/图标-192.png", "/图标-512.png"];
  {
    const decoded = decodeURIComponent(u.pathname);
    if (LEDGER_ROOT_ASSETS.includes(decoded)) {
      const lf = path.join(LEDGER_DIR, decoded.slice(1));
      return fs.readFile(lf, (err, data) => {
        if (err) return sendJson(res, 404, { error: "not found" });
        res.writeHead(200, {
          "Content-Type": MIME[path.extname(lf).toLowerCase()] || "application/octet-stream",
          "Content-Length": data.length,
          "Cache-Control": "no-store",
        });
        res.end(data);
      });
    }
  }

  // 静态文件
  let rel = decodeURIComponent(u.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) return sendJson(res, 403, { error: "forbidden" });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: "not found", path: rel });
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": data.length,
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
});

// 启动自愈：把历史遗留的 observer_lookup_icbc 分桶并进 observer_lookup_real 并落盘。
// 幂等：文件里没有 icbc 键就直接跳过，不会重复改写。
function migrateLegacyIcbcBucket() {
  for (const file of ["净值数据.json", "净值数据.备份.json"]) {
    const p = path.join(ROOT, file);
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      if (!j || !j.data || !j.data.observer_lookup_icbc) continue;
      const parse = parseNavValue;
      const real = parse(j.data.observer_lookup_real) || {};
      const legacy = parse(j.data.observer_lookup_icbc);
      let n = 0;
      for (const c of Object.keys(legacy)) { real[c] = navMergeEntry(real[c], legacy[c]); n++; }
      j.data = { observer_lookup_real: JSON.stringify(real) };
      const tmp = p + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(j), "utf8");
      fs.renameSync(tmp, p);
      console.log("[migrate] " + file + "：已把 " + n + " 项 icbc 分桶并入 real（共 " + Object.keys(real).length + " 项）");
    } catch (e) {
      console.warn("[migrate] " + file + " 迁移跳过：" + ((e && e.message) || e));
    }
  }
}

server.listen(PORT, () => {
  migrateLegacyIcbcBucket();
  console.log("理财产品聚焦 本地服务已启动： http://localhost:" + PORT + "/");
  console.log("  实时抓取已启用（含宁波银行）：/api/fetch?bank=nbcb&code=<产品代码>");
  console.log("  请用上面的 http:// 地址打开 index.html（不要用 file://，否则浏览器无法跨域抓取）。");
});