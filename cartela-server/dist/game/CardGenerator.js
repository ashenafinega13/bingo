"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CardGenerator = exports.LETTER_RANGES = exports.COLUMN_LETTERS = void 0;
exports.numberLetter = numberLetter;
exports.COLUMN_LETTERS = ["B", "I", "N", "G", "O"];
exports.LETTER_RANGES = {
    B: [1, 15],
    I: [16, 30],
    N: [31, 45],
    G: [46, 60],
    O: [61, 75],
};
function numberLetter(n) {
    for (const letter of exports.COLUMN_LETTERS) {
        const [low, high] = exports.LETTER_RANGES[letter];
        if (n >= low && n <= high)
            return letter;
    }
    return "?";
}
class CardGenerator {
    static generate() {
        const card = [[], [], [], [], []];
        exports.COLUMN_LETTERS.forEach((letter, col) => {
            const [low, high] = exports.LETTER_RANGES[letter];
            const pool = [];
            for (let n = low; n <= high; n++)
                pool.push(n);
            // Fisher-Yates shuffle
            for (let i = pool.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [pool[i], pool[j]] = [pool[j], pool[i]];
            }
            for (let row = 0; row < 5; row++)
                card[row][col] = pool[row];
        });
        card[2][2] = "FREE";
        return card;
    }
}
exports.CardGenerator = CardGenerator;
