// Verify that isReady works against the actual captured buffer
import { isReady } from "../src/driver";
import { readFileSync } from "fs";

// Read the JSON dump from char-inspect2
const buf = JSON.parse(readFileSync("spike/char-dump.json", "utf-8")) as string;
console.log(`Buffer length: ${buf.length}`);

// Check isReady
const result = isReady(buf);
console.log(`isReady(realBuffer) = ${result}`);

// Find the ❯ char
const idx = buf.indexOf("❯");
console.log(`❯ at idx: ${idx}`);
if (idx >= 0) {
  const nextCode = buf.charCodeAt(idx + 1);
  console.log(`Char after ❯: 0x${nextCode.toString(16)} (${nextCode})`);
  console.log(`Is U+00A0? ${nextCode === 0xa0}`);
  console.log(`Is U+0020? ${nextCode === 0x20}`);
}

// Also verify what the source file's string looks like
const testStr = "❯ ";
console.log(`\nTest "❯\\u00a0" codes: 0x${testStr.charCodeAt(0).toString(16)}, 0x${testStr.charCodeAt(1).toString(16)}`);
console.log(`isReady with explicit "❯\\u00a0": ${buf.includes("❯ ")}`);
