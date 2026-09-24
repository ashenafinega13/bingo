"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CardGenerator = exports.CARTELA_POOL_SIZE = exports.LETTER_RANGES = exports.COLUMN_LETTERS = void 0;
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
exports.CARTELA_POOL_SIZE = 600;
class CardGenerator {
    static generate() {
        return this.shuffleIntoCard(() => Math.random());
    }
    /** Deterministic card for a given cartela number (1..CARTELA_POOL_SIZE).
     * The same number always produces the exact same layout, every game,
     * for every player — matching how a physical cartela booklet works,
     * and letting a "Cartela #42" mean something consistent to players. */
    static generateFixed(cartelaNumber) {
        const rand = mulberry32(cartelaNumber);
        return this.shuffleIntoCard(rand);
    }
    static shuffleIntoCard(rand) {
        const card = [[], [], [], [], []];
        exports.COLUMN_LETTERS.forEach((letter, col) => {
            const [low, high] = exports.LETTER_RANGES[letter];
            const pool = [];
            for (let n = low; n <= high; n++)
                pool.push(n);
            for (let i = pool.length - 1; i > 0; i--) {
                const j = Math.floor(rand() * (i + 1));
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
/** Small, fast seeded PRNG (mulberry32) — deterministic across runs and
 * platforms, unlike Math.random(), so the same seed always reproduces the
 * exact same shuffle order. */
function mulberry32(seed) {
    let a = seed;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
