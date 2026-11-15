// Baltimore Bird - Format de liste de signaux .LAB (fichier texte, un signal par ligne).
//
// Fonctions pures, sans DOM: la serialisation part d'un layout au format de
// exportCurrentLayout() (layout-state.js), l'analyse renvoie des noms bruts que
// l'appelant resout contre les signaux du fichier courant.
//
// L'analyse tolere les fichiers LAB produits par les outils de calibration (ETAS INCA,
// MDA): les en-tetes de section ([RAMCELL], [LABEL], ...) et les commentaires ";" sont
// ignores, ce qui permet de relire un fichier LAB existant et pas seulement les notres.

const LINE_BREAK = '\r\n';

/**
 * Collects the signal names referenced by the plots of the given layout tabs.
 *
 * Covers time plots (including signals kept greyed out because they are absent from the
 * current file) and X/Y plots (X axis then Y series). Order follows the plots; each name
 * appears once.
 *
 * @param {Array<Object>} tabs Tabs in exportCurrentLayout() format.
 * @returns {string[]} Unique signal names, in plot order.
 */
export function signalNamesFromTabs(tabs) {
    const names = [];
    const seen = new Set();
    const push = name => {
        if (typeof name !== 'string') return;
        const clean = name.trim();
        if (!clean || seen.has(clean)) return;
        seen.add(clean);
        names.push(clean);
    };
    (tabs || []).forEach(tab => (tab?.plots || []).forEach(plot => {
        (plot?.signals || []).forEach(sig => push(sig?.name));
        if (plot?.kind === 'xy') {
            push(plot.x);
            (plot.ys || []).forEach(y => push(y?.name));
        }
    }));
    return names;
}

/**
 * Serialises signal names to LAB text: one name per line, CRLF line endings.
 *
 * @param {string[]} names Signal names.
 * @returns {string} LAB file content, empty when there is no name.
 */
export function namesToLab(names) {
    return names.length ? names.join(LINE_BREAK) + LINE_BREAK : '';
}

/**
 * Builds the LAB content of a layout, for one tab or for the whole layout.
 *
 * @param {{tabs: Array<Object>}} layout Layout in exportCurrentLayout() format.
 * @param {number|null} tabIndex Index of the tab to export, or null for every tab.
 * @returns {{text: string, count: number}} LAB content and number of signals written.
 */
export function layoutToLab(layout, tabIndex = null) {
    const tabs = layout?.tabs || [];
    const selected = tabIndex === null ? tabs : [tabs[tabIndex]].filter(Boolean);
    const names = signalNamesFromTabs(selected);
    return { text: namesToLab(names), count: names.length };
}

/**
 * Parses LAB text into signal names.
 *
 * Skips blank lines, ";" comments (whole line or trailing) and "[SECTION]" headers.
 * Strips a UTF-8 BOM and accepts LF, CRLF and CR line endings. Duplicates are dropped.
 *
 * @param {string} text LAB file content.
 * @returns {string[]} Unique signal names, in file order.
 */
export function parseLab(text) {
    const names = [];
    const seen = new Set();
    String(text || '').replace(/^﻿/, '').split(/\r\n|\r|\n/).forEach(raw => {
        const line = raw.replace(/;.*$/, '').trim();
        if (!line || /^\[.*\]$/.test(line) || seen.has(line)) return;
        seen.add(line);
        names.push(line);
    });
    return names;
}

/**
 * Resolves LAB names against the signals of the current file.
 *
 * Exact match first, then case-insensitive match (calibration tools are not consistent
 * about label case).
 *
 * @param {string[]} names Names read from a LAB file.
 * @param {Array<{name: string, index: number}>} signalsInfo Signals of the current file.
 * @returns {{indices: number[], missing: string[]}} Resolved indices (unique) and unmatched names.
 */
export function resolveLabNames(names, signalsInfo) {
    const exact = new Map();
    const folded = new Map();
    (signalsInfo || []).forEach(sig => {
        if (!sig || typeof sig.name !== 'string') return;
        if (!exact.has(sig.name)) exact.set(sig.name, sig.index);
        const key = sig.name.toLowerCase();
        if (!folded.has(key)) folded.set(key, sig.index);
    });
    const indices = [];
    const missing = [];
    const taken = new Set();
    names.forEach(name => {
        const idx = exact.has(name) ? exact.get(name) : folded.get(name.toLowerCase());
        if (idx === undefined) {
            missing.push(name);
        } else if (!taken.has(idx)) {
            taken.add(idx);
            indices.push(idx);
        }
    });
    return { indices, missing };
}
