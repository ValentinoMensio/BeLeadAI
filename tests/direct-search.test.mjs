import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadBackgroundModule } from "./helpers/load-background-module.mjs";

const root = resolve(process.cwd());
const modulePath = resolve(root, "src/platform/content/modules/direct-search.js");

class BasicEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
}

function createRow({
  username = "",
  hrefUsername = null,
  visibleText = null,
  spans = null,
  parentClickable = false,
} = {}) {
  const anchor = {
    getAttribute(name) {
      if (name === "href") return hrefUsername ? `/${hrefUsername}/` : "";
      return "";
    },
  };
  const spanNodes = (spans || (username ? [username] : [])).map((text) => ({ textContent: text }));
  const row = {
    innerText: visibleText ?? (username ? `@${username}` : ""),
    textContent: visibleText ?? (username ? `@${username}` : ""),
    clicked: 0,
    parentElement: parentClickable
      ? {
          clicked: 0,
          getAttribute(attr) {
            return attr === "role" ? "button" : null;
          },
          click() {
            this.clicked += 1;
          },
          onclick() {},
        }
      : null,
    querySelectorAll(selector) {
      if (selector === 'span[dir="auto"]') return spanNodes;
      if (selector === "a[href]") return hrefUsername ? [anchor] : [];
      return [];
    },
    click() {
      this.clicked += 1;
    },
    getAttribute() {
      return null;
    },
  };
  return row;
}

function createHarness({
  rows = [],
  searchInputValue = "",
  threadOpenSequence = [true],
  writeSearchBehavior,
} = {}) {
  let nowMs = 0;
  const searchInput = {
    value: searchInputValue,
    textContent: searchInputValue,
    dispatched: [],
    focus() {},
    dispatchEvent(event) {
      this.dispatched.push(event.type);
      return true;
    },
    getAttribute() {
      return "Buscar";
    },
    placeholder: "Buscar",
  };
  const scope = {
    querySelectorAll(selector) {
      if (selector === 'div[role="button"][tabindex]') return rows;
      if (selector === 'div[role="button"]') return rows;
      return [];
    },
    parentElement: null,
  };
  const heading = {
    textContent: "More accounts",
    closest() {
      return scope;
    },
  };
  const documentMock = {
    body: scope,
    querySelectorAll(selector) {
      if (selector === "h2") return [heading];
      return [];
    },
  };
  let threadOpenCalls = 0;

  return {
    searchInput,
    rows,
    threadOpenCalls: () => threadOpenCalls,
    load: async () => {
      const FakeDate = class extends Date {
        static now() {
          return nowMs;
        }
      };
      const mod = await loadBackgroundModule(modulePath, {
        document: documentMock,
        URL,
        KeyboardEvent: BasicEvent,
        Date: FakeDate,
      });
      return mod.createContentDirectSearchModule({
        selectorsModule: {
          HUMAN_CONFIG: { selectors: { directSearchInput: ["input"] } },
          isElementVisible: () => true,
          humanDelay: async () => {
            nowMs += 5000;
          },
          waitForCondition: async (fn) => fn(),
          waitForElement: async () => searchInput,
          sleep: async () => {
            nowMs += 5000;
          },
        },
        observersModule: {
          waitForThreadOpened: async () => {
            const current = threadOpenSequence[Math.min(threadOpenCalls, threadOpenSequence.length - 1)];
            threadOpenCalls += 1;
            return current;
          },
        },
        inputActionsModule: {
          writeSearchQuery: async (input, username) => {
            if (typeof writeSearchBehavior === "function") {
              return writeSearchBehavior(input, username);
            }
            const normalized = String(username).replace(/^@+/, "").toLowerCase();
            input.value = normalized;
            input.textContent = normalized;
            return true;
          },
          normalizeSearchValue: (value) =>
            String(value || "")
              .trim()
              .replace(/^@+/, "")
              .toLowerCase(),
        },
        maskUsername: (value) => value,
      });
    },
  };
}

test("direct search finds strong row match and opens thread", async () => {
  const row = createRow({ username: "alice.demo", hrefUsername: "alice.demo" });
  const harness = createHarness({ rows: [row] });
  const directSearch = await harness.load();

  const result = await directSearch.directSearchAndOpenThread("alice.demo");

  assert.equal(result.ok, true);
  assert.equal(result.candidateUsername, "alice.demo");
  assert.equal(result.candidateConfidence, "strong");
  assert.equal(row.clicked, 1);
});

test("direct search accepts strong href match without visible exact text", async () => {
  const row = createRow({
    username: "other.user",
    hrefUsername: "alice.demo",
    visibleText: "Cuenta sugerida",
    spans: ["other.user"],
  });
  const harness = createHarness({ rows: [row] });
  const directSearch = await harness.load();

  const result = await directSearch.directSearchAndOpenThread("alice.demo");

  assert.equal(result.ok, true);
  assert.equal(result.candidateUsername, "alice.demo");
  assert.equal(result.candidateConfidence, "strong");
});

test("direct search rejects single visible row without identity signal and falls back to failure", async () => {
  const row = createRow({
    username: "candidate.user",
    hrefUsername: "candidate.user",
    visibleText: "Cuenta sugerida genérica",
    spans: ["candidate.user"],
  });
  const harness = createHarness({ rows: [row], threadOpenSequence: [false, false, false, false] });
  const directSearch = await harness.load();

  const result = await directSearch.directSearchAndOpenThread("alice.demo");

  assert.equal(result.ok, false);
  assert.equal(row.clicked, 0);
});

test("direct search uses keyboard fallback when no visible rows open the thread", async () => {
  const harness = createHarness({ rows: [], threadOpenSequence: [false, true] });
  const directSearch = await harness.load();

  const result = await directSearch.directSearchAndOpenThread("alice.demo");

  assert.equal(result.ok, true);
  assert.equal(result.candidateUsername, "alice.demo");
  assert.equal(result.candidateConfidence, "soft");
  assert.ok(harness.searchInput.dispatched.includes("keydown"));
});

test("direct search normalizes search input before matching", async () => {
  const row = createRow({ username: "alice.demo", hrefUsername: "alice.demo" });
  let writeCalls = 0;
  const harness = createHarness({
    rows: [row],
    searchInputValue: "wrong.value",
    writeSearchBehavior: async (input, username) => {
      writeCalls += 1;
      const normalized = String(username).replace(/^@+/, "").toLowerCase();
      input.value = normalized;
      input.textContent = normalized;
      return true;
    },
  });
  const directSearch = await harness.load();

  const result = await directSearch.directSearchAndOpenThread("alice.demo");

  assert.equal(result.ok, true);
  assert.equal(writeCalls, 1);
  assert.equal(harness.searchInput.value, "alice.demo");
});
