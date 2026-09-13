"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = {
  accounts: [], cases: [], selectedAccounts: new Set(), selectedCases: new Set(),
  scanJobId: null, scanResult: null, testJobId: null, testResult: null, settings: {},
  timer: null, elapsedTimer: null, startedAt: null, currentCapture: null,
};

document.addEventListener("DOMContentLoaded", initialize);

async function initialize() {
  bindEvents();
  try { state.settings = await api("/api/settings"); applySettings(); } catch (_) {}
  await refreshSavedData();
}

function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  $$('[data-go="accounts"]').forEach((button) => button.addEventListener("click", () => showView("accounts")));
  $$(".toggle-secret").forEach((button) => button.addEventListener("click", () => toggleSecret(button)));
  $("#scan-form").addEventListener("submit", startScan);
  $("#cancel-button").addEventListener("click", cancelScan);
  $("#mutation-probing").addEventListener("change", (event) => $("#mutation-confirm").classList.toggle("hidden", !event.target.checked));
  $("#discovery-account").addEventListener("change", syncDiscoveryAccount);
  $("#endpoint-search").addEventListener("input", renderEndpointRows);
  $("#method-filter").addEventListener("change", renderEndpointRows);
  $("#source-filter").addEventListener("change", renderEndpointRows);
  ["#max-pages","#max-depth","#delay","#timeout","#max-route-variants","#normalize-dynamic-ids","#normalize-query-values","#custom-id-patterns","#ignore-path-patterns","#subdomains","#ignore-tls","#openapi","#safe-probing"].forEach((selector) => { const node = $(selector); if (node) node.addEventListener("change", () => void persistScanSettings(collectScanSettings())); });
  $$(".tab").forEach((button) => button.addEventListener("click", () => switchDiscoveryTab(button.dataset.tab)));

  $("#add-account-button").addEventListener("click", () => openAccountModal());
  $("#account-auth-mode").addEventListener("change", syncAccountAuthFields);
  $("#account-form").addEventListener("submit", saveAccount);
  $("#account-search").addEventListener("input", renderAccounts);
  $("#test-account-search").addEventListener("input", renderTestAccounts);
  $("#finish-login").addEventListener("click", finishLoginCapture);
  $("#cancel-login").addEventListener("click", cancelLoginCapture);

  $("#add-case-button").addEventListener("click", () => openCaseModal());
  $("#case-form").addEventListener("submit", saveCase);
  $("#case-search").addEventListener("input", renderCases);
  $("#case-method-filter").addEventListener("change", renderCases);
  $("#include-crawl").addEventListener("change", syncCrawlOptions);
  $("#start-test-run").addEventListener("click", startTestRun);
  $("#cancel-test-run").addEventListener("click", cancelTestRun);
  $("#test-result-search").addEventListener("input", renderTestResultRows);
  $("#test-result-filter").addEventListener("change", renderTestResultRows);

  $$(".modal-close, .modal-cancel").forEach((button) => button.addEventListener("click", closeModals));
  $("#modal-backdrop").addEventListener("click", closeModals);
  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#drawer-backdrop").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeDrawer(); closeModals(); } });
}

async function refreshSavedData() {
  try {
    const [accountsResponse, casesResponse] = await Promise.all([fetch("/api/accounts"), fetch("/api/test-cases")]);
    state.accounts = await accountsResponse.json();
    state.cases = await casesResponse.json();
    const accountIds = new Set(state.accounts.map((item) => item.id));
    const caseIds = new Set(state.cases.map((item) => item.id));
    state.selectedAccounts = new Set([...state.selectedAccounts].filter((id) => accountIds.has(id)));
    state.selectedCases = new Set([...state.selectedCases].filter((id) => caseIds.has(id)));
    renderAllSavedData();
  } catch (error) {
    toast("Could not load saved accounts and test cases.", true);
  }
}

function renderAllSavedData() {
  renderDiscoveryAccountOptions(); renderAccounts(); renderTestAccounts(); renderCases(); renderExpectations(); updateRunSummary();
}

function showView(name) {
  $$(".app-view").forEach((view) => view.classList.add("hidden"));
  $(`#${name}-view`).classList.remove("hidden");
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $("#discovery-controls").classList.toggle("hidden", name !== "discovery");
}

function renderDiscoveryAccountOptions() {
  const selected = $("#discovery-account").value;
  $("#discovery-account").innerHTML = '<option value="">No saved account</option>' + state.accounts.map((account) =>
    `<option value="${account.id}">${escapeHtml(account.name)}${account.has_session ? " · session" : account.has_bearer_token ? " · token" : " · not signed in"}</option>`
  ).join("");
  if (state.accounts.some((item) => item.id === selected)) $("#discovery-account").value = selected;
  syncDiscoveryAccount();
}

function syncDiscoveryAccount() {
  const id = $("#discovery-account").value;
  $("#discovery-token-field").classList.toggle("hidden", Boolean(id));
  const account = state.accounts.find((item) => item.id === id);
  if (account && !$("#target-url").value) $("#target-url").value = account.base_url;
}

