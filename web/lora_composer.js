import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "ShiyiLoraStack";

const PAD = 8;
const HEAD_H = 18;
const ROW_H = 32;
const THUMB = 22;
const FOOT_H = 28;
const BTN = 18;
const GAP = 4;
const MIN_W = 540;
const CARD_LIMIT = 300;

const C = {
  rowOn: "#262631",
  rowOff: "#1b1b21",
  border: "#3b3b48",
  text: "#dcdce4",
  dim: "#8b8b99",
  faint: "#5d5d6b",
  accent: "#6fb3ff",
  warn: "#ffc46b",
  danger: "#ff7b7b",
  btn: "#31313d",
};

const STATE = { loras: null, settings: {}, loading: null };
const INFO_CACHE = new Map();
const THUMBS = new Map();
let TRIGGER_STORE = null;
let STRENGTH_EDITOR = null;

/* ------------------------------------------------------------------ 自定义触发词 */

async function loadTriggerStore(force = false) {
  if (TRIGGER_STORE && !force) return TRIGGER_STORE;
  try {
    TRIGGER_STORE = await fetchJson("/shiyi_lora/triggers");
  } catch {
    TRIGGER_STORE = {};
  }
  if (!TRIGGER_STORE || typeof TRIGGER_STORE !== "object") TRIGGER_STORE = {};
  return TRIGGER_STORE;
}

async function saveTrigger(name, words) {
  const store = await loadTriggerStore();
  store[name] = words;
  try {
    await api.fetchApi("/shiyi_lora/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, words }),
    });
  } catch (error) {
    toast(`触发词保存失败：${error.message}`);
  }
}

/* ------------------------------------------------------------------ data */

