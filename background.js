// Vexto Connect service worker：右键「用 Vexto 下载」→ POST /add。
// M1 不做自动接管（chrome.downloads.onDeterminingFilename 留到 M2）。

importScripts("common.js");

const MENU_ID = "vexto-download-link";
const MENU_TITLE = "用 Vexto 下载";
const DEFAULT_ACTION_TITLE = "Vexto Connect";
const BADGE_OK = "✓";
const BADGE_ERR = "!";
const BADGE_COLOR_OK = "#45c98a";
const BADGE_COLOR_ERR = "#f0566d";

let menuGeneration = 0;

async function loadSettings() {
  const stored = await chrome.storage.local.get("settings");
  return normalizeSettings(stored.settings);
}

// 菜单跟着 enabled 走：停用时移除，启用时重建。用代次丢弃过期的并发同步。
async function refreshMenu() {
  const generation = ++menuGeneration;
  const settings = await loadSettings();
  if (generation !== menuGeneration) return;
  await chrome.contextMenus.removeAll();
  if (generation !== menuGeneration || !settings.enabled) return;
  chrome.contextMenus.create(
    { id: MENU_ID, title: MENU_TITLE, contexts: ["link"] },
    () => {
      if (chrome.runtime.lastError) {
        console.warn("创建右键菜单失败：", chrome.runtime.lastError.message);
      }
    }
  );
}

void refreshMenu();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) void refreshMenu();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  void handoffLink(info.linkUrl || "", tab?.url || "");
});

function filenameFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const segment = url.pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

async function handoffLink(linkUrl, referer) {
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: `${DEFAULT_ACTION_TITLE} · 正在交给 Vexto…` });

  const settings = await loadSettings();

  if (!linkUrl) {
    await reportFailure("没有读到链接", "请确认右键点在链接上。", null);
    return;
  }
  if (!/^https?:\/\//i.test(linkUrl)) {
    await reportFailure("不支持的链接", "只能把 http/https 链接交给 Vexto。", null);
    return;
  }
  if (!settings.enabled) {
    await reportFailure("扩展已停用", "请在 Vexto Connect 选项页启用扩展后再试。", linkUrl);
    return;
  }

  const payload = { url: linkUrl, ack: "early", userAgent: navigator.userAgent };
  if (referer) payload.referer = referer;
  const filename = filenameFromUrl(linkUrl);
  if (filename) payload.filename = filename;

  let response;
  try {
    response = await vextoFetch(settings, "/add", {
      method: "POST",
      headers: vextoHeaders(settings, true),
      body: JSON.stringify(payload),
      timeoutMs: ADD_TIMEOUT_MS,
    });
  } catch (error) {
    const reason = describeNetworkError(error, settings, ADD_TIMEOUT_MS);
    await reportFailure("Vexto 未响应", reason, linkUrl);
    return;
  }

  if (response.status === 401) {
    await reportFailure("密钥不一致", describeHttpError(401), linkUrl);
    return;
  }
  if (!response.ok) {
    await reportFailure(`Vexto 返回 HTTP ${response.status}`, describeHttpError(response.status), linkUrl);
    return;
  }

  const data = await readJson(response);
  if (data && data.action === "accepted") {
    await reportSuccess();
    return;
  }

  const reason =
    data && data.reason === "rejected"
      ? "Vexto 拒绝接收：下载工具未启用，或该链接类型不受支持。"
      : `Vexto 没有接管（响应：${data ? JSON.stringify(data) : "无法解析"}）。`;
  await reportFailure("已回落到浏览器下载", reason, linkUrl);
}

async function reportSuccess() {
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR_OK });
  await chrome.action.setBadgeText({ text: BADGE_OK });
  await chrome.action.setTitle({ title: `${DEFAULT_ACTION_TITLE} · 已交给 Vexto` });
  clearBadgeSoon();
}

async function reportFailure(headline, reason, fallbackUrl) {
  console.warn(`Vexto Connect：${headline}。${reason}`);
  try {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR_ERR });
    await chrome.action.setBadgeText({ text: BADGE_ERR });
    await chrome.action.setTitle({ title: `${DEFAULT_ACTION_TITLE} · ${headline}` });

    const fallbackNote = fallbackUrl ? "已改用浏览器下载。" : "";
    notify(`${DEFAULT_ACTION_TITLE} · ${headline}`, `${reason}${fallbackNote}`);
  } catch (error) {
    // 状态展示失败也不能影响回落下载
    console.warn("显示失败状态时出错：", error);
  } finally {
    if (fallbackUrl) startBrowserDownload(fallbackUrl);
    clearBadgeSoon();
  }
}

function startBrowserDownload(url) {
  chrome.downloads.download({ url, saveAs: false }, () => {
    if (chrome.runtime.lastError) {
      notify(
        `${DEFAULT_ACTION_TITLE} · 浏览器下载未启动`,
        `浏览器下载也未能启动：${chrome.runtime.lastError.message}。请复制链接后手动下载。`
      );
    }
  });
}

function notify(title, message) {
  chrome.notifications.create(
    {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message,
      priority: 2,
    },
    () => {
      if (chrome.runtime.lastError) {
        console.warn("通知失败：", chrome.runtime.lastError.message);
      }
    }
  );
}

function clearBadgeSoon() {
  setTimeout(() => {
    void chrome.action.setBadgeText({ text: "" });
  }, 3000);
}
