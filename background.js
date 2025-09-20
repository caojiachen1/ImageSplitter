// Edge 扩展后台脚本，注册右键菜单并派发分割指令

function createContextMenus() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'split-image',
        title: '分割拼接图片',
        contexts: ['image']
      }, () => void chrome.runtime.lastError);
    });
  } catch (e) {
    // 忽略异常（如 service worker 短暂挂起）
  }
}

chrome.runtime.onInstalled.addListener(createContextMenus);
chrome.runtime.onStartup?.addListener?.(createContextMenus);

function sendSplitCommand(tabId, frameId, srcUrl) {
  chrome.tabs.sendMessage(tabId, { action: 'split-image', srcUrl }, { frameId }, () => {
    if (chrome.runtime.lastError) {
      // 内容脚本可能未注入到该 frame，尝试注入后重试
      chrome.scripting.executeScript({
        target: { tabId, frameIds: frameId != null ? [frameId] : undefined },
        files: ['content.js']
      }, () => {
        // 注入完成后再次发送
        chrome.tabs.sendMessage(tabId, { action: 'split-image', srcUrl }, { frameId }, () => void chrome.runtime.lastError);
      });
    }
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;
  if (info.menuItemId === 'split-image' && info.srcUrl) {
    const frameId = typeof info.frameId === 'number' ? info.frameId : undefined;
    sendSplitCommand(tab.id, frameId, info.srcUrl);
  }
});

// 处理内容脚本的跨域图片抓取请求，避免 canvas 污染
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'fetch-image' && msg.url) {
    (async () => {
      try {
        const res = await fetch(msg.url, { credentials: 'omit', cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const contentType = res.headers.get('content-type') || 'image/png';
        const buf = await res.arrayBuffer();
        sendResponse({ ok: true, buffer: buf, contentType });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true; // 异步响应
  }
});
