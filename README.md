# Vexto Connect

Vexto 的浏览器接管扩展。**当前只搭了项目骨架，功能尚未实现。**

技术选型：Manifest V3 + 纯静态 HTML/CSS/JS，无 npm、无构建链。

## 目录骨架

```text
vexto-connect/
├── manifest.json     MV3 清单（权限 / 选项页 / service worker）
├── background.js     service worker 占位，TODO 见文件头
├── options.html      选项页布局骨架
├── options.css       选项页样式
├── options.js        选项页逻辑占位
├── README.md
└── LICENSE           GPL-3.0
```

## 后续实现范围

1. 设置保存与连接测试（主机 / 端口 / 可选密钥）。
2. 自动接管浏览器下载（`downloads.onDeterminingFilename`），失败恢复浏览器下载。
3. 右键菜单「用 Vexto 下载」。
4. Cookie / Referer / UA 可选转发、站点黑白名单、最小文件大小、重复保护。
5. Vexto 侧 `/v1/*` 稳定协议（当前 Vexto 已有 `/ping`、`/version`、`/downloads/capabilities`、`/add` 兼容接口）。

## 加载（开发）

1. 启动 Vexto（托盘运行，插件接管开启，默认端口 29110）。
2. 打开 `edge://extensions` 或 `chrome://extensions`，开启开发人员模式。
3. 「加载解压缩的扩展」，选择本项目目录。
4. 当前版本只会安装 service worker 占位，不会接管下载。

## 安全边界（设计约束）

- 只访问 `http://127.0.0.1` 本机回环。
- 可选 Bearer 密钥，与 Vexto 设置保持一致。
- 不注册 native messaging；Vexto 必须在托盘运行。
- Cookie 转发默认关闭，按敏感数据处理。

## 许可

GNU GPL-3.0，与 Vexto 主项目一致。
