// Baltimore Bird - Commandes de temps integrees a la regle (time-ruler.js)
//
// A droite de la graduation, au-dessus de la colonne des legendes, sur les deux lignes de
// la regle:
// - ligne de l'axe: les actions (historique de vue, zoom, curseurs), en une rangee qui
//   occupe toute la largeur disponible. Ce qui n'y tient pas passe dans un menu "...",
//   par priorite d'usage decroissante, sans changer l'ordre d'affichage;
// - ligne des curseurs: la plage visible, dont un clic ouvre la saisie debut/fin.
//
// Aucun etat de vue ici: les commandes lisent ectx.globalView et sont rafraichies a chaque
// dessin des graphes (rulerSyncPlugin) et a chaque changement de curseur. Les ecritures DOM
// n'ont lieu que sur changement, ce chemin etant parcouru a chaque frame de pan.

import { S } from '../core/state.js';
import { resetView } from './bootstrap.js';
import { ectx } from './context.js';
import { addCursorFromButton, cursorTimeDecimals } from './cursors.js';
import { comparedAcquisitionRange } from './runs.js';
import { formatDurationWithMinutes } from './time-axis.js';
import { parseTimeInput } from './time-ruler.js';
import {
    canRedoView, canUndoView, canZoomToCursors, recordViewChange, redoView, refreshAllPlots, undoView, zoomToCursors,
} from './view-nav.js';

// Etendue minimale d'une fenetre (s), comme le zoom par selection (plot-ui.js).
const MIN_SPAN = 1e-6;
const ZOOM_STEP = 2;
// Gabarit de la rangee (px), aligne sur _ruler-controls.scss: bouton, ecart entre groupes,
// bouton "..." et son ecart, padding horizontal du bloc.
const BTN_PX = 24;
const GROUP_GAP_PX = 6;
const MORE_PX = BTN_PX + 4;
const PAD_PX = 14;

const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const ICONS = {
    undo: `<svg ${SVG_ATTRS}><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>`,
    redo: `<svg ${SVG_ATTRS}><polyline points="15 14 20 9 15 4"/><path d="M4 20v-7a4 4 0 0 1 4-4h12"/></svg>`,
    zoomOut: `<svg ${SVG_ATTRS}><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/>`
        + '<line x1="8" y1="11" x2="14" y2="11"/></svg>',
    zoomIn: `<svg ${SVG_ATTRS}><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16" y2="16"/>`
        + '<line x1="8" y1="11" x2="14" y2="11"/><line x1="11" y1="8" x2="11" y2="14"/></svg>',
    fit: `<svg ${SVG_ATTRS}><polyline points="4 9 4 4 9 4"/><polyline points="20 9 20 4 15 4"/>`
        + '<polyline points="4 15 4 20 9 20"/><polyline points="20 15 20 20 15 20"/></svg>',
    addCursor: `<svg ${SVG_ATTRS}><line x1="9" y1="4" x2="9" y2="20"/><line x1="6" y1="4" x2="12" y2="4"/>`
        + '<line x1="6" y1="20" x2="12" y2="20"/><line x1="17" y1="9" x2="17" y2="15"/>'
        + '<line x1="14" y1="12" x2="20" y2="12"/></svg>',
    zoomCursors: `<svg ${SVG_ATTRS}><line x1="4" y1="4" x2="4" y2="20"/><line x1="20" y1="4" x2="20" y2="20"/>`
        + '<line x1="8" y1="12" x2="16" y2="12"/><polyline points="10.5 9.5 8 12 10.5 14.5"/>'
        + '<polyline points="13.5 9.5 16 12 13.5 14.5"/></svg>',
    more: `<svg ${SVG_ATTRS}><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/>`
        + '<circle cx="19" cy="12" r="1"/></svg>',
};

function acquisitionRange() {
    const range = comparedAcquisitionRange() || ectx.acquisitionView;
    return range && range.max > range.min ? range : null;
}

function viewCoversAcquisition() {
    const full = acquisitionRange();
    const v = ectx.globalView;
    return !full || (v.min <= full.min && v.max >= full.max);
}