function lines(selector) { return $(selector).value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean); }
function applySettings() { const v = state.settings || {}; const fields = {"#max-pages":v.max_pages,"#max-depth":v.max_depth,"#delay":v.request_delay_ms,"#timeout":v.navigation_timeout_ms,"#max-route-variants":v.max_route_variants}; Object.entries(fields).forEach(([selector,value]) => { if ($(selector) && value != null) $(selector).value = value; }); if (v.normalize_dynamic_ids != null && $("#normalize-dynamic-ids")) $("#normalize-dynamic-ids").checked = v.normalize_dynamic_ids; if (v.normalize_query_values != null && $("#normalize-query-values")) $("#normalize-query-values").checked = v.normalize_query_values; if (v.custom_id_patterns && $("#custom-id-patterns")) $("#custom-id-patterns").value = v.custom_id_patterns.join("\n"); if (v.ignore_path_patterns && $("#ignore-path-patterns")) $("#ignore-path-patterns").value = v.ignore_path_patterns.join("\n"); }
function collectScanSettings() { return {max_pages:numberValue("#max-pages"),max_depth:numberValue("#max-depth"),request_delay_ms:numberValue("#delay"),navigation_timeout_ms:numberValue("#timeout"),include_subdomains:$("#subdomains").checked,ignore_https_errors:$("#ignore-tls").checked,discover_openapi:$("#openapi").checked,safe_probing:$("#safe-probing").checked,normalize_dynamic_ids:$("#normalize-dynamic-ids").checked,max_route_variants:numberValue("#max-route-variants"),custom_id_patterns:lines("#custom-id-patterns"),ignore_path_patterns:lines("#ignore-path-patterns"),normalize_query_values:$("#normalize-query-values").checked}; }
async function persistScanSettings(payload) { try { state.settings = await api("/api/settings", {method:"PUT", body: JSON.stringify(payload)}); } catch (_) {} }

async function startScan(event) {
  event.preventDefault();
  let headers;
  try { headers = parseJsonField("#extra-headers", {}, "Extra headers"); } catch (error) { return toast(error.message, true); }
  const payload = {
    account_id: $("#discovery-account").value || null,
    target_url: $("#target-url").value.trim(), bearer_token: $("#bearer-token").value.trim(),
    max_pages: numberValue("#max-pages"), max_depth: numberValue("#max-depth"), request_delay_ms: numberValue("#delay"),
    navigation_timeout_ms: numberValue("#timeout"), ignore_https_errors: $("#ignore-tls").checked,
    include_subdomains: $("#subdomains").checked, discover_openapi: $("#openapi").checked,
    safe_probing: $("#safe-probing").checked, active_mutation_probing: $("#mutation-probing").checked,
    authorization_confirmation: $("#authorization-confirmation").value, extra_headers: headers,
    normalize_dynamic_ids: $("#normalize-dynamic-ids").checked, max_route_variants: numberValue("#max-route-variants"),
    custom_id_patterns: lines("#custom-id-patterns"), ignore_path_patterns: lines("#ignore-path-patterns"), normalize_query_values: $("#normalize-query-values").checked,
  };
  if (payload.active_mutation_probing && payload.authorization_confirmation !== "I AM AUTHORIZED") return toast('Type “I AM AUTHORIZED” exactly.', true);
  await persistScanSettings(collectScanSettings());
  setScanRunning(true); showDiscoveryState("progress"); startClock("#elapsed-time"); updateScanProgress({phase: "Starting scan", progress: 1, pages_visited: 0, endpoints_found: 0});
  try {
    const response = await api("/api/scans", {method: "POST", body: JSON.stringify(payload)});
    state.scanJobId = response.id; pollScan();
  } catch (error) { stopClock(); setScanRunning(false); showDiscoveryState("empty"); toast(error.message, true); }
}

async function pollScan() {
  try {
    const job = await api(`/api/scans/${state.scanJobId}`); updateScanProgress(job);
    if (job.status === "completed") {
      state.scanResult = job.result; stopClock(); setScanRunning(false); renderDiscoveryResults(); showDiscoveryState("results"); configureScanExports(); return toast(`Found ${job.endpoints_found} endpoints.`);
    }
    if (job.status === "failed") throw new Error(job.error || "Scan failed.");
    if (job.status === "cancelled") { stopClock(); setScanRunning(false); showDiscoveryState("empty"); return toast("Scan cancelled."); }
    state.timer = setTimeout(pollScan, 700);
  } catch (error) { stopClock(); setScanRunning(false); showDiscoveryState("empty"); toast(error.message, true); }
}

async function cancelScan() { if (state.scanJobId) await api(`/api/scans/${state.scanJobId}/cancel`, {method: "POST"}); }
function updateScanProgress(job) { $("#phase-label").textContent = job.phase; $("#progress-number").textContent = `${job.progress || 0}%`; $("#progress-bar").style.width = `${job.progress || 0}%`; $("#live-pages").textContent = job.pages_visited || 0; $("#live-endpoints").textContent = job.endpoints_found || 0; }
function setScanRunning(value) { $("#start-button").disabled = value; $("#cancel-button").classList.toggle("hidden", !value); $("#export-menu").classList.add("hidden"); }
function showDiscoveryState(name) { $("#empty-state").classList.toggle("hidden", name !== "empty"); $("#scan-progress").classList.toggle("hidden", name !== "progress"); $("#results").classList.toggle("hidden", name !== "results"); }
function configureScanExports() { $("#export-menu").classList.remove("hidden"); ["json", "csv", "xlsx"].forEach((format) => bindExport($(`#export-${format}`), `/api/scans/${state.scanJobId}`, format)); }

