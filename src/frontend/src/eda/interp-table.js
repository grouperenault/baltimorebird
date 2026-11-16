// Baltimore Bird - Tables d'interpolation d'une variable calculee (fonctions interp1d et interp2d)
//
// La table s'ecrit dans la formule meme: interp1d(A, [x0, x1], [y0, y1]). Elle est donc
// enregistree et exportee avec elle (layout, espace de travail, LXF) sans champ a part.
// Module pur: lecture d'un tableau colle, ecriture et relecture de l'appel.

// Meme borne que le serveur (INTERP_MAX_POINTS, api/computed.py).
export const INTERP_MAX_POINTS = 500;

function parseNumber(cell) {
    const text = cell.trim().replace(/\s/g, '').replace(',', '.');
    if (text === '' || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return NaN;
    return Number(text);
}

// Cellules d'une ligne. Tabulation ou point-virgule (tableur, CSV francais): la virgule
// reste un separateur decimal. Sinon des espaces, et a defaut seulement la virgule.
function splitCells(line) {
    if (/[\t;]/.test(line)) return line.split(/[\t;]/);
    const bySpace = line.trim().split(/\s+/);
    if (bySpace.length >= 2) return bySpace;
    return line.split(',');
}

/**
 * Lit une table collee, deux colonnes x et y, une ligne par point.
 * Une premiere ligne d'en-tete est ignoree; les points sont tries par x.
 *
 * @param {string} text Texte colle.
 * @returns {{x: number[], y: number[], error: string|null}} error en francais si invalide.
 */
export function parseInterpTable(text) {
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const points = [];
    for (let i = 0; i < lines.length; i++) {
        const cells = splitCells(lines[i]).map(c => c.trim()).filter(c => c !== '');
        const x = cells.length >= 2 ? parseNumber(cells[0]) : NaN;
        const y = cells.length >= 2 ? parseNumber(cells[1]) : NaN;
        if (Number.isNaN(x) || Number.isNaN(y) || cells.length > 2) {
            // En-tete de colonnes en premiere ligne.
            if (i === 0 && cells.length === 2 && Number.isNaN(x) && Number.isNaN(y)) continue;
            return { x: [], y: [], error: `Ligne ${i + 1} : deux nombres attendus (x puis y)` };
        }
        points.push([x, y]);
    }
    if (points.length < 2) return { x: [], y: [], error: 'Au moins 2 points sont nécessaires' };
    if (points.length > INTERP_MAX_POINTS) {
        return { x: [], y: [], error: `Table trop longue (max ${INTERP_MAX_POINTS} points)` };
    }
    points.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < points.length; i++) {
        if (points[i][0] === points[i - 1][0]) {
            return { x: [], y: [], error: `La valeur x = ${points[i][0]} apparaît deux fois` };
        }
    }
    return { x: points.map(p => p[0]), y: points.map(p => p[1]), error: null };
}

// Appel a inserer dans la formule.
export function formatInterpCall(input, x, y) {
    return `interp1d(${String(input).trim()}, [${x.join(', ')}], [${y.join(', ')}])`;
}

/**
 * Premier appel interp1d d'une formule, pour le rouvrir dans l'editeur de table.
 *
 * @param {string} formula Formule.
 * @returns {{text: string, input: string, x: number[], y: number[]}|null} null si absent.
 */
export function findInterpCall(formula) {
    const match = /interp1d\(\s*([^,[\]]+?)\s*,\s*[[(]([^\])]*)[\])]\s*,\s*[[(]([^\])]*)[\])]\s*\)/.exec(String(formula || ''));
    if (!match) return null;
    const numbers = list => list.split(',').map(v => v.trim()).filter(Boolean).map(Number);
    const x = numbers(match[2]);
    const y = numbers(match[3]);
    if (x.some(Number.isNaN) || y.some(Number.isNaN) || x.length !== y.length) return null;
    return { text: match[0], input: match[1], x, y };
}

// Texte de l'editeur pour une table: une ligne "x<TAB>y" par point.
export function tableToText(x, y) {
    return x.map((value, i) => `${value}\t${y[i]}`).join('\n');
}

// =========================================================================
// Cartographie 2D (fonction interp2d)
// =========================================================================
// interp2d(X, Y, [x...], [y...], [[z...], ...]): une ligne de z par point de l'axe y,
// autant de valeurs par ligne que de points sur l'axe x. C'est la disposition d'une
// cartographie dans un tableur: axe x en premiere ligne, axe y en premiere colonne.

// Meme borne que le serveur (INTERP2D_MAX_CELLS, api/computed.py).
export const INTERP2D_MAX_CELLS = 2500;

