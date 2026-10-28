let winId: number | undefined;
chrome.action.onClicked.addListener(async () => {
  if (winId !== undefined) {
    try { await chrome.windows.update(winId, { focused: true }); return; } catch { winId = undefined; }
  }
  const w = await chrome.windows.create({ url: chrome.runtime.getURL("app.html"), type: "popup", width: 480, height: 640 });
  winId = w?.id;
});
chrome.windows.onRemoved.addListener((id) => { if (id === winId) winId = undefined; });
export {};
