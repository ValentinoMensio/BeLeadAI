/**
 * Helpers DOM: selectores, eventos, texto seguro.
 */

export const qs = (sel, root = document) =>
  typeof sel === "string" ? root.querySelector(sel) : sel;
export const qsa = (sel, root = document) =>
  typeof sel === "string" ? root.querySelectorAll(sel) : [];

export function on(el, eventName, fn) {
  if (el) el.addEventListener(eventName, fn);
}

export function setText(el, text) {
  if (el) el.textContent = text ?? "";
}

export function setHtmlSafe(el, html) {
  if (!el) return;
  el.innerHTML = html ?? "";
}

export function escapeHtml(str) {
  if (str == null) return "";
  const s = String(str);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function createEl(tag, attrs = {}) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") el.className = v;
    else if (k === "dataset" && v && typeof v === "object") {
      for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
    } else if (k === "textContent") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v != null && !k.startsWith("on")) el.setAttribute(k, v);
  }
  return el;
}
