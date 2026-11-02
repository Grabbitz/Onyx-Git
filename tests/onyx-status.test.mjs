// node tests/onyx-status.test.mjs — checks the git status parser behind the bottom-left strip.
import fs from "fs";
import assert from "assert";
const src = fs.readFileSync(new URL("../mods/onyx-status/main.js", import.meta.url), "utf8");
const a = src.indexOf("export function parseStatus"), b = src.indexOf("\n}\n", a) + 2;
const parseStatus = new Function(src.slice(a, b).replace("export ", "") + "return parseStatus;")();

assert.deepStrictEqual(parseStatus("# branch.oid abc\n# branch.head main\n# branch.ab +2 -1\n1 .M N... 1 1 1 a b f.js\n? new.txt\n"),
  { branch: "main", ahead: 2, behind: 1, changed: 2 });
assert.deepStrictEqual(parseStatus("# branch.head (detached)\n"), { branch: "(detached)", ahead: 0, behind: 0, changed: 0 });
console.log("onyx-status: all checks passed");
