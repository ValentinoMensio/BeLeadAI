import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadBackgroundModule } from "./helpers/load-background-module.mjs";

const root = resolve(process.cwd());
const modulePath = resolve(root, "src/platform/content/modules/input-actions.js");

class BasicEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
}

function createInputElement(tagName = "INPUT") {
  return {
    tagName,
    value: "",
    events: [],
    focusCalled: 0,
    focus() {
      this.focusCalled += 1;
    },
    dispatchEvent(event) {
      this.events.push(event.type);
      return true;
    },
    getAttribute() {
      return null;
    },
    closest() {
      return null;
    },
  };
}

test("input actions writeSearchQuery normalizes and writes search value", async () => {
  const mod = await loadBackgroundModule(modulePath, {
    InputEvent: BasicEvent,
    Event: BasicEvent,
    KeyboardEvent: BasicEvent,
    window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    document: { createRange: () => ({ selectNodeContents() {}, collapse() {} }) },
  });
  const inputActions = mod.createContentInputActionsModule({
    selectorsModule: {
      HUMAN_CONFIG: { typingBaseMs: 10, typingJitterMs: 0, thinkingPauseMin: 10, thinkingPauseMax: 10 },
      randomBetween: () => 0,
      sleep: async () => {},
      humanDelay: async () => {},
      waitForCondition: async (fn) => fn(),
    },
  });
  const input = createInputElement();

  const ok = await inputActions.writeSearchQuery(input, "@Alice.Test");

  assert.equal(ok, true);
  assert.equal(input.value, "alice.test");
  assert.ok(input.events.includes("input"));
});

test("input actions typeHumanLike writes into textarea", async () => {
  const mod = await loadBackgroundModule(modulePath, {
    InputEvent: BasicEvent,
    Event: BasicEvent,
    KeyboardEvent: BasicEvent,
    window: { getSelection: () => ({ removeAllRanges() {}, addRange() {} }) },
    document: { createRange: () => ({ selectNodeContents() {}, collapse() {} }) },
  });
  const inputActions = mod.createContentInputActionsModule({
    selectorsModule: {
      HUMAN_CONFIG: { typingBaseMs: 10, typingJitterMs: 0, thinkingPauseMin: 10, thinkingPauseMax: 10 },
      randomBetween: () => 0,
      sleep: async () => {},
      humanDelay: async () => {},
      waitForCondition: async () => true,
    },
  });
  const textarea = createInputElement("TEXTAREA");

  await inputActions.typeHumanLike(textarea, "Hola");

  assert.equal(textarea.value, "Hola");
  assert.ok(textarea.events.includes("keydown"));
});
