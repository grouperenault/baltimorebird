// Baltimore Bird - Barre de section (haut de la zone de contenu)
//
// Les sections a plusieurs vues partagent une barre d'onglets, au style de la barre des
// fichiers de l'EDA (.file-bar, .file-tab), avec la marque a droite:
// - Reporting: les trois temps d'une analyse generique: l'ecrire (vue `dashboard`),
//   l'executer sur des donnees choisies (vue `reporting-run`), lire ses rapports (vue `reports`);
// - Live Dashboards: le catalogue des tableaux de bord de l'equipe data (vue `live`).
// L'EDA a sa propre barre (les fichiers ouverts): la barre de section y est masquee.
//
// Les identifiants de vue internes (`reports`, `dashboard`, `reporting-run`) sont conserves: le
// verrouillage invite (auth.js), la visite guidee et l'initialisation des vues (init.js)
// s'appuient dessus.

const SECTIONS = [
    {
        nav: 'reports',
        label: 'Reporting',
        tabs: [
            { view: 'dashboard', label: 'Analyses' },
            { view: 'reporting-run', label: 'Exécuter' },
            { view: 'reports', label: 'Rapports' },
        ],
    },
    {
        nav: 'live',
        label: 'Live Dashboards',
        tabs: [
            { view: 'live', label: 'Catalogue' },
        ],
    },
];

function sectionOf(viewId) {
    return SECTIONS.find(section => section.tabs.some(tab => tab.view === viewId)) || null;
}

function navItemOf(section) {
    return document.querySelector(`.nav-item[data-view="${section.nav}"]`);
}

// Appelee par switchView (init.js) apres chaque changement de vue.
export function updateSectionBar(viewId) {
    const bar = document.getElementById('sectionBar');
    const tabs = document.getElementById('sectionTabs');
    if (!bar || !tabs) return;
    const section = sectionOf(viewId);
    bar.hidden = !section;
    if (!section) return;

    // L'entree de nav de la section reste allumee quelle que soit la vue affichee.
    const navItem = navItemOf(section);
    if (navItem && !navItem.classList.contains('active')) {
        document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
        navItem.classList.add('active');
    }

    tabs.setAttribute('aria-label', section.label);
    tabs.replaceChildren(...section.tabs.map(tab => {
        const active = tab.view === viewId;
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'file-tab' + (active ? ' active' : '');
        el.setAttribute('role', 'tab');
        el.setAttribute('aria-selected', active ? 'true' : 'false');
        const name = document.createElement('span');
        name.className = 'file-tab-name';
        name.textContent = tab.label;
        el.appendChild(name);
        if (!active) {
            el.addEventListener('click', () => {
                if (typeof window.switchView === 'function') window.switchView(tab.view, navItemOf(section));
            });
        }
        return el;
    }));
}

window.updateSectionBar = updateSectionBar;