function renderDiscoveryResults() {
  const endpoints = state.scanResult.endpoints || [], pages = state.scanResult.pages || [];
  $("#stat-endpoints").textContent = endpoints.length; $("#stat-runtime").textContent = `${endpoints.filter((item) => item.discovered_by.includes("runtime")).length} seen live`;
  $("#stat-pages").textContent = pages.length; $("#stat-errors").textContent = `${pages.filter((item) => item.error).length} crawl errors`;
  $("#stat-payloads").textContent = endpoints.filter((item) => item.request.has_body || item.request.static_payload_fields.length).length;
  $("#stat-methods").textContent = new Set(endpoints.map((item) => item.method)).size;
  $("#stat-routes").textContent = state.scanResult.scan?.route_shapes?.count || 0; $("#stat-skipped").textContent = `${state.scanResult.scan?.route_shapes?.skipped_variants || 0} variants skipped`;
  $("#issue-count").textContent = (state.scanResult.warnings || []).length + (state.scanResult.errors || []).length;
  $("#method-filter").innerHTML = '<option value="">All methods</option>' + [...new Set(endpoints.map((item) => item.method))].sort().map((method) => `<option>${method}</option>`).join("");
  renderEndpointRows(); renderDiscoveryPages(); renderDiscoveryIssues();
}

function renderEndpointRows() {
  if (!state.scanResult) return;
  const term = $("#endpoint-search").value.toLowerCase(), method = $("#method-filter").value, source = $("#source-filter").value;
  const endpoints = state.scanResult.endpoints.filter((item) => (!term || JSON.stringify(item).toLowerCase().includes(term)) && (!method || item.method === method) && (!source || item.discovered_by.includes(source)));
  $("#result-count").textContent = `${endpoints.length} of ${state.scanResult.endpoints.length}`; $("#no-results").classList.toggle("hidden", endpoints.length > 0);
  $("#endpoint-rows").innerHTML = endpoints.map((endpoint) => {
    const exact = endpoint.concrete_urls[0] || `${endpoint.origin}${endpoint.path}`;
    const statuses = endpoint.status_codes.length ? endpoint.status_codes.map((code) => `<span class="status-code ${statusClass(code)}">${code}</span>`).join(" · ") : '<span class="subtext">Not called</span>';
    const from = endpoint.called_from[0];
    return `<tr><td>${methodPill(endpoint.method)}</td><td class="path-cell">${escapeHtml(endpoint.path)}<span class="subtext">${escapeHtml(exact)}</span></td><td>${statuses}</td><td>${endpoint.request.has_body ? '<span class="status-code status-warn">Body</span>' : '<span class="subtext">None seen</span>'}</td><td><div class="source-tags">${endpoint.discovered_by.map((item) => `<span class="source-tag">${escapeHtml(item)}</span>`).join("")}</div></td><td>${escapeHtml(from ? compactUrl(from.page || from.source || "") : "Not mapped")}${endpoint.called_from.length > 1 ? `<span class="subtext">+${endpoint.called_from.length - 1} more</span>` : ""}</td><td><button class="view-button" data-endpoint="${endpoint.id}" type="button">›</button></td></tr>`;
  }).join("");
  $$(".view-button[data-endpoint]").forEach((button) => button.addEventListener("click", () => openEndpointDrawer(button.dataset.endpoint)));
}

function renderDiscoveryPages() { $("#page-rows").innerHTML = state.scanResult.pages.map((page) => `<tr><td><span class="status-code ${statusClass(page.status)}">${page.status || "—"}</span></td><td class="path-cell">${escapeHtml(page.url)}</td><td>${escapeHtml(page.title || "")}</td><td>${page.depth}</td><td>${escapeHtml(page.error || "")}</td></tr>`).join(""); }
function renderDiscoveryIssues() { const list = [...(state.scanResult.warnings || []).map((message) => ({message, type: "warning"})), ...(state.scanResult.errors || []).map((message) => ({message, type: "error"}))]; $("#issue-list").innerHTML = list.length ? list.map((item) => `<div class="issue ${item.type === "error" ? "error" : ""}">${escapeHtml(item.message)}</div>`).join("") : '<div class="no-results">No scan issues.</div>'; }
function switchDiscoveryTab(name) { $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name)); ["endpoints", "pages", "issues"].forEach((item) => $(`#${item}-panel`).classList.toggle("hidden", item !== name)); }

