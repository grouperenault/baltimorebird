import { describe, it, expect } from 'vitest';
import { findInterp2dCall, formatInterp2dCall, gridToText, parseInterpGrid } from '../src/eda/interp-table.js';

// Cartographie 2D d'une variable calculee: lecture d'une cartographie collee depuis un
// tableur (axe x en premiere ligne, axe y en premiere colonne), ecriture de l'appel
// interp2d dans la formule et relecture pour la corriger.

describe('parseInterpGrid', () => {
    it('lit une cartographie collee depuis un tableur, case de coin vide', () => {
        expect(parseInterpGrid('\t1000\t2000\t3000\n0\t1\t2\t3\n50\t4\t5\t6')).toEqual({
            x: [1000, 2000, 3000], y: [0, 50], z: [[1, 2, 3], [4, 5, 6]], error: null,
        });
    });

    it('accepte une case de coin libellee, absente, et la virgule decimale', () => {
        const expected = { x: [0, 10], y: [0, 1], z: [[0.5, 10], [100, 110]], error: null };
        expect(parseInterpGrid('Y\\X;0;10\n0;0,5;10\n1;100;110')).toEqual(expected);
        expect(parseInterpGrid('0 10\n0 0.5 10\n1 100 110')).toEqual(expected);
        expect(parseInterpGrid('\t0\t10\t\n0\t0.5\t10\t\n\n1\t100\t110\n')).toEqual(expected);
    });

    it('trie lignes et colonnes par valeur d\'axe en gardant chaque valeur a sa place', () => {
        expect(parseInterpGrid('\t10\t0\n1\t110\t100\n0\t10\t0')).toEqual({
            x: [0, 10], y: [0, 1], z: [[0, 10], [100, 110]], error: null,
        });
    });

    it('refuse une cartographie mal formee, en disant pourquoi', () => {
        expect(parseInterpGrid('\t0\t1\n0\t1\t2').error).toMatch(/au moins 2 lignes/);
        expect(parseInterpGrid('\t0\n0\t1\n1\t2').error).toMatch(/Ligne 1/);
        expect(parseInterpGrid('\t0\t1\n0\t1\t2\n1\t2').error).toMatch(/Ligne 3 : 3 nombres/);
        expect(parseInterpGrid('\t0\t1\n0\t1\tabc\n1\t2\t3').error).toMatch(/Ligne 2/);
        expect(parseInterpGrid('\t0\t0\n0\t1\t2\n1\t2\t3').error).toMatch(/x = 0 apparaît deux fois/);
        expect(parseInterpGrid('\t0\t1\n5\t1\t2\n5\t2\t3').error).toMatch(/y = 5 apparaît deux fois/);
        const axis = Array.from({ length: 60 }, (_, i) => i);
        const big = [`\t${axis.join('\t')}`, ...axis.map(v => `${v}\t${axis.join('\t')}`)].join('\n');
        expect(parseInterpGrid(big).error).toMatch(/max 2500/);
    });
});

describe('appel interp2d dans la formule', () => {
    it('ecrit un appel que le serveur sait evaluer', () => {
        expect(formatInterp2dCall(' A ', 'B', [0, 10], [0, 1], [[0, 10], [100, 110]]))
            .toBe('interp2d(A, B, [0, 10], [0, 1], [[0, 10], [100, 110]])');
    });

    it('relit la cartographie d\'une formule pour la rouvrir dans l\'editeur', () => {
        const formula = '2 * interp2d(A * 2, B, [0, 10, 20], [-1, 1], [[0, 1.5, 3], [-4, 5, 6e3]]) + 1';
        const found = findInterp2dCall(formula);
        expect(found.text).toBe('interp2d(A * 2, B, [0, 10, 20], [-1, 1], [[0, 1.5, 3], [-4, 5, 6e3]])');
        expect(found.inputX).toBe('A * 2');
        expect(found.inputY).toBe('B');
        expect(found.z).toEqual([[0, 1.5, 3], [-4, 5, 6000]]);
        const reparsed = parseInterpGrid(gridToText(found.x, found.y, found.z));
        expect(reparsed).toEqual({ x: found.x, y: found.y, z: found.z, error: null });
    });

    it('ne trouve rien sans appel bien forme', () => {
        expect(findInterp2dCall('interp1d(A, [0, 1], [0, 1])')).toBe(null);
        expect(findInterp2dCall('interp2d(A, B, [0, 1], [0, 1], [[0, 1]])')).toBe(null);
        expect(findInterp2dCall('interp2d(A, B, [0, 1], [0, 1], [[0, 1], [2]])')).toBe(null);
    });
});
