/**
 * Baltimore Bird - Execution d'analyses generiques sur des donnees choisies.
 *
 * Trois temps, une colonne chacun: choisir l'analyse, choisir les donnees (resolution des
 * signaux declares verifiee cote serveur), ajouter a la file. Les analyses de la file
 * s'executent une par une sur le serveur; cet ecran suit leur avancement (file + console)
 * et chaque execution produit un rapport conserve avec sa provenance.
 * Voir .okf/roadmap/reporting-analyses.md.
 */
const ReportingRun = (() => {
    const SCRIPTS_API = '/api/scripts';
    const API = '/api/reporting';
    const POLL_MS = 1000;

    const MODE_LABEL = { per_file: 'Par fichier', merged: 'Fusionné' };
    const RUN_STATUS = {
        succeeded: { label: 'Réussi', cls: 'ok' },
        partial: { label: 'Partiel', cls: 'warn' },
        failed: { label: 'Échec', cls: 'error' },
    };
    const ACTIVE = new Set(['queued', 'running']);

    const state = {
        analyses: [],
        datasets: [],
        analysisId: null,
        selected: [],          // identifiants de jeux, dans l'ordre de selection
        mode: 'per_file',      // decoupage des donnees, choisi ici et non dans l'analyse
        preflight: null,       // reponse de /preflight pour la selection courante
        preflightSeq: 0,
        submitting: false,
        jobs: [],
        knownFinished: null,   // jobs deja termines (pas de notification a leur sujet)
        consoleSince: '',      // horodatage en deca duquel la console est effacee
        pollTimer: null,
        pending: null,         // preselection demandee avant le chargement des listes
        listenersBound: false,
    };

    const $ = (id) => document.getElementById(id);

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch]));
    }

    function notify(message, type) {
        if (typeof window.showNotification === 'function') window.showNotification(message, type || 'info');
    }

    function currentAnalysis() {
        return state.analyses.find(a => a.id === state.analysisId) || null;
    }

    async function fetchJson(url, options) {
        const res = await authFetch(url, options);
        let body = null;
        try {
            body = await res.json();
        } catch {
            body = null;
        }
        return { ok: res.ok, status: res.status, body: body || {} };
    }

    function formatTime(iso) {
        const date = new Date(iso);
        return Number.isNaN(date.getTime())
            ? ''
            : date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    // =====================================================================
    // Chargement
    // =====================================================================

    async function loadLists() {
        const [scripts, datasets] = await Promise.all([
            fetchJson(SCRIPTS_API),
            fetchJson(`${API}/datasets`),
        ]);
        if (!scripts.ok) {
            $('runAnalysesList').innerHTML = `<div class="run-placeholder run-placeholder--error">Analyses indisponibles : ${escapeHtml(scripts.body.error || scripts.status)}</div>`;
        }
        if (!datasets.ok) {
            $('runDatasetsList').innerHTML = `<div class="run-placeholder run-placeholder--error">Données indisponibles : ${escapeHtml(datasets.body.error || datasets.status)}</div>`;
        }
        state.analyses = scripts.body.scripts || [];
        state.datasets = datasets.body.datasets || [];

        if (state.pending) {
            applySelection(state.pending);
            state.pending = null;
        } else if (state.analysisId && !currentAnalysis()) {
            state.analysisId = null;
            state.selected = [];
        }
        state.selected = state.selected.filter(id => state.datasets.some(d => d.id === id));
        render();
        refreshPreflight();
    }

    function applySelection({ analysisId, datasets }) {
        state.analysisId = analysisId || null;
        state.selected = Array.isArray(datasets) ? datasets.filter(Boolean) : [];
    }

    // =====================================================================
    // Rendu: selection
    // =====================================================================

    function render() {
        renderAnalyses();
        renderDeclared();
        renderDatasets();
        renderSummary();
        renderQueue();
        renderConsole();
    }

    function renderAnalyses() {
        const list = $('runAnalysesList');
        if (!list) return;
        if (!state.analyses.length) {
            list.innerHTML = '<div class="run-placeholder">Aucune analyse. Créez-en une dans l\'onglet Analyses.</div>';
            return;
        }
        list.innerHTML = state.analyses.map(analysis => {
            const inputs = analysis.hasInputs
                ? `${analysis.inputs.length} signal(aux) en entrée`
                : 'Données intégrées';
            return `
                <button type="button" class="run-card ${analysis.id === state.analysisId ? 'active' : ''}"
                        data-action="pick-analysis" data-id="${escapeHtml(analysis.id)}"
                        aria-pressed="${analysis.id === state.analysisId}">
                    <span class="run-card-title">${escapeHtml(analysis.name)}</span>
                    <span class="run-card-meta">
                        <span>${escapeHtml(inputs)}</span>
                        ${analysis.readonly ? '<span class="run-badge run-badge--muted">Modèle</span>' : ''}
                    </span>
                    ${analysis.description ? `<span class="run-card-desc">${escapeHtml(analysis.description)}</span>` : ''}
                </button>
            `;
        }).join('');
    }

    function renderDeclared() {
        const box = $('runDeclared');
        if (!box) return;
        const analysis = currentAnalysis();
        if (!analysis || !analysis.hasInputs) {
            box.hidden = true;
            box.innerHTML = '';
            return;
        }
        box.hidden = false;
        box.innerHTML = `
            <span class="run-declared-label">Signaux requis</span>
            ${analysis.inputs.map(input => `
                <span class="run-chip">${escapeHtml(input.name)}${input.unit ? ` <em>${escapeHtml(input.unit)}</em>` : ''}</span>
            `).join('')}
        `;
    }

    function resolutionOf(datasetId) {
        return (state.preflight?.resolutions || []).find(r => r.dataset_id === datasetId) || null;
    }

    function renderDatasets() {
        const list = $('runDatasetsList');
        if (!list) return;
        const analysis = currentAnalysis();
        if (!analysis) {
            list.innerHTML = '<div class="run-placeholder">Choisissez d\'abord une analyse</div>';
            return;
        }
        if (!analysis.hasInputs) {
            list.innerHTML = `<div class="run-placeholder">Cette analyse contient ses propres données :
                elle s'exécute sans jeu de données. Pour la rendre générique, remplacez sa source
                synthétique par un bloc Entrées dans l'onglet Analyses.</div>`;
            return;
        }
        if (!state.datasets.length) {
            list.innerHTML = '<div class="run-placeholder">Aucun jeu de données disponible</div>';
            return;
        }
        list.innerHTML = state.datasets.map(dataset => {
            const order = state.selected.indexOf(dataset.id);
            const checked = order !== -1;
            const resolution = checked ? resolutionOf(dataset.id) : null;
            let status = '';
            if (resolution) {
                if (resolution.missing.length) {
                    status = `<span class="run-res run-res--error">Manque : ${escapeHtml(resolution.missing.join(', '))}</span>`;
                } else {
                    status = '<span class="run-res run-res--ok">Tous les signaux trouvés</span>';
                }
                if (resolution.unit_mismatches.length) {
                    const text = resolution.unit_mismatches
                        .map(m => `${m.signal} en ${m.found} (attendu ${m.declared})`).join(' ; ');
                    status += `<span class="run-res run-res--warn">Unités : ${escapeHtml(text)}</span>`;
                }
            }
            const duration = (dataset.samples * dataset.period).toFixed(0);
            return `
                <label class="run-dataset ${checked ? 'checked' : ''}">
                    <input type="checkbox" data-action="toggle-dataset" data-id="${escapeHtml(dataset.id)}" ${checked ? 'checked' : ''}>
                    <span class="run-dataset-body">
                        <span class="run-dataset-title">
                            ${checked && state.selected.length > 1 ? `<span class="run-order">${order + 1}</span>` : ''}
                            ${escapeHtml(dataset.name)}
                        </span>
                        <span class="run-dataset-meta">${escapeHtml(dataset.signals.length)} signaux · ${escapeHtml(duration)} s · ${escapeHtml(dataset.samples)} points</span>
                        ${dataset.description ? `<span class="run-dataset-desc">${escapeHtml(dataset.description)}</span>` : ''}
                        ${status}
                    </span>
                </label>
            `;
        }).join('');
    }

    // Ce qu'il manque pour ajouter a la file, ou null si c'est possible.
    function blocker() {
        const analysis = currentAnalysis();
        if (!analysis) return 'Choisissez une analyse';
        if (!analysis.hasInputs) return null;
        if (!analysis.inputs.length) return 'La déclaration des entrées de cette analyse est invalide : corrigez-la dans l\'onglet Analyses';
        if (!state.selected.length) return 'Sélectionnez au moins un jeu de données';
        if (!state.preflight) return 'Vérification des signaux...';
        if (!state.preflight.runnable) return 'Des signaux requis manquent dans la sélection';
        return null;
    }

    // Le decoupage n'a de sens qu'a partir de deux jeux de donnees.
    function effectiveMode() {
        return state.selected.length > 1 ? state.mode : 'per_file';
    }

    function renderSummary() {
        const box = $('runSummary');
        const button = $('runLaunchBtn');
        if (!box || !button) return;
        const analysis = currentAnalysis();
        const reason = blocker();

        let lines = '';
        if (analysis) {
            const mode = effectiveMode();
            const count = !analysis.hasInputs ? 1 : (mode === 'merged' ? 1 : state.selected.length);
            const how = !analysis.hasInputs
                ? 'Exécution sur les données intégrées à l\'analyse.'
                : mode === 'merged'
                    ? 'Toutes les données alimentent une seule exécution.'
                    : 'Une exécution par jeu de données, en séquence.';
            const choice = analysis.hasInputs && state.selected.length > 1 ? `
                <div class="run-mode" role="radiogroup" aria-label="Découpage des données">
                    ${Object.entries(MODE_LABEL).map(([value, label]) => `
                        <label class="run-mode-option ${state.mode === value ? 'active' : ''}">
                            <input type="radio" name="runMode" value="${value}" data-action="pick-mode" ${state.mode === value ? 'checked' : ''}>
                            ${escapeHtml(label)}
                        </label>
                    `).join('')}
                </div>
            ` : '';
            lines = `
                <div class="run-summary-name">${escapeHtml(analysis.name)}</div>
                ${choice}
                <div class="run-summary-line">${escapeHtml(how)}</div>
                ${count ? `<div class="run-summary-line"><strong>${count}</strong> rapport(s) seront produits.</div>` : ''}
            `;
        }
        box.innerHTML = lines + (reason ? `<div class="run-summary-blocker">${escapeHtml(reason)}</div>` : '');
        button.disabled = state.submitting || Boolean(reason);
    }

    // =====================================================================
    // Rendu: file et console
    // =====================================================================

    function jobStateBadge(job) {
        if (job.state === 'queued') return `<span class="run-job-state run-job-state--queued">En attente · n°${escapeHtml(job.position)}</span>`;
        if (job.state === 'running') return `<span class="run-job-state run-job-state--running">En cours · ${escapeHtml(job.done)}/${escapeHtml(job.total)}</span>`;
        if (job.state === 'cancelled') return '<span class="run-job-state">Retirée</span>';
        if (job.state === 'failed') return '<span class="report-status report-status--error">Échec</span>';
        const statuses = (job.result?.runs || []).map(run => run.status);
        const worst = ['failed', 'partial'].find(s => statuses.includes(s)) || 'succeeded';
        const status = RUN_STATUS[worst];
        return `<span class="report-status report-status--${status.cls}">${status.label}</span>`;
    }

    function jobReports(job) {
        const runs = job.result?.runs || [];
        return runs.filter(run => run.report_id).map(run => {
            const label = (run.inputs || []).map(input => input.name).join(', ') || 'Rapport';
            return `<button type="button" class="run-report-link" data-action="open-report" data-id="${escapeHtml(run.report_id)}"
                            title="Ouvrir le rapport">${escapeHtml(label)}</button>`;
        }).join('');
    }

    // Les actives d'abord dans l'ordre de la file, puis les terminees, les plus recentes en tete.
    function orderedJobs() {
        const active = state.jobs.filter(job => ACTIVE.has(job.state))
            .sort((a, b) => (a.state === 'running' ? -1 : 0) - (b.state === 'running' ? -1 : 0)
                || (a.position || 0) - (b.position || 0));
        const finished = state.jobs.filter(job => !ACTIVE.has(job.state))
            .sort((a, b) => String(b.finished || '').localeCompare(String(a.finished || '')));
        return [...active, ...finished];
    }

    function renderQueue() {
        const box = $('runQueue');
        if (!box) return;
        if (!state.jobs.length) {
            box.innerHTML = '';
            return;
        }
        box.innerHTML = `
            <div class="run-results-title">File d'exécution</div>
            ${orderedJobs().map(job => {
                const datasets = (job.datasets || []).map(d => d.name).join(', ') || 'Données intégrées';
                const percent = job.total ? Math.round(100 * job.done / job.total) : 0;
                return `
                    <div class="run-job run-job--${escapeHtml(job.state)}">
                        <div class="run-job-head">
                            <span class="run-job-label" title="${escapeHtml(job.label)}">${escapeHtml(job.label)}</span>
                            ${jobStateBadge(job)}
                        </div>
                        <div class="run-job-data" title="${escapeHtml(datasets)}">${escapeHtml(MODE_LABEL[job.mode] || '')}${job.mode ? ' · ' : ''}${escapeHtml(datasets)}</div>
                        ${job.state === 'running' ? `<div class="run-job-progress"><span style="width: ${percent}%"></span></div>` : ''}
                        <div class="run-job-actions">
                            ${jobReports(job)}
                            ${job.state === 'queued' ? `<button type="button" class="console-clear-btn" data-action="cancel-job" data-id="${escapeHtml(job.id)}">Retirer</button>` : ''}
                        </div>
                    </div>
                `;
            }).join('')}
        `;
    }

    function renderConsole() {
        const box = $('runConsoleContent');
        if (!box) return;
        const lines = state.jobs
            .flatMap(job => (job.log || []).map(line => ({ ...line, label: job.label })))
            .filter(line => line.time > state.consoleSince)
            .sort((a, b) => a.time.localeCompare(b.time));
        if (!lines.length) {
            box.innerHTML = `<div class="console-line"><span class="console-message">Prêt. Les analyses ajoutées à la file s'exécutent une par une.</span></div>`;
            return;
        }
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
        box.innerHTML = lines.map(line => `
            <div class="console-line">
                <span class="console-time">[${escapeHtml(formatTime(line.time))}]</span>
                <span class="console-job">${escapeHtml(line.label)}</span>
                <span class="console-message ${escapeHtml(line.level)}">${escapeHtml(line.message)}</span>
            </div>
        `).join('');
        if (atBottom) box.scrollTop = box.scrollHeight;
    }

    // =====================================================================
    // Suivi de la file
    // =====================================================================

    async function refreshJobs() {
        const { ok, body } = await fetchJson(`${API}/jobs`);
        if (!ok) return false;
        const jobs = body.jobs || [];
        if (state.knownFinished === null) {
            // Premier chargement: les executions deja terminees ne sont pas annoncees.
            state.knownFinished = new Set(jobs.filter(job => !ACTIVE.has(job.state)).map(job => job.id));
        }
        jobs.forEach(job => {
            if (ACTIVE.has(job.state) || state.knownFinished.has(job.id)) return;
            state.knownFinished.add(job.id);
            announce(job);
        });
        state.jobs = jobs;
        renderQueue();
        renderConsole();
        return true;
    }

    function announce(job) {
        if (job.state === 'cancelled') return;
        if (job.state === 'failed') {
            notify(`« ${job.label} » : échec de l'exécution`, 'error');
            return;
        }
        const runs = job.result?.runs || [];
        const failed = runs.filter(run => run.status !== 'succeeded').length;
        notify(
            failed
                ? `« ${job.label} » terminée : ${runs.length} exécution(s), ${failed} avec des erreurs`
                : `« ${job.label} » terminée : ${runs.length} rapport(s) produit(s)`,
            failed ? 'warning' : 'success'
        );
    }

    // Interroge le serveur tant qu'une execution est en attente ou en cours, ou s'arrete.
    function schedulePoll() {
        if (state.pollTimer) return;
        state.pollTimer = setTimeout(async () => {
            state.pollTimer = null;
            const ok = await refreshJobs();
            if (ok && state.jobs.some(job => ACTIVE.has(job.state))) schedulePoll();
        }, POLL_MS);
    }

    // =====================================================================
    // Resolution des signaux (preflight)
    // =====================================================================

    async function refreshPreflight() {
        const analysis = currentAnalysis();
        state.preflight = null;
        renderSummary();
        if (!analysis || !analysis.hasInputs || !state.selected.length) return;

        // Seule la reponse a la derniere selection compte.
        const seq = ++state.preflightSeq;
        const { ok, body } = await fetchJson(`${API}/preflight`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ analysis_id: analysis.id, datasets: state.selected }),
        });
        if (seq !== state.preflightSeq) return;
        if (!ok) {
            notify(body.error || 'Vérification des signaux impossible', 'error');
            return;
        }
        state.preflight = body;
        renderDatasets();
        renderSummary();
    }

    // =====================================================================
    // Actions
    // =====================================================================

    function pickAnalysis(id) {
        if (id === state.analysisId) return;
        state.analysisId = id;
        render();
        refreshPreflight();
    }

    function toggleDataset(id, checked) {
        state.selected = state.selected.filter(item => item !== id);
        if (checked) state.selected.push(id);
        renderDatasets();
        refreshPreflight();
    }

    function pickMode(mode) {
        if (!MODE_LABEL[mode]) return;
        state.mode = mode;
        renderSummary();
    }

    // Ajoute la selection courante a la file; la selection reste en place pour enchainer.
    async function enqueue() {
        const analysis = currentAnalysis();
        if (!analysis || state.submitting || blocker()) return;
        state.submitting = true;
        renderSummary();
        try {
            const { ok, body } = await fetchJson(`${API}/runs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    analysis_id: analysis.id,
                    datasets: analysis.hasInputs ? state.selected : [],
                    mode: effectiveMode(),
                }),
            });
            if (!ok) {
                notify(body.error || 'Ajout à la file impossible', 'error');
                return;
            }
            const job = body.job;
            notify(`« ${analysis.name} » ajoutée à la file${job.position ? ` (n°${job.position})` : ''}`, 'info');
            if (typeof window.bbTrack === 'function') window.bbTrack('analysis_run');
            await refreshJobs();
            schedulePoll();
        } catch (e) {
            console.error('Analysis enqueue failed', e);
            notify(`Ajout à la file impossible : ${e.message}`, 'error');
        } finally {
            state.submitting = false;
            renderSummary();
        }
    }

    async function cancelJob(id) {
        const { ok, body } = await fetchJson(`${API}/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
        if (!ok) notify(body.error || 'Retrait impossible', 'warning');
        await refreshJobs();
    }

    function clearConsole() {
        const times = state.jobs.flatMap(job => (job.log || []).map(line => line.time));
        state.consoleSince = times.sort().pop() || state.consoleSince;
        renderConsole();
    }

    function setupEventListeners() {
        const view = $('view-reporting-run');
        if (!view) return;
        view.addEventListener('click', (e) => {
            const target = e.target.closest('[data-action]');
            if (!target || ['toggle-dataset', 'pick-mode'].includes(target.dataset.action)) return;
            const { action, id } = target.dataset;
            if (action === 'pick-analysis') pickAnalysis(id);
            else if (action === 'launch') enqueue();
            else if (action === 'cancel-job') cancelJob(id);
            else if (action === 'clear-console') clearConsole();
            else if (action === 'open-report' && typeof window.openReport === 'function') window.openReport(id);
        });
        view.addEventListener('change', (e) => {
            const target = e.target;
            if (target?.dataset?.action === 'toggle-dataset') toggleDataset(target.dataset.id, target.checked);
            else if (target?.dataset?.action === 'pick-mode') pickMode(target.value);
        });
    }

    async function init() {
        if (!state.listenersBound) {
            setupEventListeners();
            state.listenersBound = true;
        }
        loadLists();
        if (await refreshJobs() && state.jobs.some(job => ACTIVE.has(job.state))) schedulePoll();
    }

    // Preselection (relance depuis un rapport, execution depuis une analyse): appliquee au
    // prochain chargement des listes.
    function preselect(selection) {
        state.pending = selection;
    }

    return Object.freeze({ init, preselect });
})();

window.ReportingRun = ReportingRun;
window.initReportingRunView = () => ReportingRun.init();
// Ouvre l'ecran d'execution, analyse et donnees eventuellement preselectionnees.
window.openReportingRun = async (selection = {}) => {
    ReportingRun.preselect(selection);
    if (typeof window.switchView === 'function') {
        await window.switchView('reporting-run', document.querySelector('.nav-item[data-view="reports"]'));
    }
};