function renderAccounts() {
  const term = $("#account-search").value.toLowerCase(); const accounts = state.accounts.filter((item) => item.name.toLowerCase().includes(term) || item.base_url.toLowerCase().includes(term));
  $("#account-count").textContent = `${accounts.length} account${accounts.length === 1 ? "" : "s"}`;
  $("#account-grid").innerHTML = accounts.length ? accounts.map((account) => `<article class="account-card"><div class="account-card-head"><div><div class="account-avatar">${escapeHtml(initials(account.name))}</div><h2>${escapeHtml(account.name)}</h2></div>${methodTag(account.auth_mode)}</div><div class="account-url">${escapeHtml(account.base_url)}</div><div class="session-state ${account.has_session || account.has_bearer_token ? "ready" : ""}"><span></span>${account.has_session ? "Browser session saved" : account.has_bearer_token ? "Bearer token saved" : "Login required"}</div><div class="account-tags">${account.has_session ? "<span>cookies</span><span>browser storage</span>" : ""}${Object.keys(account.variables || {}).length ? `<span>${Object.keys(account.variables).length} variables</span>` : ""}${account.allowed_origins.length ? `<span>${account.allowed_origins.length} API origins</span>` : ""}</div><div class="account-actions"><button class="login-action" data-login="${account.id}" type="button">${account.has_session ? "Refresh login" : "Open login"}</button><button data-edit-account="${account.id}" type="button">Edit</button><button data-delete-account="${account.id}" type="button">Delete</button></div></article>`).join("") : '<div class="empty-collection"><h2>No accounts yet</h2><p>Add a real test user, then capture its signed-in browser session.</p></div>';
  $$('[data-login]').forEach((button) => button.addEventListener("click", () => startLoginCapture(button.dataset.login)));
  $$('[data-edit-account]').forEach((button) => button.addEventListener("click", () => openAccountModal(button.dataset.editAccount)));
  $$('[data-delete-account]').forEach((button) => button.addEventListener("click", () => deleteAccount(button.dataset.deleteAccount)));
}

function openAccountModal(id = "") {
  const account = state.accounts.find((item) => item.id === id);
  $("#account-form").reset(); $("#account-id").value = id; $("#account-modal-title").textContent = account ? "Edit test account" : "Add test account";
  if (account) {
    $("#account-name").value = account.name; $("#account-base-url").value = account.base_url; $("#account-login-url").value = account.login_url;
    $("#account-auth-mode").value = account.auth_mode; $("#account-username").value = account.username || ""; $("#username-selector").value = account.username_selector;
    $("#password-selector").value = account.password_selector; $("#submit-selector").value = account.submit_selector; $("#token-storage-key").value = account.token_storage_key || "";
    $("#allowed-origins").value = (account.allowed_origins || []).join("\n"); $("#account-extra-headers").value = objectText(account.extra_headers); $("#account-variables").value = objectText(account.variables);
  }
  syncAccountAuthFields(); openModal("#account-modal");
}

function syncAccountAuthFields() { const mode = $("#account-auth-mode").value; $("#account-bearer-fields").classList.toggle("hidden", mode !== "bearer"); $("#account-form-fields").classList.toggle("hidden", mode !== "form"); }

async function saveAccount(event) {
  event.preventDefault();
  let extraHeaders, variables;
  try { extraHeaders = parseJsonField("#account-extra-headers", {}, "Extra headers"); variables = parseJsonField("#account-variables", {}, "Per-user variables"); } catch (error) { return toast(error.message, true); }
  const id = $("#account-id").value;
  const payload = {
    name: $("#account-name").value.trim(), base_url: $("#account-base-url").value.trim(), login_url: $("#account-login-url").value.trim() || null,
    auth_mode: $("#account-auth-mode").value, username: $("#account-username").value, password: $("#account-password").value,
    bearer_token: $("#account-bearer").value, username_selector: $("#username-selector").value, password_selector: $("#password-selector").value,
    submit_selector: $("#submit-selector").value, token_storage_key: $("#token-storage-key").value.trim(), extra_headers: extraHeaders,
    allowed_origins: $("#allowed-origins").value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean), variables,
  };
  try { await api(id ? `/api/accounts/${id}` : "/api/accounts", {method: id ? "PUT" : "POST", body: JSON.stringify(payload)}); closeModals(); await refreshSavedData(); toast(id ? "Account updated." : "Account saved. Open its login window to capture the full session."); } catch (error) { toast(error.message, true); }
}

async function deleteAccount(id) { const account = state.accounts.find((item) => item.id === id); if (!account || !confirm(`Delete “${account.name}” and its encrypted session?`)) return; try { await api(`/api/accounts/${id}`, {method: "DELETE"}); await refreshSavedData(); toast("Account deleted."); } catch (error) { toast(error.message, true); } }
async function startLoginCapture(id) { const account = state.accounts.find((item) => item.id === id); if (!account) return; try { toast("Opening the Playwright login window…"); await api(`/api/accounts/${id}/session/start`, {method: "POST"}); state.currentCapture = id; $("#login-banner-name").textContent = `Login as ${account.name}`; $("#login-banner").classList.remove("hidden"); } catch (error) { toast(error.message, true); } }
async function finishLoginCapture() { if (!state.currentCapture) return; $("#finish-login").disabled = true; try { await api(`/api/accounts/${state.currentCapture}/session/finish`, {method: "POST"}); state.currentCapture = null; $("#login-banner").classList.add("hidden"); await refreshSavedData(); toast("Signed-in session saved and encrypted."); } catch (error) { toast(error.message, true); } finally { $("#finish-login").disabled = false; } }
async function cancelLoginCapture() { if (!state.currentCapture) return; await api(`/api/accounts/${state.currentCapture}/session/cancel`, {method: "POST"}); state.currentCapture = null; $("#login-banner").classList.add("hidden"); }