// Nouvelle fenetre: meme traitement qu'un zoom par selection (plot-ui.js), historique
// compris et Y recadre hors panneaux verrouilles.
function commitView(min, max) {
    if (!(max - min >= MIN_SPAN)) return;
    S.plots.forEach(p => { if (!p.yLocked) p.yRange = null; });
    recordViewChange();
    ectx.globalView = { min, max };
    refreshAllPlots();
}

// Zoom centre; au dezoom, la fenetre est ramenee dans l'acquisition quand elle y tient.
function zoomBy(factor) {
    const v = ectx.globalView;
    const span = Math.max(MIN_SPAN, (v.max - v.min) * factor);
    const center = (v.min + v.max) / 2;
    const full = acquisitionRange();
    if (full && factor > 1) {
        if (span >= full.max - full.min) {
            commitView(full.min, full.max);
            return;
        }
        const min = Math.min(full.max - span, Math.max(full.min, center - span / 2));
        commitView(min, min + span);
        return;
    }
    commitView(center - span / 2, center + span / 2);
}

// Ordre d'affichage; `priority` decide de ce qui reste visible quand la place manque
// (1 = garde en dernier). add-cursor reste visible jusqu'a la largeur minimale de la
// legende: l'etape "curseurs" de la visite guidee le designe.
const ACTIONS = [
    { id: 'undo-view', group: 'history', priority: 1, label: 'Vue précédente', key: 'Ctrl+Z', icon: ICONS.undo,
        run: undoView, enabled: canUndoView },
    { id: 'redo-view', group: 'history', priority: 2, label: 'Vue suivante', key: 'Ctrl+Y', icon: ICONS.redo,
        run: redoView, enabled: canRedoView },
    { id: 'zoom-out', group: 'zoom', priority: 6, label: 'Dézoomer', key: '', icon: ICONS.zoomOut,
        run: () => zoomBy(ZOOM_STEP), enabled: () => !viewCoversAcquisition() },
    { id: 'zoom-in', group: 'zoom', priority: 7, label: 'Zoomer', key: '', icon: ICONS.zoomIn,
        run: () => zoomBy(1 / ZOOM_STEP), enabled: () => true },
    { id: 'reset-zoom', group: 'zoom', priority: 4, label: 'Vue complète (bornes Y libérées)', key: '',
        icon: ICONS.fit, run: resetView, enabled: () => true },
    { id: 'add-cursor', group: 'cursors', priority: 3, label: 'Ajouter un curseur', key: 'Ctrl+clic',
        icon: ICONS.addCursor, run: addCursorFromButton, enabled: () => true },
    { id: 'zoom-cursors', group: 'cursors', priority: 5, label: 'Zoomer sur les curseurs', key: '',
        icon: ICONS.zoomCursors, run: zoomToCursors, enabled: canZoomToCursors },
];

// =========================================================================
// Construction
// =========================================================================
export function mountRulerControls(ruler) {
    const el = document.createElement('div');
    el.className = 'ruler-controls';
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', 'Navigation temporelle');

    const row = document.createElement('div');
    row.className = 'rc-buttons';
    const controls = { el, row, buttons: new Map(), avail: null, overflow: [], texts: {}, menu: null, editor: null };

    ACTIONS.forEach(action => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'rc-btn';
        btn.dataset.action = action.id;
        btn.dataset.group = action.group;
        const title = action.key ? `${action.label} (${action.key})` : action.label;
        btn.title = title;
        btn.setAttribute('aria-label', title);
        btn.innerHTML = action.icon;
        btn.addEventListener('click', () => action.run());
        controls.buttons.set(action.id, btn);
        row.appendChild(btn);
    });

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'rc-btn rc-more';
    more.title = 'Autres actions';
    more.setAttribute('aria-label', 'Autres actions');
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');
    more.hidden = true;
    more.innerHTML = ICONS.more;
    more.addEventListener('click', () => toggleMenu(controls));
    controls.more = more;
    row.appendChild(more);

    const range = document.createElement('button');
    range.type = 'button';
    range.className = 'rc-range';
    range.setAttribute('aria-haspopup', 'dialog');
    range.innerHTML = '<span class="rc-range-bounds"></span><span class="rc-range-span"></span>';
    range.addEventListener('click', () => openRangeEditor(controls));
    controls.range = range;
    controls.boundsText = range.querySelector('.rc-range-bounds');
    controls.spanText = range.querySelector('.rc-range-span');

    el.append(row, range);
    // La regle se deplace par glisser sur sa piste; rien ici ne doit l'amorcer.
    el.addEventListener('mousedown', e => e.stopPropagation());
    ruler.controls = controls;
    ruler.tools = el;
    ruler.el.appendChild(el);
    updateRulerControls(ruler);
}