async function fetchJson(path) {
  const res = await api.fetchApi(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

async function loadCatalog(force = false) {
  if (STATE.loras && !force) return STATE.loras;
  if (!STATE.loading) {
    STATE.loading = fetchJson(`/shiyi_lora/list${force ? "?refresh=1" : ""}`)
      .then((data) => {
        STATE.loras = data.loras || [];
        STATE.settings = data.settings || {};
        return STATE.loras;
      })
      .finally(() => {
        STATE.loading = null;
      });
  }
  return STATE.loading;
}

async function getInfo(name) {
  if (INFO_CACHE.has(name)) return INFO_CACHE.get(name);
  const info = await fetchJson(`/shiyi_lora/info?name=${encodeURIComponent(name)}`);
  INFO_CACHE.set(name, info);
  return info;
}

function previewUrl(name) {
  const path = `/shiyi_lora/preview?name=${encodeURIComponent(name)}`;
  return api.apiURL ? api.apiURL(path) : path;
}

/* ------------------------------------------------------------------ rows */

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseRows(value) {
  let data;
  try {
    data = JSON.parse(value || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data
    .filter((row) => row && typeof row === "object" && row.name)
    .map((row) => ({
      name: String(row.name),
      sm: num(row.sm, 0.8),
      sc: num(row.sc, num(row.sm, 0.8)),
      on: row.on !== false,
      tw: String(row.tw || ""),
    }));
}

function rowsOf(node) {
  if (!Array.isArray(node.__rows)) node.__rows = [];
  return node.__rows;
}

function stackWidget(node) {
  return node.widgets?.find((widget) => widget.name === "stack_data");
}

function commit(node) {
  const widget = stackWidget(node);
  if (widget) widget.value = JSON.stringify(rowsOf(node));
  fit(node);
  node.setDirtyCanvas(true, true);
}

function shortLabel(name) {
  const base = String(name).split("/").pop() || name;
  return base.replace(/\.(safetensors|ckpt|pt|pth|sft)$/i, "");
}

/* ------------------------------------------------------------------ layout */

function socketTop(node) {
  const ins = node.inputs?.length || 0;
  const outs = node.outputs?.length || 0;
  return 16 + Math.max(ins, outs, 1) * 20;
}

function rowsHeight(node) {
  return Math.max(1, rowsOf(node).length) * ROW_H;
}

function bodyHeight(node) {
  return socketTop(node) + HEAD_H + rowsHeight(node) + FOOT_H + PAD;
}

function fit(node) {
  const width = Math.max(MIN_W, node.size?.[0] || MIN_W);
  node.setSize([width, bodyHeight(node)]);
}

function layout(node) {
  const width = node.size?.[0] || MIN_W;
  const list = rowsOf(node);
  const top = socketTop(node);
  const out = { top, rows: [], footer: null };
  let y = top + HEAD_H;

  for (let index = 0; index < list.length; index++) {
    const xDel = width - PAD - BTN;
    const xInfo = xDel - GAP - BTN;
    const strW = 52;
    const xStr = xInfo - GAP - strW;
    const xThumb = PAD + 20;
    const xName = xThumb + THUMB + 6;
    out.rows.push({
      index,
      y,
      row: { x: 4, y: y - 2, w: width - 8, h: ROW_H },
      cb: { x: PAD, y: y + 9, w: 14, h: 14 },
      thumb: { x: xThumb, y: y + (ROW_H - THUMB) / 2 - 2, w: THUMB, h: THUMB },
      name: { x: xName, y, w: Math.max(70, xStr - 6 - xName), h: ROW_H - 4 },
      str: { x: xStr, y: y + 5, w: strW, h: ROW_H - 12 },
      info: { x: xInfo, y: y + 5, w: BTN, h: BTN },
      del: { x: xDel, y: y + 5, w: BTN, h: BTN },
    });
    y += ROW_H;
  }
  out.footer = { x: PAD, y: y + 2, w: 104, h: FOOT_H - 8 };
  return out;
}

function inside(rect, pos) {
  return (
    pos[0] >= rect.x && pos[0] <= rect.x + rect.w && pos[1] >= rect.y && pos[1] <= rect.y + rect.h
  );
}

/* ------------------------------------------------------------------ draw */

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function ensureThumb(node, name) {
  let entry = THUMBS.get(name);
  if (entry) return entry;
  entry = { img: new Image(), ok: false };
  THUMBS.set(name, entry);
  entry.img.onload = () => {
    entry.ok = true;
    node.setDirtyCanvas(true, true);
  };
  entry.img.onerror = () => {
    entry.ok = false;
  };
  entry.img.src = previewUrl(name);
  if (THUMBS.size > 600) {
    const oldest = THUMBS.keys().next().value;
    if (oldest !== name) THUMBS.delete(oldest);
  }
  return entry;
}

function drawThumb(ctx, node, row, rect, alpha) {
  const entry = ensureThumb(node, row.name);
  if (entry.ok && entry.img.width) {
    ctx.save();
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 4);
    ctx.clip();
    ctx.globalAlpha = alpha;
    ctx.drawImage(entry.img, rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
    return;
  }
  roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 4);
  ctx.fillStyle = "#1a1a22";
  ctx.fill();
  ctx.font = "11px 'Microsoft YaHei',sans-serif";
  ctx.fillStyle = C.faint;
  ctx.textAlign = "center";
  ctx.fillText(shortLabel(row.name).slice(0, 1) || "?", rect.x + rect.w / 2, rect.y + rect.h / 2);
  ctx.textAlign = "left";
}

const FONT = "12px 'Microsoft YaHei','PingFang SC',system-ui,sans-serif";
const FONT_SM = "11px 'Microsoft YaHei','PingFang SC',system-ui,sans-serif";

function draw(node, ctx) {
  const list = rowsOf(node);
  const L = layout(node);
  const width = node.size[0];
  const enabled = list.filter((row) => row.on).length;

  ctx.save();
  ctx.textBaseline = "middle";

  // socket 区与内容区之间的分隔
  ctx.strokeStyle = "#33333d";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(8, L.top - 4);
  ctx.lineTo(width - 8, L.top - 4);
  ctx.stroke();

  ctx.font = FONT_SM;
  ctx.fillStyle = C.dim;
  ctx.fillText(`启用 ${enabled} / 共 ${list.length} 个 LoRA`, PAD + 2, L.top + HEAD_H / 2);

  if (!list.length) {
    ctx.fillStyle = C.faint;
    ctx.font = FONT;
    ctx.fillText("还没有 LoRA —— 点下面的 [+ 添加 LoRA]", PAD + 2, L.top + HEAD_H + ROW_H / 2);
  }

  for (const item of L.rows) {
    const row = list[item.index];
    roundRect(ctx, item.row.x, item.row.y, item.row.w, item.row.h, 5);
    ctx.fillStyle = row.on ? C.rowOn : C.rowOff;
    ctx.fill();
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    ctx.stroke();

    drawThumb(ctx, node, row, item.thumb, row.on ? 1 : 0.4);

    roundRect(ctx, item.cb.x, item.cb.y, item.cb.w, item.cb.h, 3);
    ctx.fillStyle = row.on ? C.accent : "transparent";
    ctx.fill();
    ctx.strokeStyle = row.on ? C.accent : C.faint;
    ctx.stroke();
    if (row.on) {
      ctx.strokeStyle = "#10151d";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(item.cb.x + 3, item.cb.y + 7);
      ctx.lineTo(item.cb.x + 6, item.cb.y + 10);
      ctx.lineTo(item.cb.x + 11, item.cb.y + 4);
      ctx.stroke();
    }

    ctx.font = FONT;
    ctx.fillStyle = row.on ? C.text : C.faint;
    ctx.fillText(fitText(ctx, shortLabel(row.name), item.name.w), item.name.x, item.name.y + ROW_H / 2 - 2);

    roundRect(ctx, item.str.x, item.str.y, item.str.w, item.str.h, 4);
    ctx.fillStyle = "#1a1a22";
    ctx.fill();
    ctx.font = FONT_SM;
    ctx.fillStyle = Math.abs(row.sm - 1) < 0.001 ? C.text : C.warn;
    ctx.textAlign = "center";
    ctx.fillText(row.sm.toFixed(2), item.str.x + item.str.w / 2, item.str.y + item.str.h / 2);
    ctx.textAlign = "left";

    roundRect(ctx, item.info.x, item.info.y, item.info.w, item.info.h, 4);
    ctx.fillStyle = C.btn;
    ctx.fill();
    ctx.fillStyle = C.accent;
    ctx.textAlign = "center";
    ctx.fillText("i", item.info.x + item.info.w / 2, item.info.y + item.info.h / 2 + 0.5);
    ctx.textAlign = "left";

    roundRect(ctx, item.del.x, item.del.y, item.del.w, item.del.h, 4);
    ctx.fillStyle = C.btn;
    ctx.fill();
    ctx.fillStyle = C.danger;
    ctx.textAlign = "center";
    ctx.fillText("×", item.del.x + item.del.w / 2, item.del.y + item.del.h / 2);
    ctx.textAlign = "left";
  }

  roundRect(ctx, L.footer.x, L.footer.y, L.footer.w, L.footer.h, 5);
  ctx.fillStyle = "#243244";
  ctx.fill();
  ctx.strokeStyle = "#33506f";
  ctx.stroke();
  ctx.font = FONT;
  ctx.fillStyle = C.accent;
  ctx.textAlign = "center";
  ctx.fillText("+ 添加 LoRA", L.footer.x + L.footer.w / 2, L.footer.y + L.footer.h / 2);
  ctx.textAlign = "left";

  ctx.fillStyle = C.faint;
  ctx.font = FONT_SM;
  if (width - L.footer.x - L.footer.w > 300) {
    ctx.fillText(
      "i 看说明 · 点数字输入 · ↑↓ 微调",
      L.footer.x + L.footer.w + 12,
      L.footer.y + L.footer.h / 2
    );
  }

  ctx.restore();
}

/* ------------------------------------------------------------------ actions */

function clampStrength(value) {
  return Math.round(Math.min(4, Math.max(-4, value)) * 100) / 100;
}

function editStrength(node, index, event) {
  const row = rowsOf(node)[index];
  if (!row) return;
  closeStrengthEditor();

  const canvas = app.canvas;
  const box = canvas.canvas.getBoundingClientRect();
  const scale = canvas.ds?.scale || 1;
  const width = Math.max(52, 52 * scale);
  const height = Math.max(20, 20 * scale);
  // 以点击位置为准，避免节点坐标换算误差
  const anchorX = Number.isFinite(event?.clientX) ? event.clientX : box.left + box.width / 2;
  const anchorY = Number.isFinite(event?.clientY) ? event.clientY : box.top + box.height / 2;

  const input = document.createElement("input");
  input.type = "text";
  input.value = row.sm.toFixed(2);
  input.dataset.shiyiStrength = "1";
  input.style.cssText = [
    "position:fixed",
    `left:${anchorX - width / 2}px`,
    `top:${anchorY - height / 2}px`,
    `width:${width}px`,
    `height:${height}px`,
    `font-size:${Math.max(11, 12 * scale)}px`,
    "text-align:center",
    "background:#111116",
    "color:#ffc46b",
    "border:1px solid #6fb3ff",
    "border-radius:4px",
    "z-index:100002",
    "outline:none",
    "padding:0",
  ].join(";");
  input.addEventListener("pointerdown", (pointerEvent) => pointerEvent.stopPropagation());
  input.addEventListener("mousedown", (mouseEvent) => mouseEvent.stopPropagation());
  document.body.appendChild(input);
  STRENGTH_EDITOR = input;

  let done = false;
  const finish = (apply) => {
    if (done) return;
    done = true;
    if (apply) {
      const value = Number(String(input.value).trim().replace(",", "."));
      if (Number.isFinite(value)) {
        row.sm = clampStrength(value);
        commit(node);
      }
    }
    document.removeEventListener("pointerdown", onOutside, true);
    input.remove();
    if (STRENGTH_EDITOR === input) STRENGTH_EDITOR = null;
  };
  const onOutside = (pointerEvent) => {
    if (pointerEvent.target !== input) finish(true);
  };

  input.addEventListener("keydown", (keyEvent) => {
    keyEvent.stopPropagation();
    if (keyEvent.key === "Enter") {
      keyEvent.preventDefault();
      finish(true);
    } else if (keyEvent.key === "Escape") {
      keyEvent.preventDefault();
      finish(false);
    } else if (keyEvent.key === "ArrowUp" || keyEvent.key === "ArrowDown") {
      keyEvent.preventDefault();
      const step = (keyEvent.shiftKey ? 0.01 : 0.05) * (keyEvent.key === "ArrowUp" ? 1 : -1);
      const base = Number(String(input.value).trim().replace(",", "."));
      const next = clampStrength((Number.isFinite(base) ? base : row.sm) + step);
      input.value = next.toFixed(2);
      row.sm = next;
      commit(node);
    }
  });

  // 不依赖 blur：画布会抢焦点；改用「点外部才提交」
  // 画布会在 mousedown 结束时抢焦点，这里补两次聚焦把焦点拿回来
  const grabFocus = () => {
    if (done) return;
    input.focus({ preventScroll: true });
    input.select();
  };
  setTimeout(grabFocus, 0);
  setTimeout(grabFocus, 120);
  setTimeout(() => {
    if (!done) document.addEventListener("pointerdown", onOutside, true);
  }, 0);
}

function closeStrengthEditor() {
  if (STRENGTH_EDITOR) {
    STRENGTH_EDITOR.remove();
    STRENGTH_EDITOR = null;
  }
}

/* ------------------------------------------------------------------ dom ui */

let styleReady = false;

function ensureStyle() {
  if (styleReady) return;
  styleReady = true;
  const style = document.createElement("style");
  style.textContent = `
  .shiyi-mask{position:fixed;inset:0;background:rgba(6,8,12,.74);z-index:100000;display:flex;align-items:center;justify-content:center;font-family:'Microsoft YaHei','PingFang SC',system-ui,sans-serif;}
  .shiyi-panel{background:#1d1d24;color:#dcdce4;border:1px solid #3b3b48;border-radius:10px;box-shadow:0 18px 48px rgba(0,0,0,.55);display:flex;flex-direction:column;overflow:hidden;}
  .shiyi-head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #2f2f3a;font-size:13px;font-weight:600;color:#eaeaf2;flex-wrap:wrap}
  .shiyi-head .sp{flex:1}
  .shiyi-x{cursor:pointer;color:#8b8b99;font-size:16px;line-height:1;padding:2px 6px;border-radius:4px}
  .shiyi-x:hover{background:#31313d;color:#fff}
  .shiyi-input{flex:1;min-width:160px;background:#14141a;border:1px solid #3b3b48;border-radius:6px;color:#dcdce4;padding:6px 9px;font-size:13px;outline:none}
  .shiyi-input:focus{border-color:#6fb3ff}
  .shiyi-select{background:#14141a;border:1px solid #3b3b48;border-radius:6px;color:#dcdce4;padding:5px 7px;font-size:12.5px;outline:none;max-width:190px}
  .shiyi-select:focus{border-color:#6fb3ff}
  .shiyi-check{display:flex;align-items:center;gap:5px;font-size:12px;color:#9a9aa8;cursor:pointer;user-select:none}
  .shiyi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));grid-auto-rows:186px;gap:10px;padding:12px;overflow-y:auto;align-content:start}
  .shiyi-card{border:1px solid #2f2f3a;border-radius:8px;background:#22222b;overflow:hidden;cursor:pointer;display:flex;flex-direction:column;height:186px;flex:0 0 auto;position:relative}
  .shiyi-card.has-tw::after{content:"";position:absolute;top:6px;right:6px;width:8px;height:8px;border-radius:50%;background:#69d18b;box-shadow:0 0 0 2px rgba(0,0,0,.45)}
  .shiyi-card:hover{border-color:#6fb3ff}
  .shiyi-card.sel{border-color:#69d18b;box-shadow:0 0 0 1px #2f4a38 inset}
  .shiyi-thumb{flex:0 0 118px;height:118px;min-height:118px;background:#14141a;display:flex;align-items:center;justify-content:center;overflow:hidden}
  .shiyi-thumb img{width:100%;height:100%;object-fit:cover;display:block}
  .shiyi-ph{font-size:26px;color:#3f3f4c;font-weight:700}
  .shiyi-nm{flex:0 0 auto;font-size:12px;color:#dcdce4;padding:6px 7px 2px;line-height:1.3;word-break:break-all;max-height:38px;overflow:hidden}
  .shiyi-fd{flex:0 0 auto;font-size:10.5px;color:#757584;padding:0 7px 6px;line-height:1.3;word-break:break-all;max-height:30px;overflow:hidden}
  .shiyi-meta{display:flex;flex-wrap:wrap;gap:6px;padding:8px 14px;border-bottom:1px solid #2f2f3a;font-size:11px;color:#9a9aa8}
  .shiyi-meta b{color:#6fb3ff;font-weight:600}
  .shiyi-scroll{overflow-y:auto;padding:12px 14px}
  .shiyi-desc{white-space:pre-wrap;word-break:break-word;font-family:'Consolas','Microsoft YaHei',monospace;font-size:12.5px;line-height:1.65;color:#cfcfda;margin:0}
  .shiyi-sec{font-size:11px;color:#7d7d8c;padding:0 14px 6px}
  .shiyi-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 12px}
  .shiyi-chip{font-size:11.5px;padding:3px 8px;border-radius:999px;border:1px solid #3b3b48;background:#242430;color:#c7c7d4;cursor:pointer}
  .shiyi-chip:hover{border-color:#6fb3ff;color:#fff}
  .shiyi-chip.on{background:#2f4a38;border-color:#69d18b;color:#c9f5d8}
  .shiyi-foot{display:flex;gap:8px;align-items:center;padding:10px 14px;border-top:1px solid #2f2f3a;font-size:11.5px;color:#7d7d8c}
  .shiyi-editbar{display:flex;align-items:center;gap:8px;padding:8px 14px;border-top:1px solid #2f2f3a;background:#1a1a21}
  .shiyi-editbar-name{font-size:11.5px;color:#9a9aa8;min-width:110px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .shiyi-editbar-input{flex:1;min-width:120px;font-size:12px}
  .shiyi-editbar-input:disabled{opacity:.5}
  .shiyi-btn{font-size:12.5px;padding:6px 12px;border-radius:6px;border:1px solid #3b3b48;background:#282833;color:#dcdce4;cursor:pointer}
  .shiyi-btn:hover{background:#32323f}
  .shiyi-btn.primary{background:#24405e;border-color:#3a689a;color:#cfe6ff}
  .shiyi-toast{position:fixed;top:18px;right:18px;z-index:100001;background:#262633;color:#dcdce4;border:1px solid #3b3b48;border-radius:8px;padding:9px 14px;font-size:12.5px;box-shadow:0 10px 30px rgba(0,0,0,.5);font-family:'Microsoft YaHei',sans-serif}
  `;
  document.head.appendChild(style);
}

function toast(message) {
  ensureStyle();
  const div = document.createElement("div");
  div.className = "shiyi-toast";
  div.textContent = message;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 2600);
}

function closeOverlay() {
  document.getElementById("shiyi-mask")?.remove();
}

function openMask(panel) {
  ensureStyle();
  closeOverlay();
  const mask = document.createElement("div");
  mask.id = "shiyi-mask";
  mask.className = "shiyi-mask";
  mask.addEventListener("pointerdown", (event) => {
    if (event.target === mask) closeOverlay();
  });
  mask.appendChild(panel);
  document.body.appendChild(mask);
  const onKey = (event) => {
    if (event.key === "Escape") {
      closeOverlay();
      document.removeEventListener("keydown", onKey);
    }
  };
  document.addEventListener("keydown", onKey);
  return mask;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function select(options, value) {
  const node = el("select", "shiyi-select");
  for (const [key, label] of options) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = label;
    node.appendChild(option);
  }
  if (value !== undefined) node.value = value;
  return node;
}

/* picker -------------------------------------------------------------- */

const SORTS = {
  folder: (a, b) =>
    (a.folder || "").localeCompare(b.folder || "", "zh") || a.label.localeCompare(b.label, "zh"),
  name: (a, b) => a.label.localeCompare(b.label, "zh"),
  recent: (a, b) => (b.mtime || 0) - (a.mtime || 0),
  size: (a, b) => (b.size || 0) - (a.size || 0),
  preview: (a, b) =>
    (b.preview ? 1 : 0) - (a.preview ? 1 : 0) || a.label.localeCompare(b.label, "zh"),
};

const SORT_LABELS = [
  ["folder", "排序：目录 + 名称"],
  ["name", "排序：名称 A→Z"],
  ["recent", "排序：最近修改"],
  ["size", "排序：体积从大到小"],
  ["preview", "排序：有预览优先"],
];

function topOf(folder) {
  if (!folder) return "(根目录)";
  return folder.split("/")[0];
}

function subOf(folder, top) {
  if (!folder) return "";
  if (top === "*") return folder;
  if (folder === top) return "";
  return folder.slice(top.length + 1);
}

async function openPicker(node, replaceIndex) {
  ensureStyle();
  const currentName = replaceIndex >= 0 ? rowsOf(node)[replaceIndex]?.name : null;

  const panel = el("div", "shiyi-panel");
  panel.style.width = "min(1080px, 94vw)";
  panel.style.height = "min(760px, 88vh)";

  const head = el("div", "shiyi-head");
  const title = el("span", "", replaceIndex >= 0 ? "换一个 LoRA" : "添加 LoRA");
  const topSel = select([["*", "一级目录：全部"]]);
  const subSel = select([["*", "二级目录：全部"]]);
  const sortSel = select(SORT_LABELS, "folder");
  const onlyPrevLabel = el("label", "shiyi-check");
  const onlyPrev = document.createElement("input");
  onlyPrev.type = "checkbox";
  onlyPrevLabel.append(onlyPrev, document.createTextNode("仅看有预览"));
  const input = el("input", "shiyi-input");
  input.placeholder = "搜索名字 / 路径，例如 画风、原神、@ix7";
  const closeBtn = el("span", "shiyi-x", "×");
  closeBtn.onclick = closeOverlay;
  head.append(title, topSel, subSel, sortSel, onlyPrevLabel, input, closeBtn);

  const grid = el("div", "shiyi-grid");
  const foot = el("div", "shiyi-foot");
  const countLabel = el("span", "", "");
  const tip = el("span", "", "单击选择 · 右键追加为新行");
  tip.style.marginLeft = "auto";
  const refreshBtn = el("button", "shiyi-btn", "重新扫描目录");
  foot.append(countLabel, tip, refreshBtn);

  // 触发词编辑栏：鼠标指向哪张卡片就编辑哪个 LoRA
  const editor = el("div", "shiyi-editbar");
  const edName = el("span", "shiyi-editbar-name", "把鼠标移到卡片上");
  const edInput = el("input", "shiyi-input shiyi-editbar-input");
  edInput.placeholder = "触发词（留空＝明确不要触发词）";
  edInput.disabled = true;
  const edAuto = el("button", "shiyi-btn", "用识别结果");
  const edClear = el("button", "shiyi-btn", "清空");
  const edSave = el("button", "shiyi-btn primary", "保存");
  editor.append(edName, edInput, edAuto, edClear, edSave);

  panel.append(head, grid, editor, foot);
  openMask(panel);
  input.focus();

  let hovered = null;
  const store = await loadTriggerStore();

  const refreshEditor = () => {
    if (!hovered) {
      edName.textContent = "把鼠标移到卡片上";
      edInput.value = "";
      edInput.disabled = true;
      return;
    }
    edInput.disabled = false;
    edName.textContent = shortLabel(hovered);
    edName.title = hovered;
    edInput.value = Object.prototype.hasOwnProperty.call(store, hovered)
      ? String(store[hovered] ?? "")
      : "";
  };

  const commitTrigger = async (value) => {
    if (!hovered) return;
    await saveTrigger(hovered, value);
    for (const row of rowsOf(node)) {
      if (row.name === hovered) row.tw = value;
    }
    commit(node);
    const card = [...grid.children].find((element) => element.title === hovered);
    if (card) card.classList.toggle("has-tw", Boolean(value.trim()));
    toast(value.trim() ? `已保存触发词：${shortLabel(hovered)}` : `已设为不要触发词：${shortLabel(hovered)}`);
  };

  edSave.onclick = () => commitTrigger(edInput.value.trim());
  edInput.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") commitTrigger(edInput.value.trim());
  });
  edAuto.onclick = async () => {
    if (!hovered) return;
    try {
      const info = await getInfo(hovered);
      edInput.value = (info.triggers || []).join(", ");
    } catch {
      /* info 可选 */
    }
  };
  edClear.onclick = () => {
    edInput.value = "";
    if (hovered) commitTrigger("");
  };

  let items = [];
  let tops = [];

  const rebuildTops = () => {
    const counter = new Map();
    for (const item of items) {
      const key = topOf(item.folder || "");
      counter.set(key, (counter.get(key) || 0) + 1);
    }
    tops = [...counter.keys()].sort((a, b) => a.localeCompare(b, "zh"));
    const keep = topSel.value;
    topSel.replaceChildren();
    const all = document.createElement("option");
    all.value = "*";
    all.textContent = `一级目录：全部 (${items.length})`;
    topSel.appendChild(all);
    for (const key of tops) {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = `${key} (${counter.get(key)})`;
      topSel.appendChild(option);
    }
    topSel.value = tops.includes(keep) ? keep : "*";
  };

  const rebuildSubs = () => {
    const top = topSel.value;
    const counter = new Map();
    for (const item of items) {
      const folder = item.folder || "";
      if (top !== "*" && topOf(folder) !== top) continue;
      const sub = subOf(folder, top);
      counter.set(sub, (counter.get(sub) || 0) + 1);
    }
    const keep = subSel.value;
    subSel.replaceChildren();
    const all = document.createElement("option");
    all.value = "*";
    all.textContent = "二级目录：全部";
    subSel.appendChild(all);
    for (const key of [...counter.keys()].filter((key) => key !== "").sort((a, b) => a.localeCompare(b, "zh"))) {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = `${key} (${counter.get(key)})`;
      subSel.appendChild(option);
    }
    const rootCount = counter.get("");
    if (rootCount) {
      const option = document.createElement("option");
      option.value = "__root__";
      option.textContent = `（直接放在此目录） (${rootCount})`;
      subSel.appendChild(option);
    }
    subSel.value = [...subSel.options].some((option) => option.value === keep) ? keep : "*";
  };

  const filtered = () => {
    const top = topSel.value;
    const sub = subSel.value;
    const keyword = input.value.trim().toLowerCase();
    const onlyPreviewOn = onlyPrev.checked;
    return items
      .filter((item) => {
        const folder = item.folder || "";
        if (top !== "*" && topOf(folder) !== top) return false;
        if (sub !== "*") {
          const value = subOf(folder, top);
          if (sub === "__root__" ? value !== "" : value !== sub) return false;
        }
        if (onlyPreviewOn && !item.preview) return false;
        if (keyword && !item.name.toLowerCase().includes(keyword)) return false;
        return true;
      })
      .sort(SORTS[sortSel.value] || SORTS.folder);
  };

  const render = () => {
    const shown = filtered();
    grid.replaceChildren();
    for (const item of shown.slice(0, CARD_LIMIT)) {
      const card = el("div", "shiyi-card");
      if (currentName && item.name === currentName) card.classList.add("sel");
      const thumb = el("div", "shiyi-thumb");
      if (item.preview) {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.src = previewUrl(item.name);
        thumb.appendChild(img);
      } else {
        thumb.appendChild(el("span", "shiyi-ph", item.label.slice(0, 1).toUpperCase()));
      }
      card.append(thumb, el("div", "shiyi-nm", item.label), el("div", "shiyi-fd", item.folder || "(根目录)"));
      card.title = item.name;
      if (
        Object.prototype.hasOwnProperty.call(store, item.name) &&
        String(store[item.name] ?? "").trim()
      ) {
        card.classList.add("has-tw");
      }
      card.onmouseenter = () => {
        hovered = item.name;
        refreshEditor();
      };
      card.onclick = () => pick(node, replaceIndex, item.name);
      card.oncontextmenu = (event) => {
        event.preventDefault();
        pick(node, -1, item.name);
      };
      grid.appendChild(card);
    }
    countLabel.textContent =
      shown.length > CARD_LIMIT
        ? `${shown.length} 个命中，显示前 ${CARD_LIMIT} —— 用目录或搜索再收窄`
        : `${shown.length} 个 LoRA`;
  };

  try {
    items = await loadCatalog();
    rebuildTops();
    rebuildSubs();
    render();
  } catch (error) {
    countLabel.textContent = `加载失败：${error.message}`;
  }

  topSel.onchange = () => {
    rebuildSubs();
    render();
  };
  subSel.onchange = render;
  sortSel.onchange = render;
  onlyPrev.onchange = render;
  input.oninput = render;
  refreshBtn.onclick = async () => {
    INFO_CACHE.clear();
    THUMBS.clear();
    countLabel.textContent = "扫描中…";
    try {
      items = await loadCatalog(true);
      rebuildTops();
      rebuildSubs();
      render();
    } catch (error) {
      countLabel.textContent = `扫描失败：${error.message}`;
    }
  };
}

