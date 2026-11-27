import { applyI18nToTree } from "../utils.js";

/**
 * Idempotently mounts a <dialog> modal template into document.body and
 * immediately applies the active i18n language to all translated nodes inside it.
 */
export function mountModalTemplate(id, html) {
  const existing = document.getElementById(id);
  if (existing) return existing;
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  const node = tpl.content.firstElementChild;
  if (!node) return null;
  document.body.append(node);
  applyI18nToTree(node);
  return node;
}
