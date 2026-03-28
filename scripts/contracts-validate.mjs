import { readdir, readFile, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const ROOT = process.cwd();
const CONTRACTS_DIR = resolve(ROOT, "contracts", "v1");
const EXAMPLES_DIR = resolve(CONTRACTS_DIR, "examples");

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertHasEnvelope(payload, name) {
  if (!isObject(payload)) fail(`${name}: payload must be an object.`);
  if (name.includes("response") && !payload.data && !payload.error) {
    fail(`${name}: response example must contain data or error envelope.`);
  }
}

async function validateExamples() {
  const entries = await readdir(EXAMPLES_DIR, { withFileTypes: true });
  if (entries.length === 0) fail("contracts examples directory is empty.");

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = resolve(EXAMPLES_DIR, entry.name);
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const schemaRel = String(parsed?.schema || "").trim();
    if (!schemaRel) fail(`${entry.name}: missing schema field.`);
    const schemaPath = resolve(dirname(filePath), schemaRel);
    await access(schemaPath).catch(() => fail(`${entry.name}: referenced schema does not exist.`));
    if (!isObject(parsed.payload)) fail(`${entry.name}: payload must be an object.`);
    assertHasEnvelope(parsed.payload, entry.name);
  }
}

async function validateSchemas() {
  const entries = await readdir(CONTRACTS_DIR, { withFileTypes: true });
  const jsonFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
  if (jsonFiles.length === 0) fail("contracts/v1 does not contain published schemas.");

  for (const entry of jsonFiles) {
    const raw = await readFile(resolve(CONTRACTS_DIR, entry.name), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed.$schema || !parsed.$id) {
      fail(`${entry.name}: schema must define $schema and $id.`);
    }
  }
}

async function main() {
  await validateSchemas();
  await validateExamples();
  console.log("[contracts] OK: schemas and examples are published and linked.");
}

main().catch((error) => {
  console.error("[contracts] FAIL:", error?.message || error);
  process.exit(1);
});
