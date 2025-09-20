// 内容脚本：分割图片并在页面以 Modal 方式展示；每张图片可使用浏览器右键菜单继续操作。

const IS_SPLITTER_STYLE_ID = 'image-splitter-style';
const IS_MODAL_ID = 'image-splitter-modal';
const IS_MASK_ID = 'image-splitter-mask';

function ensureStyles() {
  if (document.getElementById(IS_SPLITTER_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = IS_SPLITTER_STYLE_ID;
  style.textContent = `
  .is-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483646;}
  .is-modal{position:fixed;inset:auto;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483647;background:#fff;border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.2);max-height:85vh;max-width:min(90vw,1200px);display:flex;flex-direction:column;overflow:hidden;border:1px solid #e5e7eb}
  .is-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #eee;background:#fafafa}
  .is-title{font-size:14px;color:#111;font-weight:600}
  .is-actions{display:flex;gap:8px}
  .is-btn{padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;font-size:12px}
  .is-btn:hover{background:#f3f4f6}
  .is-body{padding:12px;overflow:auto}
  .is-grid{display:flex;flex-direction:column;gap:12px}
  .is-item{border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;background:#fff}
  .is-item img{display:block;max-width:100%;height:auto}
  .is-footer{padding:10px 14px;border-top:1px solid #eee;background:#fafafa;color:#6b7280;font-size:12px}
  `;
  document.documentElement.appendChild(style);
}

function toErrorMessage(e, fallback = '未知错误') {
  if (!e) return fallback;
  if (e instanceof Error) return e.message || fallback;
  // DOMException
  if (typeof e.name === 'string' && typeof e.message === 'string') return e.message || e.name || fallback;
  // 事件对象
  if (typeof Event !== 'undefined' && e instanceof Event) return '资源加载失败（' + (e.type || 'error') + '）';
  try { return String(e); } catch { return fallback; }
}

async function loadImageToCanvas(srcUrl, forceFetch = false) {
  // 优先尝试直接加载（若同源且带 CORS 允许则可安全使用）
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';

  async function loadFromUrl(url) {
    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = (ev) => reject(new Error('图片加载失败'));
      img.src = url;
    });
  }

  if (!forceFetch) {
    try {
      await loadFromUrl(srcUrl);
    } catch (e) {
      forceFetch = true; // 直接加载失败，改用后台抓取
    }
  }

  if (forceFetch) {
    const res = await new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'fetch-image', url: srcUrl }, resolve);
    });
    if (!res || !res.ok) throw new Error(res?.error || '无法获取图片（跨域或网络问题）');
    const blob = new Blob([res.buffer], { type: res.contentType || 'image/png' });
    const blobUrl = URL.createObjectURL(blob);
    await loadFromUrl(blobUrl);
    URL.revokeObjectURL(blobUrl);
  }

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { canvas, ctx, width: canvas.width, height: canvas.height };
}

function detectSplits(imageData, width, height) {
  const { data } = imageData;
  
  // 计算每行与上一行的绝对差（RGB，忽略 alpha）
  const diffs = new Float64Array(height);
  for (let y = 1; y < height; y++) {
    let rowDiff = 0;
    let base1 = (y - 1) * width * 4;
    let base2 = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i1 = base1 + x * 4;
      const i2 = base2 + x * 4;
      rowDiff += Math.abs(data[i1] - data[i2]) + Math.abs(data[i1 + 1] - data[i2 + 1]) + Math.abs(data[i1 + 2] - data[i2 + 2]);
    }
    diffs[y] = rowDiff / width; // 归一为每像素平均差
  }

  // 改进的平滑处理 - 使用更大的窗口
  const smooth = new Float64Array(height);
  const W = 5; // 增加平滑窗口
  for (let y = 0; y < height; y++) {
    let s = 0, c = 0;
    for (let k = -W; k <= W; k++) {
      const yy = y + k;
      if (yy >= 0 && yy < height) { s += diffs[yy]; c++; }
    }
    smooth[y] = s / (c || 1);
  }

  // 计算统计信息
  let mean = 0; 
  for (let y = 0; y < height; y++) mean += smooth[y];
  mean /= height;
  
  let varSum = 0; 
  for (let y = 0; y < height; y++) varSum += (smooth[y] - mean) ** 2;
  const stdev = Math.sqrt(varSum / height);
  
  // 计算更高的分位数作为阈值，避免噪声干扰
  const sorted = Array.from(smooth).sort((a, b) => a - b);
  const q95 = sorted[Math.floor(0.95 * sorted.length)]; // 95%分位数
  const threshold = Math.max(mean + 2.5 * stdev, q95); // 更严格的阈值

  // 使用更严格的峰值检测
  const candidates = [];
  const minPeakWidth = 3; // 峰值最小宽度
  
  for (let y = minPeakWidth; y < height - minPeakWidth; y++) {
    if (smooth[y] > threshold) {
      // 检查是否为真正的峰值：需要比周围更大范围的点都大
      let isPeak = true;
      for (let k = 1; k <= minPeakWidth; k++) {
        if (smooth[y] < smooth[y - k] || smooth[y] < smooth[y + k]) {
          isPeak = false;
          break;
        }
      }
      
      if (isPeak) {
        // 验证这是否为分割线，并获取精确位置
        const preciseY = findPreciseSplitLine(imageData, width, height, y);
        if (preciseY !== null) {
          candidates.push(preciseY);
        }
      }
    }
  }

  // 合并相近的候选，最小间隔增加到 20px
  const merged = [];
  let group = [];
  const MIN_GAP = 20;
  
  // 先对候选位置排序
  candidates.sort((a, b) => a - b);
  
  for (const y of candidates) {
    if (!group.length || y - group[group.length - 1] <= MIN_GAP) {
      group.push(y);
    } else {
      // 选择组内最中心的位置（最能代表真实分割线的位置）
      const centerY = Math.round(group.reduce((sum, yy) => sum + yy, 0) / group.length);
      merged.push(centerY);
      group = [y];
    }
  }
  if (group.length) {
    const centerY = Math.round(group.reduce((sum, yy) => sum + yy, 0) / group.length);
    merged.push(centerY);
  }

  // 去除靠近边缘或间隔过小的分割线
  const MIN_SLICE = 50; // 增加每段最小高度
  const lines = [];
  let prev = 0;
  
  for (const y of [...merged, height]) {
    if (y - prev >= MIN_SLICE) {
      lines.push(y);
      prev = y;
    }
  }
  
  // 去掉末尾 height
  if (lines.length && lines[lines.length - 1] === height) lines.pop();
  return lines;
}