function renderTestAccounts() {
  const term = $("#test-account-search").value.toLowerCase(); const accounts = state.accounts.filter((item) => item.name.toLowerCase().includes(term));
  const container = $("#test-account-list"); container.classList.toggle("empty-list", !accounts.length);
  container.innerHTML = accounts.length ? accounts.map((account) => `<label class="select-row"><input type="checkbox" data-select-account="${account.id}" ${state.selectedAccounts.has(account.id) ? "checked" : ""}><div><strong>${escapeHtml(account.name)}</strong><small>${escapeHtml(account.base_url)}</small></div><span class="select-meta">${account.has_session ? "SESSION" : account.has_bearer_token ? "TOKEN" : "NO AUTH"}</span></label>`).join("") : "No accounts saved yet.";
  $$('[data-select-account]').forEach((input) => input.addEventListener("change", () => { toggleSet(state.selectedAccounts, input.dataset.selectAccount, input.checked); updateRunSummary(); }));
}

function renderCases() {
  const term = $("#case-search").value.toLowerCase(), method = $("#case-method-filter").value;
  const cases = state.cases.filter((item) => (!term || JSON.stringify([item.name, item.url, item.notes]).toLowerCase().includes(term)) && (!method || item.method === method));
  const container = $("#test-case-list"); container.classList.toggle("empty-list", !cases.length);
  container.innerHTML = cases.length ? cases.map((item) => `<label class="select-row"><input type="checkbox" data-select-case="${item.id}" ${state.selectedCases.has(item.id) ? "checked" : ""}><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.url)}</small></div><span class="select-meta">${item.method}</span><span class="row-actions"><button data-edit-case="${item.id}" type="button">Edit</button><button data-delete-case="${item.id}" type="button">×</button></span></label>`).join("") : "No test cases saved yet.";
  $$('[data-select-case]').forEach((input) => input.addEventListener("change", () => { toggleSet(state.selectedCases, input.dataset.selectCase, input.checked); updateRunSummary(); }));
  $$('[data-edit-case]').forEach((button) => button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); openCaseModal(button.dataset.editCase); }));
  $$('[data-delete-case]').forEach((button) => button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); deleteCase(button.dataset.deleteCase); }));
}

function openCaseModal(id = "") {
  const item = state.cases.find((entry) => entry.id === id); $("#case-form").reset(); $("#case-id").value = id; $("#case-modal-title").textContent = item ? "Edit test case" : "New test case";
  if (item) { $("#case-name").value = item.name; $("#case-method").value = item.method; $("#case-url").value = item.url; $("#case-statuses").value = item.expected_statuses.join(", "); $("#case-notes").value = item.notes || ""; $("#case-query").value = objectText(item.query); $("#case-payload").value = item.payload === null ? "" : JSON.stringify(item.payload, null, 2); $("#case-headers").value = objectText(item.headers); $("#case-assertions").value = item.assertions.length ? JSON.stringify(item.assertions, null, 2) : ""; }
  renderExpectations(item ? item.account_expectations : {}); openModal("#case-modal");
}

function renderExpectations(values = null) {
  const container = $("#account-expectations"); if (!container) return; const current = values || {};
  container.innerHTML = '<div class="section-title">Per-account status overrides</div><p>Blank values use the default status list.</p>' + (state.accounts.length ? `<div class="expectation-grid">${state.accounts.map((account) => `<div class="expectation-row"><label>${escapeHtml(account.name)}</label><input data-expect-account="${account.id}" type="text" value="${escapeHtml((current[account.id] || []).join(", "))}" placeholder="default"></div>`).join("")}</div>` : '<p>No accounts saved.</p>');
}

async function saveCase(event) {
  event.preventDefault();
  let query, payload, headers, assertions;
  try { query = parseJsonField("#case-query", {}, "Query parameters"); payload = parseJsonField("#case-payload", null, "JSON payload"); headers = parseJsonField("#case-headers", {}, "Extra headers"); assertions = parseJsonField("#case-assertions", [], "Assertions"); if (!Array.isArray(assertions)) throw new Error("Assertions must be a JSON array."); } catch (error) { return toast(error.message, true); }
  const expectations = {}; $$('[data-expect-account]').forEach((input) => { const values = parseStatuses(input.value); if (values.length) expectations[input.dataset.expectAccount] = values; });
  const payloadData = { name: $("#case-name").value.trim(), method: $("#case-method").value, url: $("#case-url").value.trim(), expected_statuses: parseStatuses($("#case-statuses").value), account_expectations: expectations, headers, query, payload, assertions, notes: $("#case-notes").value, enabled: true };
  const id = $("#case-id").value;
  try { const saved = await api(id ? `/api/test-cases/${id}` : "/api/test-cases", {method: id ? "PUT" : "POST", body: JSON.stringify(payloadData)}); if (!id) state.selectedCases.add(saved.id); closeModals(); await refreshSavedData(); toast(id ? "Test case updated." : "Test case saved."); } catch (error) { toast(error.message, true); }
}

