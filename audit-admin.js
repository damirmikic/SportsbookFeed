import { fetchAuditLog } from './api.js';

function fmtDate(value) {
  return value ? new Date(value).toLocaleString() : '-';
}

function previewJson(value) {
  if (value == null) return '-';
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function rowHTML(entry) {
  const trader = entry.trader_name || entry.trader_id || 'Unknown';
  return `
    <tr class="admin-row audit-row">
      <td>${fmtDate(entry.ts)}</td>
      <td>${trader}</td>
      <td>${entry.entity}</td>
      <td>${entry.action}</td>
      <td><code>${previewJson(entry.before)}</code></td>
      <td><code>${previewJson(entry.after)}</code></td>
    </tr>`;
}

export async function renderAuditPanel() {
  const panel = document.getElementById('audit-panel');
  if (!panel) return;

  panel.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading audit log...</p></div>';

  try {
    const entries = await fetchAuditLog(100);
    panel.innerHTML = `
      <div class="audit-header">
        <h2>Audit Log</h2>
        <button type="button" class="admin-act-btn" id="audit-refresh">Refresh</button>
      </div>
      <div class="admin-table-wrap">
        <table class="admin-tbl audit-tbl">
          <thead>
            <tr>
              <th>Time</th>
              <th>Trader</th>
              <th>Entity</th>
              <th>Action</th>
              <th>Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            ${entries.length ? entries.map(rowHTML).join('') : '<tr><td colspan="6" class="admin-empty">No audit entries yet.</td></tr>'}
          </tbody>
        </table>
      </div>`;
    panel.querySelector('#audit-refresh')?.addEventListener('click', renderAuditPanel);
  } catch (error) {
    panel.innerHTML = `<div class="admin-empty">Failed to load audit log: ${error.message}</div>`;
  }
}
