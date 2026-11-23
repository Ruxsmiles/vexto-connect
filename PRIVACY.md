# Vexto Connect 隐私政策

生效日期：2026-11-23

Vexto Connect（以下简称「本扩展」）是 Vexto 桌面应用的配套浏览器扩展。本政策说明本扩展如何处理数据。

## 我们收集什么

本扩展**不收集、不上传、不出售**任何个人数据，也没有统计、遥测或账号体系。

## 本扩展如何使用数据

- **设置与密钥**：保存在浏览器本地的 `chrome.storage.local`，不会同步到云端，也不会发送给第三方。
- **网络请求**：本扩展只访问 `http://127.0.0.1` 与 `http://localhost` 上的本机 Vexto 应用，不访问公网。
- **Cookie（可选，默认关闭）**：只有用户主动开启「转发 Cookie」后，本扩展才会读取当前下载站点的 Cookie，并发送给本机 Vexto，用于需要登录态的下载。Cookie 不会写入日志，也不会发送到其他地址。
- **诊断记录**：最近 50 条交接结果保存在浏览器会话存储中，只包含主机与原因码，不包含 URL 查询串、Cookie、密钥或文件名；浏览器会话结束即清空。

## 权限用途

- `storage`：保存扩展设置与诊断记录。
- `contextMenus`：提供「用 Vexto 下载」右键菜单。
- `downloads`：暂停、取消或恢复浏览器下载，以便交给 Vexto 或在失败时回落。
- `notifications`：在下载回落或失败时提示原因。
- `cookies`：仅在用户开启 Cookie 转发时读取站点 Cookie。
- `http://127.0.0.1/*`、`http://localhost/*`：访问本机 Vexto API。
- `downloads.ui`（可选）：仅在用户开启「隐藏浏览器下载列表」时申请。
- `*://*/*`（可选）：仅在用户开启 Cookie 转发时申请，用于读取站点 Cookie。

## 第三方

本扩展不集成任何第三方分析、广告或数据服务。

## 政策变更

如果本政策发生变更，会更新本文件并在仓库中提交。

## 联系方式

如有疑问，请通过 [GitHub Issues](https://github.com/Boom-Sumber/vexto-connect/issues) 联系我们。