// 验证是否为有效的分割线，并返回精确的分割位置
function findPreciseSplitLine(imageData, width, height, roughY) {
  const { data } = imageData;
  const searchRange = 5; // 在粗略位置附近搜索精确位置
  const checkHeight = Math.min(10, Math.floor(height * 0.02));
  
  let bestY = roughY;
  let maxColorDiff = 0;
  
  // 在粗略位置附近搜索最佳分割线
  for (let y = Math.max(checkHeight, roughY - searchRange); 
       y <= Math.min(height - checkHeight - 1, roughY + searchRange); y++) {
    
    // 计算该位置上下区域的颜色差异
    let upR = 0, upG = 0, upB = 0;
    let downR = 0, downG = 0, downB = 0;
    let count = 0;
    
    // 计算上方区域平均颜色
    for (let ty = y - checkHeight; ty < y; ty++) {
      for (let x = 0; x < width; x++) {
        const idx = (ty * width + x) * 4;
        upR += data[idx];
        upG += data[idx + 1];
        upB += data[idx + 2];
        count++;
      }
    }
    
    // 计算下方区域平均颜色
    for (let ty = y + 1; ty <= y + checkHeight; ty++) {
      for (let x = 0; x < width; x++) {
        const idx = (ty * width + x) * 4;
        downR += data[idx];
        downG += data[idx + 1];
        downB += data[idx + 2];
      }
    }
    
    if (count === 0) continue;
    
    upR /= count; upG /= count; upB /= count;
    downR /= count; downG /= count; downB /= count;
    
    // 计算颜色差异
    const colorDiff = Math.abs(upR - downR) + Math.abs(upG - downG) + Math.abs(upB - downB);
    
    if (colorDiff > maxColorDiff) {
      maxColorDiff = colorDiff;
      bestY = y;
    }
  }
  
  // 如果颜色差异足够大，返回精确位置；否则返回null
  return maxColorDiff > 30 ? bestY : null;
}

// 验证是否为有效的分割线
function isValidSplitLine(imageData, width, height, y) {
  return findPreciseSplitLine(imageData, width, height, y) !== null;
}

function buildModal(slices) {
  ensureStyles();
  // 清理已有的弹窗，避免重复
  const oldMask = document.getElementById(IS_MASK_ID);
  if (oldMask) oldMask.remove();
  const oldModal = document.getElementById(IS_MODAL_ID);
  if (oldModal) oldModal.remove();

  const mask = document.createElement('div');
  mask.className = 'is-modal-mask';
  mask.id = IS_MASK_ID;
  const modal = document.createElement('div');
  modal.className = 'is-modal';
  modal.id = IS_MODAL_ID;
  const header = document.createElement('div'); header.className = 'is-header';
  header.innerHTML = `<div class="is-title">分割结果（${slices.length} 张）</div>`;
  const actions = document.createElement('div'); actions.className = 'is-actions';
  const closeBtn = document.createElement('button'); closeBtn.className = 'is-btn'; closeBtn.textContent = '关闭';
  closeBtn.addEventListener('click', () => { mask.remove(); modal.remove(); });
  actions.appendChild(closeBtn);
  header.appendChild(actions);
  const body = document.createElement('div'); body.className = 'is-body';
  const grid = document.createElement('div'); grid.className = 'is-grid';

  for (const dataUrl of slices) {
    const item = document.createElement('div'); item.className = 'is-item';
    const im = document.createElement('img');
    im.src = dataUrl;
    im.alt = 'slice';
    im.style.userSelect = 'auto';
    im.style.pointerEvents = 'auto';
    // 保留浏览器原生右键菜单，让扩展的“分割拼接图片”可继续使用
    // 不再阻止 contextmenu 事件
    item.appendChild(im);
    grid.appendChild(item);
  }
  body.appendChild(grid);
  const footer = document.createElement('div'); footer.className = 'is-footer';
  footer.textContent = '提示：对任意分割后的图片使用右键菜单，可继续分割（若仍是拼接图）。';

  modal.appendChild(header);
  modal.appendChild(body);
  modal.appendChild(footer);
  document.body.appendChild(mask);
  document.body.appendChild(modal);
}

