import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";

const controllerPath = resolve(
  process.cwd(),
  "src/features/popup/controllers/send-recipients-controller.js"
);

async function loadSendRecipientsController({
  documentMock,
  setTimeoutImpl,
  clearTimeoutImpl,
} = {}) {
  const source = await readFile(controllerPath, "utf8");
  const transformed = source.replace(
    "export function createSendRecipientsController",
    "function createSendRecipientsController"
  );
  const context = {
    console,
    setTimeout: setTimeoutImpl || ((...args) => global.setTimeout(...args)),
    clearTimeout: clearTimeoutImpl || ((...args) => global.clearTimeout(...args)),
    document: documentMock,
  };
  vm.createContext(context);
  vm.runInContext(
    `${transformed}\nthis.createSendRecipientsController = createSendRecipientsController;`,
    context,
    {
      filename: controllerPath,
    }
  );
  return context.createSendRecipientsController;
}

function createStore() {
  const state = {
    selectedSendJobId: null,
    selectedSendKind: null,
    visibleRecipientUsernames: [],
    selectedRecipientUsernames: [],
    recipientQuery: "",
    recipientNextCursor: null,
    recipientHasMore: false,
    recipientTotalCount: 0,
    recipientMatchedCount: 0,
  };
  return {
    state,
    getState: () => state,
    clearSendRecipientContext() {
      state.selectedSendJobId = null;
      state.selectedSendKind = null;
      state.visibleRecipientUsernames = [];
      state.selectedRecipientUsernames = [];
      state.recipientQuery = "";
      state.recipientNextCursor = null;
      state.recipientHasMore = false;
      state.recipientTotalCount = 0;
      state.recipientMatchedCount = 0;
    },
    setSendRecipientContext({
      jobId = null,
      kind = null,
      visibleUsernames = [],
      selectedUsernames = [],
      query = "",
      nextCursor = null,
      hasMore = false,
      totalCount = 0,
      matchedCount = 0,
    }) {
      state.selectedSendJobId = jobId;
      state.selectedSendKind = kind;
      state.visibleRecipientUsernames = [...visibleUsernames];
      state.selectedRecipientUsernames = [...selectedUsernames];
      state.recipientQuery = query;
      state.recipientNextCursor = nextCursor;
      state.recipientHasMore = hasMore;
      state.recipientTotalCount = totalCount;
      state.recipientMatchedCount = matchedCount;
    },
    getSelectedRecipientUsernames() {
      return [...state.selectedRecipientUsernames];
    },
    clearSelectedRecipients() {
      state.selectedRecipientUsernames = [];
    },
    toggleSelectedRecipient(username) {
      if (state.selectedRecipientUsernames.includes(username)) {
        state.selectedRecipientUsernames = state.selectedRecipientUsernames.filter(
          (item) => item !== username
        );
      } else {
        state.selectedRecipientUsernames = [...state.selectedRecipientUsernames, username];
      }
    },
    selectAllRecipients() {
      state.selectedRecipientUsernames = [...state.visibleRecipientUsernames];
    },
  };
}

function createDom() {
  const recipientsInfo = { style: { display: "none" } };
  const recipientsList = {
    style: { display: "none" },
    replaceChildren() {},
    classList: { toggle() {} },
  };
  const recipientsToggle = { setAttribute() {}, classList: { toggle() {} } };
  const recipientsSummary = { textContent: "" };
  const recipientsActions = { style: { display: "none" } };
  const elements = {
    "#send_recipients_info": recipientsInfo,
    "#send_recipients_list": recipientsList,
    "#recipients_toggle": recipientsToggle,
    "#send_recipients_summary": recipientsSummary,
  };
  const documentMock = {
    getElementById(id) {
      if (id === "recipients_actions") return recipientsActions;
      return null;
    },
  };
  global.document = documentMock;
  globalThis.document = documentMock;
  return {
    documentMock,
    qs(selector) {
      return elements[selector] || null;
    },
    recipientsInfo,
    recipientsList,
    recipientsToggle,
    recipientsSummary,
    recipientsActions,
  };
}

test("send recipients controller loads first page and auto-selects visible usernames", async () => {
  const store = createStore();
  const dom = createDom();
  const createSendRecipientsController = await loadSendRecipientsController({
    documentMock: dom.documentMock,
  });
  const renderCalls = [];
  const controller = createSendRecipientsController({
    store,
    services: {
      loadSettings: async () => ({ api_base: "https://api.example.com" }),
      loadRecipientSourceRecipientsPage: async () => ({
        ok: true,
        data: {
          usernames: ["alice", "bob"],
          nextCursor: "bob",
          hasMore: true,
          total: 10,
          matchedCount: 10,
          query: "",
        },
      }),
    },
    ui: {
      setSendStatus() {},
      renderRecipients(...args) {
        renderCalls.push(args);
      },
    },
    dom,
    helpers: {
      normalizeJobId: (id) => id,
      setRecipientsExpanded() {},
      updateRecipientsSelectionUI() {},
      setSendInfoStatus() {},
      syncRecipientChipsFromState() {},
    },
  });

  await controller.onSendRecipientsJobChange("flow:job1", "followings_flow");

  assert.deepEqual(store.state.visibleRecipientUsernames, ["alice", "bob"]);
  assert.deepEqual(store.state.selectedRecipientUsernames, ["alice", "bob"]);
  assert.equal(store.state.recipientHasMore, true);
  assert.equal(store.state.recipientNextCursor, "bob");
  assert.equal(renderCalls.length, 1);
});

test("send recipients controller precarga todas las paginas del source", async () => {
  const store = createStore();
  const dom = createDom();
  const createSendRecipientsController = await loadSendRecipientsController({
    documentMock: dom.documentMock,
  });
  let calls = 0;
  const controller = createSendRecipientsController({
    store,
    services: {
      loadSettings: async () => ({ api_base: "https://api.example.com" }),
      loadRecipientSourceRecipientsPage: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: true,
            data: {
              usernames: ["alice", "bob"],
              nextCursor: "bob",
              hasMore: true,
              total: 4,
              matchedCount: 4,
              query: "",
            },
          };
        }
        return {
          ok: true,
          data: {
            usernames: ["carol", "dave"],
            nextCursor: null,
            hasMore: false,
            total: 4,
            matchedCount: 4,
            query: "",
          },
        };
      },
    },
    ui: { setSendStatus() {}, renderRecipients() {} },
    dom,
    helpers: {
      normalizeJobId: (id) => id,
      setRecipientsExpanded() {},
      updateRecipientsSelectionUI() {},
      setSendInfoStatus() {},
      syncRecipientChipsFromState() {},
    },
  });

  await controller.onSendRecipientsJobChange("flow:job1", "followings_flow");

  assert.deepEqual(store.state.visibleRecipientUsernames, ["alice", "bob", "carol", "dave"]);
  assert.deepEqual(
    store.state.selectedRecipientUsernames.sort(),
    ["alice", "bob", "carol", "dave"].sort()
  );
  assert.equal(store.state.recipientHasMore, false);
  assert.equal(calls, 2);
});
