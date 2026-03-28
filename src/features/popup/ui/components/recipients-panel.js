/**
 * Panel de destinatarios: chips seleccionables y resumen.
 */

/**
 * Rellena la lista de destinatarios con chips (activar/desactivar).
 * @param {{ listEl: HTMLElement, toggleEl: HTMLElement, actionsEl: HTMLElement|null, summaryEl: HTMLElement|null }} container
 * @param {string[]} usernames
 * @param {string[]} selectedUsernames
 * @param {(username: string) => void} onToggleRecipient
 * @param {() => void} onSelectionChange
 * @param {string} kindLabel - "perfiles" | "followings"
 */
export function renderRecipients(
  container,
  usernames,
  selectedUsernames,
  onToggleRecipient,
  onSelectionChange,
  kindLabel = "followings",
  summary = null
) {
  const { listEl, toggleEl, actionsEl, summaryEl } = container;
  if (!listEl || !toggleEl) return;
  const list = Array.isArray(usernames)
    ? usernames.map((u) => String(u || "").trim()).filter(Boolean)
    : [];
  const selectedSet = new Set(Array.isArray(selectedUsernames) ? selectedUsernames : []);
  listEl.replaceChildren();
  list.forEach((u) => {
    const chip = document.createElement("button");
    chip.type = "button";
    const selected = selectedSet.has(u);
    chip.className = `recipient-chip ${selected ? "selected" : "deselected"}`;
    chip.textContent = "@" + (u || "—");
    chip.title = "Clic para activar/desactivar";
    chip.dataset.username = u;
    chip.addEventListener("click", () => {
      onToggleRecipient(u);
      onSelectionChange();
    });
    listEl.appendChild(chip);
  });
  if (actionsEl) actionsEl.style.display = "none";
  listEl.style.display = "none";
  toggleEl.setAttribute("aria-expanded", "false");
  updateSummary(summaryEl, list.length, selectedSet.size, kindLabel, summary);
}

/**
 * Actualiza solo el texto del resumen.
 */
export function updateRecipientsSummaryLabel(
  summaryEl,
  total,
  selectedCount,
  kindLabel = "followings",
  summary = null
) {
  updateSummary(summaryEl, total, selectedCount, kindLabel, summary);
}

function updateSummary(el, total, selected, kindLabel, summary = null) {
  if (!el) return;
  if (summary && typeof summary === "object") {
    const matched = Number(summary.matchedCount || total || 0);
    const visible = Number(summary.visibleCount || 0);
    el.textContent = `${matched} ${kindLabel} encontrados · ${visible} cargados · ${selected} seleccionado${selected === 1 ? "" : "s"}`;
    return;
  }
  el.textContent = `${total} ${kindLabel} · ${selected} seleccionado${selected === 1 ? "" : "s"} para enviar`;
}