// Indices qui trient un axe, ou message si une valeur y apparait deux fois.
function sortedOrder(axis, label) {
    const order = axis.map((_, i) => i).sort((a, b) => axis[a] - axis[b]);
    for (let i = 1; i < order.length; i++) {
        if (axis[order[i]] === axis[order[i - 1]]) {
            return { order: null, error: `La valeur ${label} = ${axis[order[i]]} apparaît deux fois` };
        }
    }
    return { order, error: null };
}

/**
 * Lit une cartographie collee depuis un tableur.
 * Premiere ligne: points de l'axe x, apres une case de coin vide ou libellee (facultative).
 * Lignes suivantes: le point de l'axe y, puis une valeur par point de l'axe x.
 * Lignes et colonnes sont triees par valeur d'axe croissante.
 *
 * @param {string} text Texte colle.
 * @returns {{x: number[], y: number[], z: number[][], error: string|null}} error en francais si invalide.
 */
export function parseInterpGrid(text) {
    const fail = error => ({ x: [], y: [], z: [], error });
    const lines = String(text || '').split(/\r?\n/).filter(line => line.trim());
    if (lines.length < 3) return fail('Il faut l\'axe x en première ligne puis au moins 2 lignes de valeurs');
    const rows = lines.map(line => {
        const cells = splitCells(line).map(c => c.trim());
        while (cells.length && cells[cells.length - 1] === '') cells.pop();
        return cells;
    });

    const header = rows[0].slice();
    const width = rows[1].length;
    // Case de coin: vide, libellee (ex. "Y\X"), ou absente.
    if (header.length === width || Number.isNaN(parseNumber(header[0] || ''))) header.shift();
    const x = header.map(parseNumber);
    if (header.length < 2 || x.some(Number.isNaN)) {
        return fail('Ligne 1 : les points de l\'axe x sont attendus (au moins 2 nombres)');
    }

    const y = [];
    const z = [];
    for (let i = 1; i < rows.length; i++) {
        const numbers = rows[i].map(parseNumber);
        if (rows[i].length !== x.length + 1 || numbers.some(Number.isNaN)) {
            return fail(`Ligne ${i + 1} : ${x.length + 1} nombres attendus (y puis une valeur par x)`);
        }
        y.push(numbers[0]);
        z.push(numbers.slice(1));
    }
    if (x.length * y.length > INTERP2D_MAX_CELLS) {
        return fail(`Cartographie trop grande (max ${INTERP2D_MAX_CELLS} valeurs)`);
    }

    const columns = sortedOrder(x, 'x');
    if (columns.error) return fail(columns.error);
    const lineOrder = sortedOrder(y, 'y');
    if (lineOrder.error) return fail(lineOrder.error);
    return {
        x: columns.order.map(j => x[j]),
        y: lineOrder.order.map(i => y[i]),
        z: lineOrder.order.map(i => columns.order.map(j => z[i][j])),
        error: null,
    };
}

// Appel a inserer dans la formule.
export function formatInterp2dCall(inputX, inputY, x, y, z) {
    const rows = z.map(row => `[${row.join(', ')}]`).join(', ');
    return `interp2d(${String(inputX).trim()}, ${String(inputY).trim()}, [${x.join(', ')}], [${y.join(', ')}], [${rows}])`;
}

/**
 * Premier appel interp2d d'une formule, pour le rouvrir dans l'editeur de cartographie.
 *
 * @param {string} formula Formule.
 * @returns {{text: string, inputX: string, inputY: string, x: number[], y: number[], z: number[][]}|null}
 *     null si absent ou mal forme.
 */
export function findInterp2dCall(formula) {
    const match = /interp2d\(\s*([^,[\]()]+?)\s*,\s*([^,[\]()]+?)\s*,\s*\[([^\]]*)\]\s*,\s*\[([^\]]*)\]\s*,\s*\[((?:\s*\[[^\]]*\]\s*,?)*)\s*\]\s*\)/
        .exec(String(formula || ''));
    if (!match) return null;
    const numbers = list => list.split(',').map(v => v.trim()).filter(Boolean).map(Number);
    const x = numbers(match[3]);
    const y = numbers(match[4]);
    const z = [...match[5].matchAll(/\[([^\]]*)\]/g)].map(row => numbers(row[1]));
    const valid = [x, y, ...z].every(list => !list.some(Number.isNaN))
        && z.length === y.length && z.every(row => row.length === x.length);
    if (!valid) return null;
    return { text: match[0], inputX: match[1], inputY: match[2], x, y, z };
}

// Texte de l'editeur pour une cartographie: axe x en premiere ligne, puis "y<TAB>z...".
export function gridToText(x, y, z) {
    return [`\t${x.join('\t')}`, ...y.map((value, i) => `${value}\t${z[i].join('\t')}`)].join('\n');
}
