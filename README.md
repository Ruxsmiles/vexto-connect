# Vexto Connect

Vexto 的浏览器接管扩展。纯 Manifest V3 + 静态 HTML/CSS/JS，无 npm、无构建链。

## 当前范围（v0.1.0）

- 设置页：Vexto 主机 / 端口 / 可选密钥、启用开关、连接测试。
- 右键链接菜单「用 Vexto 下载」：把链接交给本机 Vexto 新建下载任务。
- Vexto 不在线时给出提示，浏览器仍可继续手动下载。
- 自动拦截浏览器下载、Cookie/UA 转发、站点规则、重复保护在后续版本实现（见路线图）。

## 安装（开发版）

1. 启动 Vexto（托盘运行，浏览器插件接管开启，默认端口 29110）。
2. 打开 `edge://extensions` 或 `chrome://extensions`。
3. 打开「开发人员模式」，点「加载解压缩的扩展」，选择本项目目录。
4. 打开扩展的「扩展选项」，确认主机 `127.0.0.1`、端口 `29110`，点「测试连接」。

自用加载解压缩即可，不需要上架商店。修改代码后在扩展页点「重新加载」。

## 与 Vexto 的接口

当前 MVP 复用 Vexto 已有的 Rayburst Connect 兼容接口：

```text
GET  /ping      产品探测
GET  /version   引擎就绪探针
POST /add       交接下载，返回 { action: "accepted" } 或 { action: "fallback" }
```

请求头：

```text
X-Rayburst-Client: rayburst-connect
Authorization: Bearer <可选密钥>
Content-Type: application/json
```

`/add` 负载：

```json
{
  "url": "https://example.com/file.zip",
  "filename": "file.zip",
  "referer": "https://example.com/page",
  "userAgent": "Mozilla/5.0 ...",
  "ack": "early"
}
```

后续会在 Vexto 增加 `/v1/*` 稳定协议，扩展再切换；旧接口保留兼容。

## 安全边界

- 只访问 `http://127.0.0.1`，不访问公网。
- 可选 Bearer 密钥必须与「Vexto 设置 → 下载 → 高级 → 插件密钥」一致；只设置一边会 401。
- MVP 不读取 Cookie；后续开启 Cookie 转发时按敏感数据处理，不写日志、不进界面。
- 不注册 native messaging，不能自行启动 Vexto；需要 Vexto 在托盘运行（开机自启默认开）。

## 路线图

1. 自动接管浏览器下载（`downloads.onDeterminingFilename`，暂停 + 交接 + 失败恢复）。
2. 转发 Cookie / Referer / UA，站点黑白名单，最小文件大小。
3. 重复下载保护、连接状态徽标、失败系统通知。
4. Vexto `/v1/*` 稳定协议与版本协商。
5. 媒体嗅探 / HLS 不在一期范围。

## 许可

GNU GPL-3.0，与 Vexto 主项目一致。