async function deleteCase(id) { const item = state.cases.find((entry) => entry.id === id); if (!item || !confirm(`Delete “${item.name}”?`)) return; try { await api(`/api/test-cases/${id}`, {method: "DELETE"}); await refreshSavedData(); toast("Test case deleted."); } catch (error) { toast(error.message, true); } }
function syncCrawlOptions() { const enabled = $("#include-crawl").checked; $("#crawl-target-field").classList.toggle("hidden", !enabled); $("#crawl-options").classList.toggle("hidden", !enabled); updateRunSummary(); }
function updateRunSummary() { const mutations = state.cases.filter((item) => state.selectedCases.has(item.id) && ["POST", "PUT", "PATCH", "DELETE"].includes(item.method)); $("#run-mutation-warning").classList.toggle("hidden", !mutations.length); const work = `${state.selectedAccounts.size} account${state.selectedAccounts.size === 1 ? "" : "s"}, ${state.selectedCases.size} case${state.selectedCases.size === 1 ? "" : "s"}${$("#include-crawl").checked ? ", plus full crawl" : ""}`; $("#run-selection-summary").textContent = work; }

async function startTestRun() {
  if (!state.selectedAccounts.size) return toast("Select at least one account.", true);
  if (!state.selectedCases.size && !$("#include-crawl").checked) return toast("Select a test case or enable the full crawl.", true);
  const mutations = state.cases.some((item) => state.selectedCases.has(item.id) && ["POST", "PUT", "PATCH", "DELETE"].includes(item.method));
  if (mutations && $("#run-authorization").value !== "I AM AUTHORIZED") return toast('Type “I AM AUTHORIZED” before running mutating tests.', true);
  const payload = { name: $("#run-name").value.trim() || "Test run", account_ids: [...state.selectedAccounts], test_case_ids: [...state.selectedCases], include_crawl: $("#include-crawl").checked, crawl_target_url: $("#crawl-target").value.trim() || null, max_pages: numberValue("#run-max-pages"), max_depth: numberValue("#run-max-depth"), request_delay_ms: numberValue("#run-delay"), navigation_timeout_ms: numberValue("#run-timeout"), ignore_https_errors: $("#run-ignore-tls").checked, include_subdomains: $("#run-subdomains").checked, discover_openapi: $("#run-openapi").checked, safe_probing: $("#run-safe-probing").checked, authorization_confirmation: $("#run-authorization").value, normalize_dynamic_ids: true, max_route_variants: numberValue("#run-max-route-variants"), custom_id_patterns: $("#run-custom-id-patterns").value ? $("#run-custom-id-patterns").value.split(/\s*;\s*|\s*\n\s*/).filter(Boolean) : [], ignore_path_patterns: [], normalize_query_values: true };
  setTestRunning(true); $("#test-run-progress").classList.remove("hidden"); $("#test-results").classList.add("hidden"); $("#test-export-menu").classList.add("hidden"); startClock("#test-elapsed");
  try { const response = await api("/api/test-runs", {method: "POST", body: JSON.stringify(payload)}); state.testJobId = response.id; pollTestRun(); } catch (error) { stopClock(); setTestRunning(false); toast(error.message, true); }
}

async function pollTestRun() {
  try { const job = await api(`/api/test-runs/${state.testJobId}`); $("#test-phase").textContent = job.phase; $("#test-progress-number").textContent = `${job.progress || 0}%`; $("#test-progress-bar").style.width = `${job.progress || 0}%`; $("#test-steps").textContent = job.pages_visited || 0; $("#test-live-results").textContent = job.endpoints_found || 0;
    if (job.status === "completed") { state.testResult = job.result; stopClock(); setTestRunning(false); $("#test-run-progress").classList.add("hidden"); renderTestResults(); $("#test-results").classList.remove("hidden"); configureTestExports(); return toast("Test run complete."); }
    if (job.status === "failed") throw new Error(job.error || "Test run failed."); if (job.status === "cancelled") { stopClock(); setTestRunning(false); return toast("Test run cancelled."); }
    state.timer = setTimeout(pollTestRun, 700);
  } catch (error) { stopClock(); setTestRunning(false); toast(error.message, true); }
}

async function cancelTestRun() { if (state.testJobId) await api(`/api/test-runs/${state.testJobId}/cancel`, {method: "POST"}); }
function setTestRunning(value) { $("#start-test-run").disabled = value; $("#cancel-test-run").classList.toggle("hidden", !value); }
function configureTestExports() { $("#test-export-menu").classList.remove("hidden"); ["json", "csv", "xlsx"].forEach((format) => bindExport($(`#test-export-${format}`), `/api/test-runs/${state.testJobId}`, format)); }

