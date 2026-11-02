# macOS 使用说明

上游（lclist/lclist.github.io）为 Windows 环境开发，本仓库已完成 macOS 适配。

## 启动

```bash
# 方式一：Finder 双击「启动本地服务.command」
# 方式二：终端
cd lclist.github.io
./启动本地服务.command        # 或 node serve.mjs 8766
```

浏览器打开 <http://localhost:8766/>（必须 http://，不能 file://）。

## 本仓库相对上游的 macOS 适配点

| 位置 | 上游（Windows） | 本仓库 |
|---|---|---|
| `serve.mjs` PY_XLS | 硬编码 `C:\Users\a\.workbuddy\...python.exe` | 按 `process.platform` 分流：非 win32 → `python3`（PATH） |
| `serve.mjs` 孤儿 Chrome profile 清理 | 仅 `powershell Get-CimInstance` | win32 → powershell；macOS/Linux → `ps ax -o command=`（效果等同） |
| `.xls` 重建兜底 | `python` | 非 win32 → `python3` |
| 启动器 | `启动本地服务.cmd` | 新增 `启动本地服务.command`（可执行） |

无需改动即跨平台的部分：`scrape/*_app.mjs`、`scrape/cmbwm_cdp.mjs` 的
`CHROME_CANDIDATES` 本就含 macOS Chrome 路径（也可用 `CHROME_PATH` 环境变量覆盖）。

## 依赖

- Node ≥ 18（ESM 直跑，无需 npm install）
- 本机 Chrome（部分银行通道 jsb/cmbwm/abc/bob/ceb 需无头 Chrome）
- 可选：`pip3 install --user xlwt`（刷新顺序 .xls 自动重建；不装只影响该日志，不影响抓取）

## 与 Windows 版的数据互通

`产品数据.json` / `净值数据.json` / `运行日志.json` 直接拷贝即可互认
（`/api/state` 形状不变）；两台机器同时写同一目录会互相覆盖，请二选一为主。
