export function renderPendingLinkAccountCard(tabAccount, limitStr, resetText, escapeHtml) {
  return (
    '<div class="account-name"><img class="quotas-account-icon-img" src="icons/user.svg" alt="" aria-hidden="true" />' +
    escapeHtml(tabAccount) +
    ' <span style="color:var(--muted);font-weight:400;font-size:11px;">(en pestaña, aún no enlazada)</span></div>' +
    '<div class="quotas-row"><span class="quotas-label">24h</span><div class="quotas-progress-wrap"><div class="progress"><div style="width:0%"></div></div></div><span class="quotas-value">0 / ' +
    limitStr +
    "</span></div>" +
    '<div class="progress-text">' +
    escapeHtml(resetText) +
    "</div>"
  );
}

export function renderNoLinkedAccountsCard() {
  return (
    '<div class="account-name"><img class="quotas-account-icon-img" src="icons/user.svg" alt="" aria-hidden="true" />Ninguna cuenta enlazada</div>' +
    '<div class="progress-text">Enviá un mensaje desde el popup para enlazar la cuenta de la pestaña (cookie).</div>'
  );
}

export function renderQuotaAccountCard(name, used, limitStr, resetText, barId, escapeHtml) {
  return (
    '<div class="account-name"><img class="quotas-account-icon-img" src="icons/user.svg" alt="" aria-hidden="true" />' +
    (name.indexOf("@") === 0 ? escapeHtml(name) : "@" + escapeHtml(name)) +
    "</div>" +
    '<div class="quotas-row"><span class="quotas-label">24h</span><div class="quotas-progress-wrap"><div class="progress" id="' +
    barId +
    '_wrap"><div id="' +
    barId +
    '"></div></div></div><span class="quotas-value">' +
    used +
    " / " +
    limitStr +
    "</span></div>" +
    '<div class="progress-text">' +
    escapeHtml(resetText) +
    "</div>"
  );
}
