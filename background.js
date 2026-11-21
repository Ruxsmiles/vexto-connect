// Vexto Connect service worker —— 项目骨架，暂未实现。
//
// TODO（后续实现，不在本轮范围）：
// - 从 chrome.storage.local 读取 host / port / secret / enabled
// - GET /v1/ping、GET /v1/version 连接探测
// - chrome.downloads.onDeterminingFilename 自动接管浏览器下载
// - 失败时恢复浏览器下载，不吞任务
// - 右键菜单「用 Vexto 下载」
// - Cookie / Referer / UA 可选转发

chrome.runtime.onInstalled.addListener(() => {
  console.info("Vexto Connect 已安装（骨架，功能尚未实现）");
});
