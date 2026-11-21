# Vexto Connect

Vexto 的浏览器接管扩展。当前处于 **M1**：设置保存、连接测试、右键「用 Vexto 下载」已实现；自动接管浏览器下载（M2）尚未启用。

技术选型：Manifest V3 + 纯静态 HTML/CSS/JS，无 npm、无构建链。

## 目录

```text
vexto-connect/
├── manifest.json     MV3 清单（权限 / 选项页 / service worker / 图标）
├── common.js         默认设置、校验、请求与中文错误文案（选项页与 worker 共用）
├── background.js     service worker：右键菜单、POST /add、失败回落
├── options.html      选项页
├── options.css
├── options.js
├── icons/            扩展与通知图标
├── README.md
└── LICENSE           GPL-3.0
```

## 已实现（M1）

- 选项页读取、校验、保存 `enabled` / `host` / `port` / `secret` 到 `chrome.storage.local`；
- 「测试连接」调用 `GET /ping`、`GET /version`，并额外读一次 `GET /downloads/capabilities`——Vexto 对前两者免鉴权，401 只能由后者暴露；
- 右键链接「用 Vexto 下载」：`POST /add`，带 `X-Rayburst-Client: rayburst-connect`，有密钥时带 `Authorization: Bearer`；
- `accepted` → badge ✓；`fallback` / 网络失败 / 401 → 通知具体原因，并让浏览器原生下载接管；
- 不做自动拦截（`chrome.downloads.onDeterminingFilename` 留到 M2）。

## 后续实现范围

1. 自动接管浏览器下载（`downloads.onDeterminingFilename`），失败恢复浏览器下载。
2. Cookie / Referer / UA 可选转发、站点黑白名单、最小文件大小、重复保护。
3. Vexto 侧 `/v1/*` 稳定协议（当前复用 `/ping`、`/version`、`/downloads/capabilities`、`/add` 兼容接口）。

## 加载（开发）

1. 启动 Vexto（托盘运行，插件接管开启，默认端口 29110）。
2. 打开 `edge://extensions` 或 `chrome://extensions`，开启开发人员模式。
3. 「加载解压缩的扩展」，选择本项目目录。
4. 打开扩展选项页，确认主机 / 端口 / 密钥，点「测试连接」。

## 安全边界（设计约束）

- 只访问 `http://127.0.0.1` 本机回环。
- 可选 Bearer 密钥，与 Vexto 设置保持一致。
- 不注册 native messaging；Vexto 必须在托盘运行。
- M1 不读取、不转发 Cookie。

## 开发文档

完整设计、协议、状态机与测试计划见 `docs/DEVELOPMENT.md`（软链接到 `vexto_docs/vexto-connect_docs`）。

## 许可

GNU GPL-3.0，与 Vexto 主项目一致。
