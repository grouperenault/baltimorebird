// Baltimore Bird - Aide des raccourcis clavier et souris de la vue EDA (touche ?)
//
// Liste statique: chaque entree decrit un comportement implemente ailleurs (cursors.js,
// plot-ui.js, time-ruler.js, signal-list.js). Toute modification d'un raccourci doit
// etre reportee ici.

const SECTIONS = [
    {
        title: 'Navigation',
        rows: [
            [['Glisser'], 'Zoomer sur un graphe (horizontal : temps, vertical : Y, diagonal : boîte)'],
            [['Glisser'], 'Sur la règle de temps : déplacer la fenêtre'],
            [['Clic'], 'Sur la plage affichée dans la règle : saisir le début et la fin'],
            [['Molette'], 'Sur l\'axe Y : zoomer en Y'],
            [['Glisser'], 'Sur l\'axe Y : déplacer en Y'],
            [['Ctrl', 'Z'], 'Vue précédente (aussi : double-clic sur un graphe)'],
            [['Ctrl', 'Y'], 'Vue suivante (aussi : Ctrl + Maj + Z)'],
            [['Maj', 'Y'], 'Cadrage Y automatique du panneau survolé'],
        ],
    },
    {
        title: 'Curseurs',
        rows: [
            [['Ctrl', 'Clic'], 'Poser un curseur, sur un graphe ou la règle (sur un curseur : le retirer)'],
            [['←', '→'], 'Déplacer le dernier curseur touché (Maj : pas de 10 pixels)'],
            [['L'], 'Verrouiller l\'écart entre les deux curseurs'],
            [['Double-clic'], 'Sur une pastille de la règle : saisir le temps ou l\'écart'],
            [['Suppr'], 'Retirer le dernier curseur touché'],
        ],
    },
    {
        title: 'Signaux',
        rows: [
            [['Ctrl', 'Clic'], 'Dans la liste : ajouter ou retirer un signal de la sélection'],
            [['Maj', 'Clic'], 'Dans la liste : sélectionner une plage'],
            [['Suppr'], 'Retirer les signaux sélectionnés dans la légende'],
            [['Ctrl', 'C'], 'Copier les noms des signaux sélectionnés dans la légende'],
        ],
    },
    {
        title: 'Général',
        rows: [
            [['?'], 'Afficher ou masquer cette aide'],
            [['Échap'], 'Fermer un panneau, annuler une sélection'],
        ],
    },
];

let popover = null;
let anchorBtn = null;

function buildPopover() {
    const pop = document.createElement('div');
    pop.className = 'shortcuts-popover';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Raccourcis clavier et souris');
    pop.tabIndex = -1;

    const title = document.createElement('div');
    title.className = 'shortcuts-popover-title';
    title.textContent = 'Raccourcis clavier et souris';
    pop.appendChild(title);

    SECTIONS.forEach(section => {
        const heading = document.createElement('div');
        heading.className = 'shortcuts-section-title';
        heading.textContent = section.title;
        pop.appendChild(heading);

        const list = document.createElement('dl');
        list.className = 'shortcuts-list';
        section.rows.forEach(([keys, text]) => {
            const dt = document.createElement('dt');
            keys.forEach((key, i) => {
                if (i > 0) dt.append(key === '→' ? ' ' : ' + ');
                const kbd = document.createElement('kbd');
                kbd.textContent = key;
                dt.appendChild(kbd);
            });
            const dd = document.createElement('dd');
            dd.textContent = text;
            list.append(dt, dd);
        });
        pop.appendChild(list);
    });
    return pop;
}

// Sous le bouton, aligne sur son bord droit et ramene dans la fenetre; centre sans bouton
// visible (ouverture par la touche ? avec la toolbar hors ecran).
function positionPopover(pop, btn) {
    const margin = 8;
    const rect = btn && btn.offsetParent !== null ? btn.getBoundingClientRect() : null;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = rect ? rect.right - w : (window.innerWidth - w) / 2;
    let top = rect ? rect.bottom + 6 : (window.innerHeight - h) / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
    if (top + h > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - h - margin);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
}

function onDocMouseDown(e) {
    if (!popover) return;
    if (popover.contains(e.target) || (anchorBtn && anchorBtn.contains(e.target))) return;
    closeShortcutsHelp();
}

function onDocKeyDown(e) {
    if (e.key !== 'Escape' || !popover) return;
    e.stopPropagation();
    closeShortcutsHelp();
}

export function closeShortcutsHelp() {
    if (!popover) return;
    popover.remove();
    popover = null;
    document.removeEventListener('mousedown', onDocMouseDown, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    if (anchorBtn) {
        anchorBtn.setAttribute('aria-expanded', 'false');
        anchorBtn.classList.remove('active');
        anchorBtn.focus();
    }
}

export function openShortcutsHelp() {
    if (popover) return;
    anchorBtn = document.getElementById('shortcutsHelpBtn');
    popover = buildPopover();
    document.body.appendChild(popover);
    positionPopover(popover, anchorBtn);
    if (anchorBtn) {
        anchorBtn.setAttribute('aria-expanded', 'true');
        anchorBtn.classList.add('active');
    }
    popover.focus();
    // Capture: Echap ferme l'aide avant les autres handlers (deselection, panneaux).
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onDocKeyDown, true);
}

export function toggleShortcutsHelp() {
    if (popover) closeShortcutsHelp();
    else openShortcutsHelp();
}

function isTypingTarget(target) {
    return !!target && (target.tagName === 'INPUT' || target.tagName === 'SELECT'
        || target.tagName === 'TEXTAREA' || target.isContentEditable);
}

// Touche ?: e.key plutot que e.code, le ? n'est pas sur la meme touche en AZERTY et QWERTY.
// Limitee a la vue EDA, la seule dont l'aide decrit les raccourcis.
document.addEventListener('keydown', e => {
    if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    const view = document.getElementById('view-eda');
    if (!view || !view.classList.contains('active')) return;
    e.preventDefault();
    toggleShortcutsHelp();
});
