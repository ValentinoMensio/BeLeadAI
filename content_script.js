// Legacy wrapper kept for compatibility with previous paths.
import(chrome.runtime.getURL("src/platform/content/content-script.js")).catch((error) => {
  console.error("[BeLeadAI] content wrapper load error", error);
});
