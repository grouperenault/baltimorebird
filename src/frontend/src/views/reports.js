/**
 * Reports Module - Reports management
 */
const ReportsManager = (() => {
    const API = '/api/reports';

    const state = {
        reports: [],
        currentId: null,
        pendingDeleteId: null,
        pendingDeleteName: null,
        autoRefreshInterval: null,
        // Rapport a ouvrir des que la liste le contient (navigation depuis l'ecran d'execution).
        pendingSelectId: null,
        listenersBound: false
    };

    const $ = (id) => document.getElementById(id);

    function formatDate(timestamp) {
        const date = new Date(timestamp * 1000);
        const now = new Date();
        const diff = now - date;

        if (diff < 60000) return 'À l\'instant';
        if (diff < 3600000) return `Il y a ${Math.floor(diff / 60000)} min`;
        if (diff < 86400000) return `Il y a ${Math.floor(diff / 3600000)}h`;
        if (diff < 604800000) return `Il y a ${Math.floor(diff / 86400000)}j`;

        return date.toLocaleDateString('fr-FR', {
            day: 'numeric',
            month: 'short',
            year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
        });
    }

    async function loadList() {
        const listContainer = $('reportsList');
        const countEl = $('reportsCount');

        if (state.reports.length === 0) {
            listContainer.innerHTML = '<div class="reports-loading">Chargement...</div>';
        }

        try {
            const res = await fetch(API);
            const data = await res.json();
            const newReports = data.reports || [];

            countEl.textContent = `${newReports.length} rapport(s)`;

            const hasChanged = JSON.stringify(newReports.map(r => r.id)) !== 
                              JSON.stringify(state.reports.map(r => r.id));

            if (hasChanged || state.reports.length === 0) {
                state.reports = newReports;

                if (state.reports.length === 0) {
                    listContainer.innerHTML = `
                        <div class="reports-empty-list">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                <polyline points="14 2 14 8 20 8"/>
                            </svg>
                            <p>Aucun rapport disponible</p>
                            <p style="margin-top: 8px; color: #444;">Les rapports produits par l'exécution d'une analyse apparaîtront ici</p>
                        </div>
                    `;

                    if (state.currentId) {
                        state.currentId = null;
                        $('reportsEmpty').style.display = 'flex';
                        $('reportsViewer').style.display = 'none';
                    }
                    return;
                }

                renderList();

                if (state.pendingSelectId && state.reports.find(r => r.id === state.pendingSelectId)) {
                    select(state.pendingSelectId);
                    state.pendingSelectId = null;
                }

                if (state.currentId && !state.reports.find(r => r.id === state.currentId)) {
                    state.currentId = null;
                    $('reportsEmpty').style.display = 'flex';
                    $('reportsViewer').style.display = 'none';
                }
            }
        } catch (e) {
            console.error('Failed to load reports:', e);
            if (state.reports.length === 0) {
                listContainer.innerHTML = `
                    <div class="reports-empty-list">
                        <p style="color: #ff6666;">Erreur de chargement</p>
                        <p style="margin-top: 8px;">${e.message}</p>
                    </div>
                `;
            }
        }
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    }

    const RUN_STATUS = {
        succeeded: { label: 'Réussi', cls: 'ok' },
        partial: { label: 'Partiel', cls: 'warn' },
        failed: { label: 'Échec', cls: 'error' },
    };

    const MODE_LABEL = { per_file: 'Par fichier', merged: 'Fusionné' };

    function inputNames(run) {
        return (run?.inputs || []).map(input => input.name).join(', ');
    }

    function itemHtml(report) {
        const run = report.run;
        const status = run ? RUN_STATUS[run.status] : null;
        const inputs = run ? inputNames(run) : '';
        return `
            <div class="report-item ${report.id === state.currentId ? 'active' : ''}"
                 data-report-id="${escapeHtml(report.id)}"
                 data-action="select">
                <button class="report-item-delete"
                        data-action="confirmDelete"
                        data-report-id="${escapeHtml(report.id)}"
                        data-report-name="${escapeHtml(report.name)}"
                        title="Supprimer">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                </button>
                <div class="report-item-header">
                    <div class="report-item-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                            <polyline points="14 2 14 8 20 8"/>
                            <line x1="16" y1="13" x2="8" y2="13"/>
                            <line x1="16" y1="17" x2="8" y2="17"/>
                        </svg>
                    </div>
                    <div class="report-item-info">
                        <div class="report-item-name" title="${escapeHtml(report.name)}">${escapeHtml(report.name)}</div>
                        ${inputs ? `<div class="report-item-inputs" title="${escapeHtml(inputs)}">${escapeHtml(inputs)}</div>` : ''}
                        <div class="report-item-meta">
                            ${status ? `<span class="report-status report-status--${status.cls}">${status.label}</span>` : ''}
                            <span>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <circle cx="12" cy="12" r="10"/>
                                    <path d="M12 6v6l4 2"/>
                                </svg>
                                ${formatDate(report.created)}
                            </span>
                            <span>${escapeHtml(report.size_kb)} KB</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    function matchesFilter(report, term) {
        if (!term) return true;
        const haystack = [report.name, report.filename, inputNames(report.run)].join(' ').toLowerCase();
        return haystack.includes(term);
    }

    function renderList() {
        const term = ($('reportsSearch')?.value || '').toLowerCase().trim();
        $('reportsList').innerHTML = state.reports.filter(r => matchesFilter(r, term)).map(itemHtml).join('');
    }

    // Provenance d'un rapport d'execution: quelle analyse, sur quelles donnees, avec quelle issue.
    function renderProvenance(report) {
        const panel = $('reportProvenance');
        const rerun = $('reportRerunBtn');
        const run = report?.run;
        if (rerun) rerun.hidden = !run;
        if (!panel) return;
        panel.hidden = !run;
        if (!run) {
            panel.innerHTML = '';
            return;
        }
        const status = RUN_STATUS[run.status] || { label: run.status, cls: '' };
        const inputs = (run.inputs || []).map(input => {
            const renamed = Object.entries(input.matched || {}).filter(([declared, found]) => declared !== found);
            const mismatches = (input.unit_mismatches || [])
                .map(m => `${m.signal} : ${m.found} au lieu de ${m.declared}`);
            return `<li>
                <span class="report-prov-input">${escapeHtml(input.name)}</span>
                <code title="Empreinte des données">${escapeHtml(String(input.hash || '').slice(0, 12))}</code>
                ${renamed.length ? `<span class="report-prov-note">${escapeHtml(renamed.map(([d, f]) => `${d} = ${f}`).join(', '))}</span>` : ''}
                ${mismatches.length ? `<span class="report-prov-warn">Unités : ${escapeHtml(mismatches.join(' ; '))}</span>` : ''}
            </li>`;
        }).join('');
        const failed = Object.keys(run.block_errors || {}).length;
        panel.innerHTML = `
            <div class="report-prov-row">
                <span class="report-prov-label">Analyse</span>
                <span class="report-prov-value">${escapeHtml(run.analysis?.name)}</span>
                <code title="Version de l'analyse (empreinte)">${escapeHtml(String(run.analysis?.hash || '').slice(0, 12))}</code>
                <span class="report-prov-label">Mode</span>
                <span class="report-prov-value">${escapeHtml(MODE_LABEL[run.mode] || run.mode)}</span>
                <span class="report-status report-status--${status.cls}">${escapeHtml(status.label)}</span>
                <span class="report-prov-value">${escapeHtml(run.duration)} s</span>
                ${failed ? `<span class="report-prov-warn">${failed} bloc(s) en échec ou ignoré(s)</span>` : ''}
            </div>
            ${inputs
                ? `<div class="report-prov-row"><span class="report-prov-label">Données</span><ul class="report-prov-inputs">${inputs}</ul></div>`
                : `<div class="report-prov-row"><span class="report-prov-label">Données</span><span class="report-prov-value">Contenues dans l'analyse</span></div>`}
        `;
    }

    function select(reportId) {
        state.currentId = reportId;

        document.querySelectorAll('.report-item').forEach(item => {
            item.classList.toggle('active', item.dataset.reportId === reportId);
        });

        const report = state.reports.find(r => r.id === reportId);
        if (!report) return;

        $('reportsEmpty').style.display = 'none';
        $('reportsViewer').style.display = 'flex';
        $('viewerReportName').textContent = report.name;
        renderProvenance(report);

        const deleteBtn = document.querySelector('.reports-viewer-actions .reports-action-btn.danger');
        if (deleteBtn) {
            const isDemo = report.name === 'demo' || report.filename === 'demo.html';
            deleteBtn.disabled = isDemo;
            deleteBtn.title = isDemo ? 'Impossible de supprimer le rapport de démonstration' : 'Supprimer';
        }

        $('reportFrame').src = `${API}/${encodeURIComponent(reportId)}`;
    }

    function filter() {
        renderList();
    }

    // Relance l'analyse du rapport courant: ouvre l'ecran d'execution, analyse et donnees
    // preselectionnees, pour changer la selection avant de lancer.
    function rerun() {
        const report = state.reports.find(r => r.id === state.currentId);
        if (!report?.run || typeof window.openReportingRun !== 'function') return;
        window.openReportingRun({
            analysisId: report.run.analysis?.id,
            datasets: (report.run.inputs || []).map(input => input.dataset_id),
        });
    }

    function openNewTab() {
        if (!state.currentId) return;
        window.open(`${API}/${state.currentId}`, '_blank');
    }

    function download() {
        if (!state.currentId) return;
        window.open(`${API}/${state.currentId}/download`, '_blank');
    }

    function confirmDelete(reportId, reportName) {
        state.pendingDeleteId = reportId;
        state.pendingDeleteName = reportName;
        $('deleteReportName').textContent = reportName;
        $('reportsDeleteModal').classList.add('show');
    }

    function cancelDelete() {
        state.pendingDeleteId = null;
        state.pendingDeleteName = null;
        $('reportsDeleteModal').classList.remove('show');
    }

    async function executeDelete() {
        if (!state.pendingDeleteId) return;

        const reportId = state.pendingDeleteId;
        cancelDelete();

        try {
            const res = await fetch(`${API}/${encodeURIComponent(reportId)}`, { method: 'DELETE' });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Suppression échouée');
            }

            await loadList();
        } catch (e) {
            console.error('Failed to delete report:', e);
            alert(`Erreur: ${e.message}`);
        }
    }

    function deleteCurrent() {
        if (!state.currentId) return;
        const report = state.reports.find(r => r.id === state.currentId);
        if (report) confirmDelete(state.currentId, report.name);
    }

    function startAutoRefresh() {
        stopAutoRefresh();
        state.autoRefreshInterval = setInterval(loadList, 5000);
    }

    function stopAutoRefresh() {
        if (state.autoRefreshInterval) {
            clearInterval(state.autoRefreshInterval);
            state.autoRefreshInterval = null;
        }
    }

    function setupEventListeners() {
        const reportsView = $('view-reports');
        if (!reportsView) return;

        reportsView.addEventListener('click', (e) => {
            const target = e.target.closest('[data-action]');
            if (!target) return;

            e.preventDefault();
            e.stopPropagation();

            const { action, reportId, reportName } = target.dataset;

            switch (action) {
                case 'select': select(reportId); break;
                case 'confirmDelete': confirmDelete(reportId, reportName); break;
                case 'cancelDelete': cancelDelete(); break;
                case 'executeDelete': executeDelete(); break;
                case 'openNewTab': openNewTab(); break;
                case 'download': download(); break;
                case 'deleteCurrent': deleteCurrent(); break;
                case 'rerun': rerun(); break;
            }
        });

        const searchInput = reportsView.querySelector('.reports-search input');
        if (searchInput) {
            searchInput.addEventListener('input', () => filter());
        }
    }

    function init() {
        // init() est rappele a chaque affichage de la vue: les ecouteurs ne sont poses qu'une fois.
        if (!state.listenersBound) {
            setupEventListeners();
            state.listenersBound = true;
        }
        loadList();
        startAutoRefresh();
    }

    // Ouvre un rapport donne; s'il n'est pas encore dans la liste, il est selectionne au
    // prochain chargement.
    function show(reportId) {
        if (state.reports.find(r => r.id === reportId)) {
            select(reportId);
        } else {
            state.pendingSelectId = reportId;
            state.reports = [];
        }
    }

    function cleanup() {
        stopAutoRefresh();
    }

    return Object.freeze({ init, cleanup, show });
})();

const initReportsView = () => ReportsManager.init();
const cleanupReportsView = () => ReportsManager.cleanup();
// =========================================================================
// Expose globals for other modules (Vite compatibility)
// =========================================================================
window.ReportsManager = ReportsManager;
// Ouvre la bibliotheque sur un rapport donne (fin d'execution, lien depuis une analyse).
window.openReport = async (reportId) => {
    if (typeof window.switchView === 'function') {
        await window.switchView('reports', document.querySelector('.nav-item[data-view="reports"]'));
    }
    ReportsManager.show(reportId);
};
window.initReportsView = initReportsView;
window.cleanupReportsView = cleanupReportsView;