function flatTestResults() {
  const rows = (state.testResult.test_results || []).map((item) => ({...item, source: "Test case"}));
  for (const crawl of state.testResult.crawl_runs || []) for (const endpoint of crawl.result.endpoints || []) rows.push({id: `crawl-${crawl.account_id}-${endpoint.id}`, result: "OBSERVED", account_name: crawl.account_name, auth_mode: crawl.auth_mode, test_case_name: "Full site crawl", method: endpoint.method, url: endpoint.concrete_urls[0] || `${endpoint.origin}${endpoint.path}`, endpoint_path: endpoint.path, expected_statuses: [], actual_status: endpoint.status_codes.join(", "), duration_ms: null, source: endpoint.discovered_by.join(", "), endpoint});
  return rows;
}

function renderTestResults() { const run = state.testResult.run; $("#run-total").textContent = run.tests; $("#run-passed").textContent = run.passed; $("#run-failed").textContent = run.failed; $("#run-errors").textContent = run.errors; renderTestResultRows(); }
function renderTestResultRows() { if (!state.testResult) return; const term = $("#test-result-search").value.toLowerCase(), filter = $("#test-result-filter").value; const all = flatTestResults(), rows = all.filter((item) => (!term || JSON.stringify(item).toLowerCase().includes(term)) && (!filter || item.result === filter)); $("#test-result-count").textContent = `${rows.length} of ${all.length}`; $("#test-result-rows").innerHTML = rows.map((item) => `<tr><td>${resultBadge(item.result)}</td><td><strong>${escapeHtml(item.account_name)}</strong><span class="subtext">${escapeHtml(item.auth_mode)}</span></td><td>${escapeHtml(item.test_case_name)}<span class="subtext">${escapeHtml(item.source || "")}</span></td><td>${methodPill(item.method)}</td><td class="path-cell">${escapeHtml(item.url)}</td><td>${escapeHtml((item.expected_statuses || []).join(", ") || "—")}</td><td><span class="status-code ${statusClass(Number.parseInt(item.actual_status, 10))}">${escapeHtml(item.actual_status ?? "—")}</span></td><td>${item.duration_ms === null || item.duration_ms === undefined ? "—" : `${item.duration_ms} ms`}</td><td><button class="view-button" data-test-result="${item.id}" type="button">›</button></td></tr>`).join(""); $$("[data-test-result]").forEach((button) => button.addEventListener("click", () => openTestDrawer(button.dataset.testResult))); }

function openEndpointDrawer(id) { const endpoint = state.scanResult.endpoints.find((item) => item.id === id); if (!endpoint) return; showDrawer(endpoint.method, endpoint.path, `<section class="detail-section"><h3>Exact observed URLs</h3><pre class="code-block">${escapeHtml(pretty(endpoint.concrete_urls))}</pre></section><section class="detail-section"><h3>Overview</h3><pre class="code-block">${escapeHtml(pretty({status_codes: endpoint.status_codes, authentication: endpoint.authentication, discovered_by: endpoint.discovered_by, query_parameters: endpoint.query_parameters}))}</pre></section><section class="detail-section"><h3>Called from</h3>${locationHtml(endpoint.called_from)}</section><section class="detail-section"><h3>Request payload</h3><pre class="code-block">${escapeHtml(pretty(endpoint.request))}</pre></section><section class="detail-section"><h3>Responses and probes</h3><pre class="code-block">${escapeHtml(pretty({responses: endpoint.responses, probes: endpoint.probes}))}</pre></section>`); }
function openTestDrawer(id) { const item = flatTestResults().find((entry) => entry.id === id); if (!item) return; if (item.endpoint) return showDrawer(item.method, item.endpoint_path, `<section class="detail-section"><h3>Discovery record</h3><pre class="code-block">${escapeHtml(pretty(item.endpoint))}</pre></section>`); showDrawer(item.method, item.endpoint_path, `<section class="detail-section"><h3>Test outcome</h3><pre class="code-block">${escapeHtml(pretty({account: item.account_name, expected_statuses: item.expected_statuses, actual_status: item.actual_status, result: item.result, duration_ms: item.duration_ms, assertions: item.assertions, error: item.error}))}</pre></section><section class="detail-section"><h3>Request</h3><pre class="code-block">${escapeHtml(pretty({url: item.url, query: item.request_query, payload: item.request_payload}))}</pre></section><section class="detail-section"><h3>Response</h3><pre class="code-block">${escapeHtml(pretty({content_type: item.response_content_type, size_bytes: item.response_size_bytes, body: item.response_body}))}</pre></section>`); }
function showDrawer(method, path, content) { $("#drawer-method").textContent = method; $("#drawer-method").className = `method-pill method-${method}`; $("#drawer-path").textContent = path; $("#drawer-body").innerHTML = content; $("#drawer-backdrop").classList.remove("hidden"); $("#detail-drawer").classList.add("open"); }
function closeDrawer() { $("#detail-drawer").classList.remove("open"); setTimeout(() => $("#drawer-backdrop").classList.add("hidden"), 180); }