async function pick(node, replaceIndex, name) {
  const list = rowsOf(node);
  const defaultStrength = num(STATE.settings?.default_strength, 0.8);
  if (replaceIndex >= 0) {
    if (!list[replaceIndex]) return;
    list[replaceIndex].name = name;
    list[replaceIndex].tw = "";
  } else {
    list.push({ name, sm: defaultStrength, sc: defaultStrength, on: true, tw: "" });
  }
  commit(node);
  closeOverlay();

  const index = replaceIndex >= 0 ? replaceIndex : list.length - 1;
  const row = list[index];
  if (!row) return;

  // 1) 用户自己存过的触发词（空串＝明确不要）
  const store = await loadTriggerStore();
  if (Object.prototype.hasOwnProperty.call(store, name)) {
    row.tw = String(store[name] ?? "");
    commit(node);
    return;
  }
  // 2) 自动识别
  if (STATE.settings?.auto_trigger === false) return;
  if (row.tw) return;
  try {
    const info = await getInfo(name);
    if (row.tw) return;
    row.tw = (info.triggers || []).join(", ");
    if (!row.tw.trim()) {
      const rec = recommendTrigger(info);
      if (rec) row.tw = rec.tag;
    }
    commit(node);
  } catch {
    /* info 可选，失败不影响这一行 */
  }
}

