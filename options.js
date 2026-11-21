const el = (id) => document.getElementById(id);
const DEFAULTS = {
  enabled: true,
  host: "127.0.0.1",
  port: 29110,
  secret: "",
};

function setStatus(text, kind) {
  const s = el("status");
  s.textContent = text || "";
  s.className = "status" + (kind ? " " + kind : "");
}

function showDetail(value) {
  const d = el("detail");
  if (value == null) {
    d.classList.add("hidden");
    d.textContent = "";
    return;
  }
  d.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  d.classList.remove("hidden");
}

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  el("enabled").checked = !!s.enabled;
  el("host").value = s.host || "127.0.0.1";
  el("port").value = s.port || 29110;
  el("secret").value = s.secret || "";
}

async function save() {
  const port = Number(el("port").value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    setStatus("端口必须是 1024–65535", "bad");
    return null;
  }
  const settings = {
    enabled: el("enabled").checked,
    host: el("host").value.trim() || "127.0.0.1",
    port,
    secret: el("secret").value,
  };
  await chrome.storage.local.set(settings);
  try {
    await chrome.runtime.sendMessage({ type: "vexto:settings-changed" });
  } catch {}
  setStatus("已保存", "ok");
  return settings;
}

async function test() {
  const saved = await save();
  if (!saved) return;
  el("test").disabled = true;
  setStatus("正在连接…");
  showDetail(null);
  try {
    const r = await chrome.runtime.sendMessage({ type: "vexto:test" });
    if (r && r.ok) {
      setStatus("已连接 · Vexto " + (r.ping?.version || ""), "ok");
      showDetail(r);
    } else {
      setStatus("未连接", "bad");
      showDetail(r || "无响应");
    }
  } catch (e) {
    setStatus("未连接", "bad");
    showDetail(String(e?.message || e));
  } finally {
    el("test").disabled = false;
  }
}

el("save").addEventListener("click", save);
el("test").addEventListener("click", test);
load().catch((e) => setStatus("读取设置失败：" + e.message, "bad"));
