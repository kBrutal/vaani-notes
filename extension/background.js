const DEFAULT_API = 'http://localhost:8000';
// The toolbar icon opens the panel from code, so the click counts as invoking Vaani on this tab (activeTab):
// Chrome only lets an extension capture a tab's audio after that.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
chrome.action.onClicked.addListener((tab) => chrome.sidePanel.open({ windowId: tab.windowId }));

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // Side panels can't show the mic permission prompt, so grant it once from a normal tab.
  if (reason === 'install') chrome.tabs.create({ url: 'permission.html' });
  chrome.contextMenus.removeAll(() =>  // onInstalled also fires on every reload/update; avoid duplicate-id errors
    chrome.contextMenus.create({ id: 'save-selection', title: 'Save to Vaani as a note', contexts: ['selection'] }));
});

// Alt+Shift+R: start/stop a voice note. sidePanel.open() must run before any await (user-gesture window).
// An open panel gets the message; a panel that is just opening reads the autostart flag instead.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'toggle-recording') return;
  chrome.sidePanel.open({ windowId: tab.windowId });
  chrome.storage.session.set({ autostart: Date.now() });
  chrome.runtime.sendMessage({ type: 'toggle-recording' }).catch(() => {});
});

// Alt+Shift+L: capture the lecture playing in this tab. The shortcut itself invokes Vaani on the tab, so the
// stream id can be minted here; the panel (opened now, before any await) picks it up and starts capturing.
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'capture-lecture') return;
  chrome.sidePanel.open({ windowId: tab.windowId });
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const lecture = { streamId, tabId: tab.id, url: tab.url, title: tab.title, at: Date.now() };
    await chrome.storage.session.set({ lecture });
    chrome.runtime.sendMessage({ type: 'capture-lecture', lecture }).catch(() => {});
  } catch (e) {
    chrome.storage.session.set({ notice: `Can't capture this tab: ${e.message}` });
  }
});

// Right-click selected text -> note in the current chapter, processed by the server like a typed note.
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'save-selection') return;
  const badge = (text, color) => {
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setBadgeText({ text, tabId: tab.id });
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId: tab.id }), 4000);
  };
  const { api = DEFAULT_API, chapter } = await chrome.storage.local.get(['api', 'chapter']);
  if (!chapter) {
    badge('!', '#d4343a');
    return chrome.storage.session.set({ notice: 'Pick a chapter first, then save the selection again.' });
  }
  const text = info.selectionText.slice(0, 4000);
  try {
    const res = await fetch(`${api}/api/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, mode: 'note', ctx: { chapter_id: chapter, source: { type: 'web', url: tab.url, title: tab.title, selection: text } } }),
    });
    if (!res.ok) throw new Error();
    badge('✓', '#26915a');
    chrome.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
  } catch {
    badge('!', '#d4343a');
    chrome.storage.session.set({ notice: "Couldn't save the selection. Is the Vaani server running?" });
  }
});