function openModal(selector) { $("#modal-backdrop").classList.remove("hidden"); $(selector).classList.remove("hidden"); }
function closeModals() { $("#modal-backdrop").classList.add("hidden"); $$(".modal").forEach((modal) => modal.classList.add("hidden")); }
function toggleSecret(button) { const input = button.parentElement.querySelector("input"); input.type = input.type === "password" ? "text" : "password"; button.textContent = input.type === "password" ? "Show" : "Hide"; }
function toggleSet(set, value, checked) { checked ? set.add(value) : set.delete(value); }
function parseStatuses(value) { return [...new Set(value.split(/[\s,;]+/).map((item) => Number.parseInt(item, 10)).filter((item) => item >= 100 && item <= 599))]; }
function parseJsonField(selector, emptyValue, label) { const raw = $(selector).value.trim(); if (!raw) return emptyValue; try { return JSON.parse(raw); } catch { throw new Error(`${label} contains invalid JSON.`); } }
function objectText(value) { return value && Object.keys(value).length ? JSON.stringify(value, null, 2) : ""; }
function initials(name) { return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }
function methodTag(mode) { return `<span class="source-tag">${escapeHtml(mode)}</span>`; }
function methodPill(method) { return `<span class="method-pill method-${escapeHtml(method)}">${escapeHtml(method)}</span>`; }
function resultBadge(result) { const className = result === "PASS" ? "status-ok" : result === "FAIL" ? "status-bad" : result === "ERROR" ? "status-warn" : ""; return `<strong class="status-code ${className}">${escapeHtml(result)}</strong>`; }
function statusClass(code) { if (!code) return ""; if (code < 300) return "status-ok"; if (code < 500) return "status-warn"; return "status-bad"; }
function compactUrl(value) { try { const url = new URL(value); return url.pathname + url.search; } catch { return value; } }
function locationHtml(items) { return items.length ? `<div class="location-list">${items.map((item) => `<div class="location">${escapeHtml(item.page || item.source || "Unknown")}<small>${escapeHtml([item.kind, item.source, item.line ? `line ${item.line}` : ""].filter(Boolean).join(" · "))}</small></div>`).join("")}</div>` : '<p class="empty-detail">No location mapped.</p>'; }
function pretty(value) { return JSON.stringify(value, null, 2); }
function numberValue(selector) { return Number.parseInt($(selector).value, 10); }
function startClock(selector) { clearInterval(state.elapsedTimer); state.startedAt = Date.now(); state.elapsedTimer = setInterval(() => { const seconds = Math.floor((Date.now() - state.startedAt) / 1000); $(selector).textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }, 1000); }
function stopClock() { clearTimeout(state.timer); clearInterval(state.elapsedTimer); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[char]); }
async function api(url, options = {}) { const response = await fetch(url, {headers: {"content-type": "application/json", ...(options.headers || {})}, ...options}); if (response.status === 204) return null; let body; try { body = await response.json(); } catch { body = {}; } if (!response.ok) throw new Error(validationMessage(body)); return body; }
function validationMessage(body) { if (!body.detail) return "Request failed."; if (typeof body.detail === "string") return body.detail; return body.detail.map((item) => item.msg).join(" "); }
function toast(message, error = false) { const element = $("#toast"); element.textContent = message; element.className = `toast${error ? " error" : ""}`; clearTimeout(element._timer); element._timer = setTimeout(() => element.classList.add("hidden"), 4800); }

/**
 * Reports are downloads in a browser, but a plugin hosted inside Tracefold has nowhere to
 * download to. There the server writes the file and reports where it went, and the toast
 * offers to show it in the file manager.
 */
const hostedInTracefold = document.documentElement.dataset.host === "tracefold";

function bindExport(element, base, format) {
  if (!element) return;
  if (!hostedInTracefold) {
    element.href = `${base}/export/${format}`;
    return;
  }
  element.href = "#";
  element.onclick = async (event) => {
    event.preventDefault();
    if (element.dataset.saving === "true") return;
    element.dataset.saving = "true";
    const label = element.textContent;
    element.textContent = "Saving…";
    try {
      const saved = await api(`${base}/save/${format}`, { method: "POST" });
      toastWithReveal(`Saved ${saved.name}`, saved.path);
    } catch (error) {
      toast(error.message, true);
    } finally {
      element.textContent = label;
      delete element.dataset.saving;
    }
  };
}

function toastWithReveal(message, path) {
  const element = $("#toast");
  element.textContent = "";
  element.className = "toast";
  const text = document.createElement("span");
  text.textContent = message;
  element.append(text);
  const reveal = document.createElement("button");
  reveal.type = "button";
  reveal.className = "text-button";
  reveal.textContent = "Show in folder";
  reveal.onclick = () => {
    api("/api/reveal", { method: "POST", body: JSON.stringify({ path }) }).catch((error) =>
      toast(error.message, true),
    );
  };
  element.append(reveal);
  clearTimeout(element._timer);
  element._timer = setTimeout(() => element.classList.add("hidden"), 9000);
}
