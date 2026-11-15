import { describe, expect, it } from 'vitest';
import { layoutToLab, namesToLab, parseLab, resolveLabNames, signalNamesFromTabs } from '../src/eda/lab.js';

const layout = {
    tabs: [
        {
            name: 'Main',
            plots: [
                { flex: 1, signals: [{ name: 'VehicleSpeed' }, { name: 'EngineRPM' }] },
                { flex: 1, signals: [{ name: 'EngineRPM' }, { name: 'OilTemp' }] },
                { kind: 'xy', signals: [], x: 'VehicleSpeed', ys: [{ name: 'FuelPressure' }] },
            ],
        },
        { name: 'View 2', plots: [{ flex: 1, signals: [{ name: 'Lambda' }] }] },
    ],
};

describe('signalNamesFromTabs', () => {
    it('collects time and XY signals once, in plot order', () => {
        expect(signalNamesFromTabs([layout.tabs[0]]))
            .toEqual(['VehicleSpeed', 'EngineRPM', 'OilTemp', 'FuelPressure']);
    });

    it('tolerates missing fields', () => {
        expect(signalNamesFromTabs([{}, { plots: [{ kind: 'xy', x: null }] }])).toEqual([]);
    });
});

describe('layoutToLab', () => {
    it('exports a single tab', () => {
        const { text, count } = layoutToLab(layout, 1);
        expect(text).toBe('Lambda\r\n');
        expect(count).toBe(1);
    });

    it('exports the whole layout', () => {
        const { text, count } = layoutToLab(layout, null);
        expect(text.split('\r\n')).toEqual(['VehicleSpeed', 'EngineRPM', 'OilTemp', 'FuelPressure', 'Lambda', '']);
        expect(count).toBe(5);
    });

    it('returns nothing for an unknown tab', () => {
        expect(layoutToLab(layout, 9)).toEqual({ text: '', count: 0 });
    });
});

describe('parseLab', () => {
    it('round-trips the exported text', () => {
        expect(parseLab(namesToLab(['A', 'B.c']))).toEqual(['A', 'B.c']);
    });

    it('skips sections, comments, blanks, BOM and duplicates', () => {
        const text = '﻿; header\n[RAMCELL]\nA\r\n\n  B  ; note\rA\n[LABEL]\nC';
        expect(parseLab(text)).toEqual(['A', 'B', 'C']);
    });
});

describe('resolveLabNames', () => {
    const signals = [{ name: 'EngineRPM', index: 0 }, { name: 'OilTemp', index: 1 }];

    it('matches exactly, then case-insensitively, and reports misses', () => {
        expect(resolveLabNames(['oiltemp', 'EngineRPM', 'Nope', 'OILTEMP'], signals))
            .toEqual({ indices: [1, 0], missing: ['Nope'] });
    });
});
