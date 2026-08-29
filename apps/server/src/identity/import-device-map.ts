import { readFile } from "node:fs/promises";
import { ImportedDeviceMapAdapter } from "./iclass-adapter";

export async function importDeviceMapFile(path: string, adapter: ImportedDeviceMapAdapter): Promise<number> {
  const bytes = await readFile(path);
  return adapter.replaceFromCsv(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
