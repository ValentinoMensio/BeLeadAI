import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadBackgroundModule } from "./helpers/load-background-module.mjs";

const root = resolve(process.cwd());
const modulePath = resolve(root, "src/platform/content/modules/message-actions.js");

test("message actions waitForSendConfirmation detects composer cleared", async () => {
  const mod = await loadBackgroundModule(modulePath, {
    document: { querySelectorAll: () => [] },
  });
  const messageActions = mod.createContentMessageActionsModule({
    selectorsModule: {
      HUMAN_CONFIG: {
        selectors: {},
        profileViewMin: 10,
        profileViewMax: 10,
        afterSendMin: 10,
        afterSendMax: 10,
      },
      sleep: async () => {},
      humanDelay: async () => {},
      waitForCondition: async () => true,
      waitForElement: async () => null,
      waitForSendButton: async () => null,
    },
    typeHumanLike: async () => {},
  });

  const result = await messageActions.waitForSendConfirmation({ value: "" }, null, "Hola");

  assert.equal(result.ok, true);
  assert.equal(result.signal, "composer_cleared");
});

test("message actions typeAndSendMessage types and clicks send button", async () => {
  let clicked = 0;
  const textarea = { tagName: "TEXTAREA" };
  const sendBtn = {
    click() {
      clicked += 1;
    },
  };
  const typed = [];
  const mod = await loadBackgroundModule(modulePath, { document: { querySelectorAll: () => [] } });
  const messageActions = mod.createContentMessageActionsModule({
    selectorsModule: {
      HUMAN_CONFIG: {
        selectors: { messageTextarea: ["textarea"] },
        profileViewMin: 10,
        profileViewMax: 10,
        afterSendMin: 10,
        afterSendMax: 10,
      },
      sleep: async () => {},
      humanDelay: async () => {},
      waitForCondition: async () => true,
      waitForElement: async () => textarea,
      waitForSendButton: async () => sendBtn,
    },
    typeHumanLike: async (_, message) => typed.push(message),
  });

  const ok = await messageActions.typeAndSendMessage("Hola mundo");

  assert.equal(ok, true);
  assert.deepEqual(typed, ["Hola mundo"]);
  assert.equal(clicked, 1);
});
