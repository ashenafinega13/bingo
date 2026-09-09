export const COLUMN_LETTERS = ["B", "I", "N", "G", "O"] as const;
export const LETTER_RANGES: Record<string, [number, number]> = {
  B: [1, 15],
  I: [16, 30],
  N: [31, 45],
  G: [46, 60],
  O: [61, 75],
};

export type Cell = number | "FREE";
export type Card = Cell[][]; // card[row][col]

export function numberLetter(n: number): string {
  for (const letter of COLUMN_LETTERS) {
    const [low, high] = LETTER_RANGES[letter];
    if (n >= low && n <= high) return letter;
  }
  return "?";
}

export class CardGenerator {
  static generate(): Card {
    const card: Card[] = [[], [], [], [], []] as any;
    COLUMN_LETTERS.forEach((letter, col) => {
      const [low, high] = LETTER_RANGES[letter];
      const pool: number[] = [];
      for (let n = low; n <= high; n++) pool.push(n);
      // Fisher-Yates shuffle
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      for (let row = 0; row < 5; row++) card[row][col] = pool[row];
    });
    card[2][2] = "FREE";
    return card as Card;
  }
}
