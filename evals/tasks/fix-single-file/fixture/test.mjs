import assert from "node:assert/strict";
import { add } from "./src/calc.mjs";

assert.equal(add(2, 3), 5);
console.log("ok");
