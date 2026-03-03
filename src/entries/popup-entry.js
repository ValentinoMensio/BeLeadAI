/**
 * Entrypoint del popup: carga config, init store, init controller, WS y refresh inicial.
 * api-errors.js debe estar cargado antes (script en popup.html).
 */

import { init } from "../features/popup/popup-controller.js";

document.addEventListener("DOMContentLoaded", () => {
  init();
});
