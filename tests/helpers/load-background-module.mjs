import { readFile } from "node:fs/promises";
import vm from "node:vm";

export async function loadBackgroundModule(filePath, overrides = {}) {
  const source = await readFile(filePath, "utf8");
  const context = {
    self: {},
    console,
    setTimeout,
    clearTimeout,
    Date,
    chrome: {},
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: filePath });
  return context.self;
}
