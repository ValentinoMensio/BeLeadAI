/**
 * Panel de destinatarios: chips seleccionables y resumen.
 */

/**
 * Rellena la lista de destinatarios con chips (activar/desactivar).
 * @param {{ listEl: HTMLElement, toggleEl: HTMLElement, actionsEl: HTMLElement|null, summaryEl: HTMLElement|null }} container
 * @param {string[]} usernames
 * @param {Set<string>} selectedSet - se modifica in-place al hacer clic en chips
 * @param {() => void} onSelectionChange - llamado tras cambiar selección
 * @param {string} kindLabel - "perfiles" | "followings"
 */
export function renderRecipients(container, usernames, selectedSet, onSelectionChange, kindLabel = "followings") {
  const { listEl, toggleEl, actionsEl, summaryEl } = container;
  if (!listEl || !toggleEl) return;
  const list = Array.isArray(usernames) ? usernames.map((u) => String(u || "").trim()).filter(Boolean) : [];
  selectedSet.clear();
  list.forEach((u) => selectedSet.add(u));
  listEl.innerHTML = "";
  list.forEach((u) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "recipient-chip selected";
    chip.textContent = "@" + (u || "—");
    chip.title = "Clic para activar/desactivar";
    chip.dataset.username = u;
    chip.addEventListener("click", () => {
      if (selectedSet.has(u)) {
        selectedSet.delete(u);
        chip.classList.remove("selected");
        chip.classList.add("deselected");
      } else {
        selectedSet.add(u);
        chip.classList.remove("deselected");
        chip.classList.add("selected");
      }
      onSelectionChange();
    });
    listEl.appendChild(chip);
  });
  if (actionsEl) actionsEl.style.display = "none";
  listEl.style.display = "none";
  toggleEl.setAttribute("aria-expanded", "false");
  updateSummary(summaryEl, list.length, selectedSet.size, kindLabel);
}

/**
 * Actualiza solo el texto del resumen.
 */
export function updateRecipientsSummaryLabel(summaryEl, total, selectedCount, kindLabel = "followings") {
  updateSummary(summaryEl, total, selectedCount, kindLabel);
}

function updateSummary(el, total, selected, kindLabel) {
  if (!el) return;
  el.textContent = `${total} ${kindLabel} · ${selected} seleccionado${selected === 1 ? "" : "s"} para enviar`;
}