// =========================================================================
// Disposition: largeur au-dessus de la colonne des legendes
// =========================================================================

// Largeur de la rangee pour un ensemble d'actions visibles (ordre d'affichage), groupes
// separes par un ecart.
function rowWidth(visibleIds, withMore) {
    let width = 0;
    let lastGroup = null;
    ACTIONS.forEach(a => {
        if (!visibleIds.has(a.id)) return;
        if (lastGroup !== null && a.group !== lastGroup) width += GROUP_GAP_PX;
        width += BTN_PX;
        lastGroup = a.group;
    });
    return width + (withMore ? MORE_PX : 0);
}

// avail: largeur entre la fin de la piste et le bord droit de la regle. Appelee depuis
// alignTo (chemin de dessin): ne recalcule que si cette largeur change.
export function layoutRulerControls(ruler, avail) {
    const controls = ruler.controls;
    if (!controls || avail === controls.avail) return;
    controls.avail = avail;
    controls.el.style.width = `${Math.max(0, avail)}px`;

    const content = avail - PAD_PX;
    const byPriority = [...ACTIONS].sort((a, b) => a.priority - b.priority);
    let visible = new Set(ACTIONS.map(a => a.id));
    if (rowWidth(visible, false) > content) {
        visible = new Set();
        for (const action of byPriority) {
            const trial = new Set(visible).add(action.id);
            if (rowWidth(trial, true) > content) break;
            visible = trial;
        }
    }
    controls.overflow = ACTIONS.filter(a => !visible.has(a.id));

    let lastGroup = null;
    ACTIONS.forEach(a => {
        const btn = controls.buttons.get(a.id);
        const shown = visible.has(a.id);
        btn.hidden = !shown;
        btn.classList.toggle('is-group-start', shown && lastGroup !== null && a.group !== lastGroup);
        if (shown) lastGroup = a.group;
    });
    controls.more.hidden = controls.overflow.length === 0;
    if (controls.menu) closeMenu(controls);
}

// =========================================================================
// Rafraichissement (etats, plage visible)
// =========================================================================
export function updateRulerControls(ruler) {
    const controls = ruler.controls;
    if (!controls) return;
    ACTIONS.forEach(a => {
        const btn = controls.buttons.get(a.id);
        const off = !a.enabled();
        if (btn.disabled !== off) btn.disabled = off;
    });

    const v = ectx.globalView;
    const wrapper = ruler.el.parentElement;
    const chart = S.plots.find(p => p.chart && wrapper && wrapper.contains(p.element))?.chart || null;
    const d = cursorTimeDecimals(chart);
    const bounds = `${v.min.toFixed(d)} → ${v.max.toFixed(d)} s`;
    const span = `Δ ${formatDurationWithMinutes(v.max - v.min, d)}`;
    if (controls.texts.bounds !== bounds) {
        controls.texts.bounds = bounds;
        controls.boundsText.textContent = bounds;
    }
    if (controls.texts.span !== span) {
        controls.texts.span = span;
        controls.spanText.textContent = span;
        controls.range.title = `Plage visible : ${bounds} (${span}) - cliquer pour la saisir`;
    }
}

// =========================================================================
// Popovers (menu des actions masquees, saisie de la plage)
// =========================================================================
function placeBelow(pop, anchor) {
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(rect.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - margin));
    let top = rect.bottom + 4;
    if (top + pop.offsetHeight > window.innerHeight - margin) top = Math.max(margin, rect.top - pop.offsetHeight - 4);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
}

