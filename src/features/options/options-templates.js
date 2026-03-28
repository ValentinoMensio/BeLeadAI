function createIcon(src) {
  const icon = document.createElement("img");
  icon.className = "quotas-account-icon-img";
  icon.src = src;
  icon.alt = "";
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function appendText(parent, text) {
  parent.appendChild(document.createTextNode(String(text || "")));
}

function createAccountName(nameText, suffixText = "") {
  const name = document.createElement("div");
  name.className = "account-name";
  name.appendChild(createIcon("icons/user.svg"));
  appendText(name, nameText);
  if (suffixText) {
    const suffix = document.createElement("span");
    suffix.style.color = "var(--muted)";
    suffix.style.fontWeight = "400";
    suffix.style.fontSize = "11px";
    suffix.textContent = suffixText;
    name.appendChild(document.createTextNode(" "));
    name.appendChild(suffix);
  }
  return name;
}

function createQuotaRow({ label, valueText, fillId = "", wrapId = "", width = "0%" }) {
  const row = document.createElement("div");
  row.className = "quotas-row";

  const quotaLabel = document.createElement("span");
  quotaLabel.className = "quotas-label";
  quotaLabel.textContent = label;

  const progressWrap = document.createElement("div");
  progressWrap.className = "quotas-progress-wrap";

  const progress = document.createElement("div");
  progress.className = "progress";
  if (wrapId) progress.id = wrapId;

  const fill = document.createElement("div");
  if (fillId) fill.id = fillId;
  fill.style.width = width;

  progress.appendChild(fill);
  progressWrap.appendChild(progress);

  const quotaValue = document.createElement("span");
  quotaValue.className = "quotas-value";
  quotaValue.textContent = valueText;

  row.append(quotaLabel, progressWrap, quotaValue);
  return row;
}

function createProgressText(text) {
  const el = document.createElement("div");
  el.className = "progress-text";
  el.textContent = text;
  return el;
}

export function renderPendingLinkAccountCard(tabAccount, limitStr, resetText) {
  const fragment = document.createDocumentFragment();
  fragment.appendChild(createAccountName(tabAccount, "(en pestaña, aún no enlazada)"));
  fragment.appendChild(
    createQuotaRow({
      label: "24h",
      valueText: `0 / ${limitStr}`,
      width: "0%",
    })
  );
  fragment.appendChild(createProgressText(resetText));
  return fragment;
}

export function renderNoLinkedAccountsCard() {
  const fragment = document.createDocumentFragment();
  fragment.appendChild(createAccountName("Ninguna cuenta enlazada"));
  fragment.appendChild(
    createProgressText(
      "Enviá un mensaje desde el popup para enlazar la cuenta detectada en la pestaña."
    )
  );
  return fragment;
}

export function renderQuotaAccountCard(name, used, limitStr, resetText, barId) {
  const fragment = document.createDocumentFragment();
  const normalizedName = String(name || "").startsWith("@") ? String(name || "") : `@${name}`;
  fragment.appendChild(createAccountName(normalizedName));
  fragment.appendChild(
    createQuotaRow({
      label: "24h",
      valueText: `${used} / ${limitStr}`,
      fillId: barId,
      wrapId: `${barId}_wrap`,
      width: "0%",
    })
  );
  fragment.appendChild(createProgressText(resetText));
  return fragment;
}