async function getImageDataSafe(srcUrl) {
  // 第一次尝试：常规加载
  const first = await loadImageToCanvas(srcUrl, false);
  try {
    const imageData = first.ctx.getImageData(0, 0, first.width, first.height);
    return { ...first, imageData };
  } catch (e) {
    // 可能因跨域导致画布污染，改用后台抓取强制重试
    if (srcUrl.startsWith('file:')) {
      // file:// 无法通过后台抓取，直接抛出更友好的提示
      throw new Error('本地文件处理失败：请在扩展详情中开启“允许访问文件网址”，或将图片放到 http/https 可访问的位置后再试');
    }
    const second = await loadImageToCanvas(srcUrl, true);
    const imageData = second.ctx.getImageData(0, 0, second.width, second.height);
    return { ...second, imageData };
  }
}

async function canvasFromExistingElement(srcUrl) {
  // 优先使用页面上已经加载完成的 <img>，避免二次加载与 file:// 限制
  let candidate = Array.from(document.images || []).find(im => im.src === srcUrl || im.currentSrc === srcUrl);
  if (!candidate && document.images && document.images.length === 1 && location.href === srcUrl) {
    candidate = document.images[0];
  }
  if (!candidate) return null;
  if (!candidate.complete || candidate.naturalWidth === 0) {
    await new Promise((resolve, reject) => {
      candidate.addEventListener('load', resolve, { once: true });
      candidate.addEventListener('error', () => reject(new Error('页面图片未能加载完成')), { once: true });
    });
  }
  const canvas = document.createElement('canvas');
  canvas.width = candidate.naturalWidth;
  canvas.height = candidate.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(candidate, 0, 0);
  try {
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { canvas, ctx, width: canvas.width, height: canvas.height, imageData };
  } catch {
    // 若被污染，返回基础画布信息，调用方再做其它途径
    return { canvas, ctx, width: canvas.width, height: canvas.height, imageData: null };
  }
}

async function splitImageBySrc(srcUrl) {
  if (window.__IS_SPLITTER_BUSY__) {
    // 正在处理，避免重复弹窗
    return;
  }
  window.__IS_SPLITTER_BUSY__ = true;
  window.__IS_SPLITTER_LAST__ = srcUrl;
  try {
    // 先尝试使用页面现有 <img>（对于 file:// 尤为关键）
    let viaDom = await canvasFromExistingElement(srcUrl);
    let canvas, ctx, width, height, imageData;
    if (viaDom && viaDom.imageData) {
      ({ canvas, ctx, width, height, imageData } = viaDom);
    } else {
      ({ canvas, ctx, width, height, imageData } = await getImageDataSafe(srcUrl));
    }
    const lines = detectSplits(imageData, width, height);
    if (!lines.length) {
      // 无分割点，直接提示并展示整张图，方便继续右键
      buildModal([canvas.toDataURL('image/png')]);
      return;
    }
    // 切片
    const allLines = [0, ...lines, height];
    const slices = [];
    for (let i = 1; i < allLines.length; i++) {
      const y0 = allLines[i - 1];
      const y1 = allLines[i];
      const h = y1 - y0;
      const c = document.createElement('canvas');
      c.width = width; c.height = h;
      c.getContext('2d').drawImage(canvas, 0, y0, width, h, 0, 0, width, h);
      slices.push(c.toDataURL('image/png'));
    }
    buildModal(slices);
  } catch (e) {
    alert('分割失败：' + toErrorMessage(e, '处理图片时出现问题'));
  } finally {
    window.__IS_SPLITTER_BUSY__ = false;
  }
}

// 监听来自后台的分割指令（一次性初始化，避免重复）
if (!window.__IS_SPLITTER_INIT__) {
  Object.defineProperty(window, '__IS_SPLITTER_INIT__', { value: true, writable: false });
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.action === 'split-image' && msg.srcUrl) {
      splitImageBySrc(msg.srcUrl);
    }
  });
}