/* 训练标签里挑一个当触发词：跳过一眼就不是触发词的通用标签 */
const GENERIC_TAGS = new Set([
  "1girl", "1boy", "2girls", "solo", "multiple girls", "solo focus",
  "looking at viewer", "simple background", "white background", "grey background",
  "smile", "open mouth", "closed mouth", "upper body", "full body", "cowboy shot",
  "breasts", "medium breasts", "large breasts", "blurry", "blurry background",
]);

function recommendTrigger(info) {
  const counts = Array.isArray(info?.tag_counts) ? info.tag_counts : [];
  const ranked = counts.filter(
    ([tag]) => tag && !GENERIC_TAGS.has(String(tag).trim().toLowerCase())
  );
  const source = ranked.length ? ranked : counts;
  if (source.length) {
    return { tag: String(source[0][0]), count: Number(source[0][1]) || 0 };
  }
  const first = (info?.triggers || [])[0];
  return first ? { tag: String(first), count: 0 } : null;
}

/* info ---------------------------------------------------------------- */

async function openInfo(node, index) {
  ensureStyle();
  const row = rowsOf(node)[index];
  if (!row) return;

  const panel = el("div", "shiyi-panel");
  panel.style.width = "760px";
  panel.style.maxHeight = "86vh";

  const head = el("div", "shiyi-head");
  const title = el("span", "", shortLabel(row.name));
  const closeBtn = el("span", "shiyi-x", "×");
  closeBtn.onclick = closeOverlay;
  head.append(title, el("span", "sp"), closeBtn);

  const meta = el("div", "shiyi-meta");
  meta.textContent = "读取中…";

  const scroll = el("div", "shiyi-scroll");
  scroll.style.maxHeight = "min(46vh,420px)";
  const desc = el("pre", "shiyi-desc", "");
  scroll.appendChild(desc);

  const secTrig = el("div", "shiyi-sec", "触发词候选（点击加入本行）");
  const chipsTrig = el("div", "shiyi-chips");
  const secTags = el("div", "shiyi-sec", "训练高频标签");
  const chipsTags = el("div", "shiyi-chips");

  const foot = el("div", "shiyi-foot");
  const smartBtn = el("button", "shiyi-btn primary", "智能添加");
  smartBtn.disabled = true;
  const applyAll = el("button", "shiyi-btn", "全部填入本行");
  const clearBtn = el("button", "shiyi-btn", "清空本行触发词");
  const copyBtn = el("button", "shiyi-btn", "复制说明");
  const spacer = el("span", "");
  spacer.style.flex = "1";
  foot.append(smartBtn, applyAll, clearBtn, copyBtn, spacer);

  panel.append(head, meta, scroll, secTrig, chipsTrig, secTags, chipsTags, foot);
  openMask(panel);

  let info;
  try {
    info = await getInfo(row.name);
  } catch (error) {
    meta.textContent = `读取失败：${error.message}`;
    return;
  }
  if (info.error) meta.textContent = `这个 LoRA 解析不到：${info.error}`;

  meta.replaceChildren();
  const sizeMb = info.size ? `${(info.size / 1048576).toFixed(1)} MB` : "大小未知";
  for (const [key, value] of [
    ["目录", info.folder || "(根目录)"],
    ["基础模型", info.base_model || "未知"],
    ["触发词来源", info.trigger_source || "无"],
    ["体积", sizeMb],
  ]) {
    const span = el("span");
    span.append(el("b", "", `${key}：`), document.createTextNode(String(value)));
    meta.appendChild(span);
  }

  const text = [info.description || "", info.notes || ""]
    .filter(Boolean)
    .join("\n\n——— 备注 ———\n")
    .trim();
  desc.textContent = text || "（这个 LoRA 没有 .txt 说明，也没有 civitai 描述）";
  if (info.preview) {
    const img = document.createElement("img");
    img.src = previewUrl(row.name);
    img.style.cssText =
      "max-width:100%;max-height:180px;object-fit:contain;border-radius:6px;margin:0 0 10px 0;display:block";
    scroll.insertBefore(img, desc);
  }

  const refreshChips = () => {
    const current = new Set(
      row.tw.split(",").map((word) => word.trim().toLowerCase()).filter(Boolean)
    );
    const paint = (container, words) => {
      container.replaceChildren();
      for (const word of words) {
        const chip = el("span", "shiyi-chip", word);
        if (current.has(word.toLowerCase())) chip.classList.add("on");
        chip.onclick = () => {
          const now = row.tw.split(",").map((item) => item.trim()).filter(Boolean);
          const exists = now.some((item) => item.toLowerCase() === word.toLowerCase());
          row.tw = exists
            ? now.filter((item) => item.toLowerCase() !== word.toLowerCase()).join(", ")
            : [...now, word].join(", ");
          commit(node);
          saveTrigger(row.name, row.tw);
          refreshChips();
        };
        container.appendChild(chip);
      }
      if (!words.length) container.appendChild(el("span", "shiyi-chip", "（无）"));
    };
    paint(chipsTrig, info.candidates || []);
    paint(chipsTags, info.top_tags || []);
  };
  refreshChips();

  const rec = recommendTrigger(info);
  if (rec) {
    smartBtn.disabled = false;
    smartBtn.textContent = rec.count
      ? `智能添加：${rec.tag}（训练 ${rec.count} 次）`
      : `智能添加：${rec.tag}`;
    smartBtn.title = "取训练标签里出现次数最多的词（已跳过 1girl/solo 之类通用标签）";
    smartBtn.onclick = () => {
      const now = row.tw.split(",").map((word) => word.trim()).filter(Boolean);
      const exists = now.some((word) => word.toLowerCase() === rec.tag.toLowerCase());
      if (!exists) now.push(rec.tag);
      row.tw = now.join(", ");
      commit(node);
      saveTrigger(row.name, row.tw);
      toast(`已加入触发词：${rec.tag}`);
      refreshChips();
    };
  } else {
    smartBtn.textContent = "智能添加（没有可推荐的词）";
  }

  applyAll.onclick = () => {
    row.tw = (info.triggers || []).join(", ");
    commit(node);
    saveTrigger(row.name, row.tw);
    toast(row.tw ? `已填入：${row.tw}` : "没有可填入的触发词");
    refreshChips();
  };
  clearBtn.onclick = () => {
    row.tw = "";
    commit(node);
    saveTrigger(row.name, "");
    refreshChips();
  };
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text || "");
      toast("说明已复制");
    } catch {
      toast("浏览器拒绝了剪贴板，请手动选中复制");
    }
  };
}

