// src/format/json.ts
import type { ResultObject } from "../types";

export function formatJson(result: ResultObject): string {
  return JSON.stringify(result);
}
