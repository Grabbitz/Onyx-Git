// node tests/onyx-quota.test.mjs — checks quota-axi parsing without Herdr or a network.
import fs from "fs";
import assert from "assert";
const src = fs.readFileSync(new URL("../mods/onyx-quota/main.js", import.meta.url), "utf8");
const grab = (n) => { const a = src.indexOf("export function " + n); return src.slice(a, src.indexOf("\n}\n", a) + 2).replace("export ", ""); };
const { shortName, parse } = new Function(grab("shortName") + grab("parse") + "return { shortName, parse };")();

assert.equal(shortName("five_hour", "session"), "5h");
assert.equal(shortName("seven_day", "week"), "7d");
assert.equal(shortName("gemini_weekly", "Gemini weekly"), "Gem wk");
assert.equal(shortName("claude_gpt_5h", "Claude/GPT 5-hour"), "C/G 5h");

const d = parse(fs.readFileSync(new URL("./quota-fixture.json", import.meta.url), "utf8"));
assert.deepEqual(d.claude.windows.map(w => [w.short, w.used]), [["5h", 42], ["7d", 7]]);
assert.equal(d.claude.error, null);
assert.deepEqual(d.grok.windows.map(w => w.name), ["week"], "product pools are dropped");
assert.equal(d.cursor.keychain, true);
assert.equal(d.cursor.windows.length, 0);
assert.equal(d.kimi.missing, true);
assert.equal(d.kimi.error, "Not set up");
console.log("onyx-quota: all checks passed");