/* ------------------------------------------------------------ registration */

function attach(node) {
  const widget = stackWidget(node);
  if (widget) {
    widget.type = "hidden";
    widget.computeSize = () => [0, -4];
    node.__rows = parseRows(widget.value);
  } else if (!Array.isArray(node.__rows)) {
    node.__rows = [];
  }

  node.onDrawForeground = function (ctx) {
    if (this.flags?.collapsed) return;
    ctx.save();
    try {
      draw(this, ctx);
    } finally {
      ctx.restore();
    }
  };

  node.onMouseDown = function (event, pos) {
    if (!Array.isArray(pos) || pos.length < 2) return false;
    const L = layout(this);
    const list = rowsOf(this);

    for (const item of L.rows) {
      if (!inside(item.row, pos)) continue;
      const row = list[item.index];
      if (!row) return true;
      if (event.button === 2 && inside(item.str, pos)) {
        row.sm = num(STATE.settings?.default_strength, 0.8);
        row.sc = row.sm;
        commit(this);
        return true;
      }
      if (inside(item.cb, pos)) {
        row.on = !row.on;
        commit(this);
        return true;
      }
      if (inside(item.del, pos)) {
        list.splice(item.index, 1);
        commit(this);
        return true;
      }
      if (inside(item.info, pos)) {
        openInfo(this, item.index);
        return true;
      }
      if (inside(item.str, pos)) {
        editStrength(this, item.index, event);
        return true;
      }
      if (inside(item.name, pos) || inside(item.thumb, pos)) {
        openPicker(this, item.index);
        return true;
      }
      return true;
    }

    if (inside(L.footer, pos)) {
      openPicker(this, -1);
      return true;
    }
    return false;
  };

  node.getExtraMenuOptions = function (_, options) {
    const allEnabled = rowsOf(this).length > 0 && rowsOf(this).every((row) => row.on);
    options.push(
      { content: "添加 LoRA", callback: () => openPicker(this, -1) },
      {
        content: allEnabled ? "全部取消启用" : "全部启用",
        callback: () => {
          rowsOf(this).forEach((row) => {
            row.on = !allEnabled;
          });
          commit(this);
        },
      },
      {
        content: "全部权重复位 1.0",
        callback: () => {
          rowsOf(this).forEach((row) => {
            row.sm = 1;
            row.sc = 1;
          });
          commit(this);
        },
      },
      {
        content: "刷新 LoRA 目录",
        callback: async () => {
          INFO_CACHE.clear();
          THUMBS.clear();
          try {
            await loadCatalog(true);
            toast("目录已重新扫描");
          } catch (error) {
            toast(`扫描失败：${error.message}`);
          }
        },
      }
    );
  };

  const onRemoved = node.onRemoved;
  node.onRemoved = function () {
    closeStrengthEditor();
    onRemoved?.apply(this, arguments);
  };

  fit(node);
  node.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: "shiyi.lora.composer",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_NAME) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      attach(this);
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      onConfigure?.apply(this, arguments);
      const widget = stackWidget(this);
      if (widget) this.__rows = parseRows(widget.value);
      fit(this);
      this.setDirtyCanvas(true, true);
    };
  },
});

// Console hook: 手工拼行 / 排查渲染时用
window.__shiyiLora = { rowsOf, commit, fit, openPicker, openInfo, loadCatalog, getInfo, layout, socketTop };







