export function createOptionsViewModel(setters) {
  const { setConfigStatus, setSaveStatus } = setters;

  const state = {
    configStatus: { kind: "warn", text: "—" },
    saveStatus: { message: "—", isError: false },
  };

  function updateConfigStatus(kind, text) {
    state.configStatus = { kind, text };
    setConfigStatus(kind, text);
  }

  function updateSaveStatus(message, isError = false) {
    state.saveStatus = { message, isError };
    setSaveStatus(message, isError);
  }

  return {
    getState() {
      return state;
    },
    updateConfigStatus,
    updateSaveStatus,
  };
}
