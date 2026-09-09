"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WinValidator = void 0;
const CardGenerator_1 = require("./CardGenerator");
/**
 * Server-side win check. This is the ONLY place a win is ever decided —
 * the client's local rendering of "marked" cells is cosmetic. A claim is
 * always re-checked here against the room's own drawn-number list, never
 * against anything the client asserts about its own state.
 */
class WinValidator {
    static validate(card, drawnNumbers) {
        const drawn = new Set(drawnNumbers);
        const isMarked = (r, c) => card[r][c] === "FREE" || drawn.has(card[r][c]);
        for (let r = 0; r < 5; r++) {
            if ([0, 1, 2, 3, 4].every((c) => isMarked(r, c)))
                return { won: true, pattern: `Row ${r + 1}` };
        }
        for (let c = 0; c < 5; c++) {
            if ([0, 1, 2, 3, 4].every((r) => isMarked(r, c)))
                return { won: true, pattern: `Column ${CardGenerator_1.COLUMN_LETTERS[c]}` };
        }
        if ([0, 1, 2, 3, 4].every((i) => isMarked(i, i)))
            return { won: true, pattern: "Diagonal" };
        if ([0, 1, 2, 3, 4].every((i) => isMarked(i, 4 - i)))
            return { won: true, pattern: "Diagonal" };
        if (isMarked(0, 0) && isMarked(0, 4) && isMarked(4, 0) && isMarked(4, 4)) {
            return { won: true, pattern: "Four Corners" };
        }
        return { won: false };
    }
}
exports.WinValidator = WinValidator;
