// src/format/json.ts
import type { ResultObject } from "../domain/types";

export function formatJson(result: ResultObject): string {
  return JSON.stringify(result);
}
