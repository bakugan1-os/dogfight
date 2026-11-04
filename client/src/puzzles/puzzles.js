// Lab 3, M4: five task/microtask ordering puzzles. Each one takes a `log` function, schedules
// its work, and resolves when everything it scheduled has run. `expected` is the answer;
// test/lab03.test.js checks the answers in Node, puzzles.html shows them in the browser.
// Rule of thumb: sync code -> ALL microtasks (promise reactions, code after await) -> one task
// (setTimeout) -> microtasks again -> ... ; requestAnimationFrame runs before the next paint.

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

export const PUZZLES = [
  {
    id: 1,
    title: "await пропускає вперед синхронний код",
    code: `log("A");
(async () => { log("B"); await null; log("C"); })();
Promise.resolve().then(() => log("D"));
log("E");`,
    run(log) {
      log("A");
      (async () => {
        log("B");
        await null;
        log("C");
      })();
      Promise.resolve().then(() => log("D"));
      log("E");
      return settle();
    },
    expected: ["A", "B", "E", "C", "D"],
    why: "Тіло async-функції до першого await виконується синхронно (B). Продовження після await стає в чергу мікрозадач РАНІШЕ, ніж .then(D), бо стало туди першим.",
  },
  {
    id: 2,
    title: "setTimeout усередині .then",
    code: `setTimeout(() => log("T1"), 0);
Promise.resolve().then(() => {
  log("P1");
  setTimeout(() => log("T2"), 0);
  Promise.resolve().then(() => log("P2"));
});
log("S");`,
    run(log) {
      setTimeout(() => log("T1"), 0);
      Promise.resolve().then(() => {
        log("P1");
        setTimeout(() => log("T2"), 0);
        Promise.resolve().then(() => log("P2"));
      });
      log("S");
      return settle();
    },
    expected: ["S", "P1", "P2", "T1", "T2"],
    why: "Мікрозадача, створена в мікрозадачі (P2), виконується в тій самій «зливі» черги — до будь-якого таймера. T2 поставлено в чергу задач ПІСЛЯ T1.",
  },
  {
    id: 3,
    title: "requestAnimationFrame: мікрозадачі між колбеками кадру",
    browserOnly: true,
    code: `requestAnimationFrame(() => {
  log("raf1");
  setTimeout(() => log("timeout з raf1"), 0);
  Promise.resolve().then(() => log("micro з raf1"));
});
requestAnimationFrame(() => log("raf2"));
Promise.resolve().then(() => log("micro"));
log("sync");`,
    run(log) {
      return new Promise((resolve) => {
        requestAnimationFrame(() => {
          log("raf1");
          setTimeout(() => {
            log("timeout з raf1");
            resolve();
          }, 0);
          Promise.resolve().then(() => log("micro з raf1"));
        });
        requestAnimationFrame(() => log("raf2"));
        Promise.resolve().then(() => log("micro"));
        log("sync");
      });
    },
    expected: ["sync", "micro", "raf1", "micro з raf1", "raf2", "timeout з raf1"],
    why: "Обидва rAF-колбеки виконуються в ОДНОМУ кадрі, перед малюванням; після кожного колбека браузер вичищає мікрозадачі (тому «micro з raf1» встигає до raf2). Таймер, поставлений у rAF, — це нова задача вже ПІСЛЯ кадру. А от порядок rAF відносно setTimeout(0) з верхнього рівня не гарантований: у моєму Chromium rAF спрацював раніше.",
  },
  {
    id: 4,
    title: "забутий return і поширення помилки",
    code: `Promise.resolve(1)
  .then((v) => { v + 1; })          // немає return
  .then((v) => log(\`a:\${v}\`))
  .then(() => { throw new Error("x"); })
  .then(() => log("пропущено"))
  .catch((e) => log(\`catch:\${e.message}\`))
  .finally(() => log("finally"));
Promise.resolve(1).then((v) => v + 1).then((v) => log(\`b:\${v}\`));`,
    run(log) {
      Promise.resolve(1)
        .then((v) => {
          v + 1;
        })
        .then((v) => log(`a:${v}`))
        .then(() => {
          throw new Error("x");
        })
        .then(() => log("пропущено"))
        .catch((e) => log(`catch:${e.message}`))
        .finally(() => log("finally"));
      Promise.resolve(1)
        .then((v) => v + 1)
        .then((v) => log(`b:${v}`));
      return settle();
    },
    expected: ["a:undefined", "b:2", "catch:x", "finally"],
    why: "Без return .then передає далі undefined. Два ланцюжки йдуть по кроку за раз, тому a і b чергуються. throw стає rejection і «перестрибує» .then аж до .catch.",
  },
  {
    id: 5,
    title: "async повертає проміс — це коштує зайвих тіків",
    code: `async function f() { return Promise.resolve("f"); }
f().then(log);
Promise.resolve()
  .then(() => log("1"))
  .then(() => log("2"))
  .then(() => log("3"));`,
    run(log) {
      async function f() {
        return Promise.resolve("f");
      }
      f().then(log);
      Promise.resolve()
        .then(() => log("1"))
        .then(() => log("2"))
        .then(() => log("3"));
      return settle();
    },
    expected: ["1", "2", "f", "3"],
    why: 'Якщо async-функція повертає ПРОМІС, рушій «розгортає» його ще двома мікрозадачами (then-job + resolve). Тому f обганяють два кроки сусіднього ланцюжка. return "f" без Promise.resolve дав би f, 1, 2, 3: проміс f() виконаний одразу, і його .then стає в чергу першим.',
  },
];

export async function runPuzzle(puzzle) {
  const out = [];
  await puzzle.run((x) => out.push(String(x)));
  return out;
}
