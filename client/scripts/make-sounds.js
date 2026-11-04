// Generates the game's sound effects as 16-bit mono WAV files — synthesised, so the repo
// has no third-party audio with unclear licences. Run once: `node scripts/make-sounds.js`.
// Output: public/assets/sfx/*.wav (committed).

import { mkdirSync, writeFileSync } from "node:fs";

const RATE = 22050;
const OUT = new URL("../public/assets/sfx/", import.meta.url);

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) =>
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2),
  );
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

let seed = 7;
const noise = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 31 - 1;

function render(seconds, fn) {
  const n = Math.round(seconds * RATE);
  return Array.from({ length: n }, (_, i) => fn(i / RATE, i / n));
}

const sounds = {
  // short falling square "pew"
  shoot: render(0.12, (t, p) => {
    const f = 900 - 600 * p;
    return (Math.sin(2 * Math.PI * f * t) > 0 ? 0.35 : -0.35) * (1 - p) ** 2;
  }),
  // dull knock: low sine + a bit of noise
  hit: render(
    0.14,
    (t, p) => (0.6 * Math.sin(2 * Math.PI * 140 * t) + 0.25 * noise()) * (1 - p) ** 3,
  ),
  // low-passed noise burst with a long tail
  explosion: (() => {
    let y = 0;
    return render(0.9, (t, p) => {
      y += (noise() - y) * (0.25 - 0.2 * p);
      return 1.6 * y * (1 - p) ** 2;
    });
  })(),
  // rising arpeggio for pickups
  pickup: render(0.3, (t, p) => {
    const f = [660, 880, 1320][Math.min(2, Math.floor(p * 3))];
    return 0.3 * Math.sin(2 * Math.PI * f * t) * (1 - p);
  }),
};

mkdirSync(OUT, { recursive: true });
for (const [name, samples] of Object.entries(sounds)) {
  const file = new URL(`${name}.wav`, OUT);
  writeFileSync(file, wav(samples));
  console.log(`${name}.wav  ${(samples.length / RATE).toFixed(2)} s`);
}