// Fermeture commune: clic hors du popover et de son ancre, Echap (en capture, avant les
// autres handlers Echap de la vue).
function dismissable(pop, anchor, onClose) {
    const onDown = e => {
        if (!pop.contains(e.target) && !anchor.contains(e.target)) onClose();
    };
    const onKey = e => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onClose();
        anchor.focus();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
    };
}

function toggleMenu(controls) {
    if (controls.menu) closeMenu(controls);
    else openMenu(controls);
}

function openMenu(controls) {
    const menu = document.createElement('div');
    menu.className = 'rc-popover rc-menu';
    menu.setAttribute('role', 'menu');
    controls.overflow.forEach(action => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'rc-menu-item';
        item.setAttribute('role', 'menuitem');
        item.disabled = !action.enabled();
        item.innerHTML = `${action.icon}<span class="rc-menu-label"></span><span class="rc-menu-key"></span>`;
        item.querySelector('.rc-menu-label').textContent = action.label;
        item.querySelector('.rc-menu-key').textContent = action.key;
        item.addEventListener('click', () => {
            closeMenu(controls);
            action.run();
        });
        menu.appendChild(item);
    });
    document.body.appendChild(menu);
    placeBelow(menu, controls.more);
    controls.menu = { el: menu, release: dismissable(menu, controls.more, () => closeMenu(controls)) };
    controls.more.setAttribute('aria-expanded', 'true');
    const first = menu.querySelector('.rc-menu-item:not(:disabled)');
    if (first) first.focus();
}

function closeMenu(controls) {
    if (!controls.menu) return;
    controls.menu.release();
    controls.menu.el.remove();
    controls.menu = null;
    controls.more.setAttribute('aria-expanded', 'false');
}

function openRangeEditor(controls) {
    if (controls.editor) return;
    const v = ectx.globalView;
    const d = cursorTimeDecimals(S.plots.find(p => p.chart)?.chart || null);

    const form = document.createElement('form');
    form.className = 'rc-popover rc-range-form';
    form.setAttribute('role', 'dialog');
    form.setAttribute('aria-label', 'Plage visible');
    form.noValidate = true;
    const field = (label, value) => {
        const wrap = document.createElement('label');
        wrap.className = 'rc-field';
        const text = document.createElement('span');
        text.textContent = label;
        const input = document.createElement('input');
        input.type = 'text';
        input.inputMode = 'decimal';
        input.autocomplete = 'off';
        input.value = value.toFixed(d);
        input.addEventListener('input', () => input.classList.remove('is-invalid'));
        wrap.append(text, input);
        form.appendChild(wrap);
        return input;
    };
    const startInput = field('Début (s)', v.min);
    const endInput = field('Fin (s)', v.max);
    const hint = document.createElement('div');
    hint.className = 'rc-range-hint';
    hint.textContent = 'Entrée pour appliquer, Échap pour annuler';
    form.appendChild(hint);

    const close = () => {
        if (!controls.editor) return;
        controls.editor.release();
        controls.editor.el.remove();
        controls.editor = null;
    };
    const apply = () => {
        const start = parseTimeInput(startInput.value);
        const end = parseTimeInput(endInput.value);
        const order = start !== null && end !== null && end - start >= MIN_SPAN;
        startInput.classList.toggle('is-invalid', start === null || (end !== null && !order));
        endInput.classList.toggle('is-invalid', end === null || (start !== null && !order));
        if (!order) return;
        close();
        commitView(start, end);
        controls.range.focus();
    };
    // Entree applique depuis l'un ou l'autre champ; les touches ne remontent pas aux
    // raccourcis de la vue (fleches des curseurs, Suppr, ?).
    form.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key !== 'Enter') return;
        e.preventDefault();
        apply();
    });
    form.addEventListener('submit', e => e.preventDefault());

    document.body.appendChild(form);
    placeBelow(form, controls.range);
    controls.editor = { el: form, release: dismissable(form, controls.range, close) };
    startInput.focus();
    startInput.select();
}
