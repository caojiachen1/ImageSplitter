// 内容脚本：分割图片并在页面以 Modal 方式展示；每张图片可使用浏览器右键菜单继续操作。

const IS_SPLITTER_STYLE_ID = 'image-splitter-style';
const IS_MODAL_ID = 'image-splitter-modal';
const IS_MASK_ID = 'image-splitter-mask';
const IS_EDITOR_ID = 'image-splitter-editor';
const IS_LINES_LAYER_ID = 'image-splitter-lines-layer';
const IS_MODE_ADD = 'add';
const IS_MODE_SELECT = 'select';

function ensureStyles() {
  if (document.getElementById(IS_SPLITTER_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = IS_SPLITTER_STYLE_ID;
  style.textContent = `
  .is-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483646;}
  .is-modal{position:fixed;inset:auto;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483647;background:#fff;border-radius:0px;box-shadow:0 10px 30px rgba(0,0,0,.2);max-height:95vh;max-width:min(98vw,1800px);display:flex;flex-direction:column;overflow:hidden;border:1px solid #e5e7eb}
  .is-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #eee;background:#fafafa}
  .is-title{font-size:14px;color:#111;font-weight:600}
  .is-actions{display:flex;gap:8px}
  .is-btn{padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;font-size:12px}
  .is-btn:hover{background:#f3f4f6}
  .is-body{padding:12px;overflow:auto}
  .is-grid{display:flex;flex-direction:column;gap:12px}
  .is-item{border:1px solid #e5e7eb;border-radius:0px;overflow:hidden;background:#fff}
  .is-item img{display:block;max-width:100%;height:auto}
  .is-footer{padding:10px 14px;border-top:1px solid #eee;background:#fafafa;color:#6b7280;font-size:12px}

  /* Editor styles */
  .is-editor-wrap{display:flex;flex-direction:column;gap:10px}
  .is-toolbar{display:flex;align-items:center;gap:8px}
  .is-badge{font-size:12px;color:#374151;background:#eef2ff;border:1px solid #c7d2fe;border-radius:999px;padding:2px 8px}
  .is-canvas-outer{position:relative;display:inline-block;max-width:100%;border:1px solid #e5e7eb;border-radius:0px;background:#fff}
  .is-canvas-inner{position:relative;min-height:200px}
  .is-img{display:block;max-width:100%;height:auto}
  .is-lines-layer{position:absolute;left:0;right:0;top:0;bottom:0;pointer-events:auto}
  .is-line{position:absolute;left:0;width:100%;height:0;border-top:2px solid #f59e0b;cursor:ns-resize;box-shadow:0 0 0 2px rgba(245,158,11,0.15)}
  .is-line.selected{border-top-color:#ef4444;box-shadow:0 0 0 2px rgba(239,68,68,0.25)}
  .is-line .handle{position:absolute;left:50%;transform:translate(-50%,-50%);top:0;background:#111827;color:#fff;font-size:10px;padding:2px 6px;border-radius:999px;user-select:none}
  .is-empty-hint{font-size:12px;color:#6b7280}
  .is-sep{width:1px;height:16px;background:#e5e7eb}
  .is-mode-btn.active{background:#111827;color:#fff;border-color:#111827}
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
  
  // 方法1: 计算每行与上一行的绝对差（RGB）
  const rowDiffs = new Float64Array(height);
  for (let y = 1; y < height; y++) {
    let rowDiff = 0;
    let base1 = (y - 1) * width * 4;
    let base2 = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i1 = base1 + x * 4;
      const i2 = base2 + x * 4;
      rowDiff += Math.abs(data[i1] - data[i2]) + Math.abs(data[i1 + 1] - data[i2 + 1]) + Math.abs(data[i1 + 2] - data[i2 + 2]);
    }
    rowDiffs[y] = rowDiff / width;
  }

  // 方法2: 计算每行的颜色一致性（方差）
  const rowVariances = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    let rSum = 0, gSum = 0, bSum = 0;
    let base = y * width * 4;
    
    // 计算平均颜色
    for (let x = 0; x < width; x++) {
      const i = base + x * 4;
      rSum += data[i];
      gSum += data[i + 1];
      bSum += data[i + 2];
    }
    const rMean = rSum / width;
    const gMean = gSum / width;
    const bMean = bSum / width;
    
    // 计算方差
    let variance = 0;
    for (let x = 0; x < width; x++) {
      const i = base + x * 4;
      variance += Math.pow(data[i] - rMean, 2) + 
                  Math.pow(data[i + 1] - gMean, 2) + 
                  Math.pow(data[i + 2] - bMean, 2);
    }
    rowVariances[y] = variance / width;
  }

  // 方法3: 检测颜色区域边界
  const colorBoundaries = new Float64Array(height);
  const regionSize = Math.max(3, Math.floor(height * 0.01)); // 动态区域大小
  
  for (let y = regionSize; y < height - regionSize; y++) {
    // 计算上方区域平均颜色
    let upR = 0, upG = 0, upB = 0;
    for (let ty = y - regionSize; ty < y; ty++) {
      for (let x = 0; x < width; x++) {
        const idx = (ty * width + x) * 4;
        upR += data[idx];
        upG += data[idx + 1];
        upB += data[idx + 2];
      }
    }
    const upCount = regionSize * width;
    upR /= upCount; upG /= upCount; upB /= upCount;
    
    // 计算下方区域平均颜色
    let downR = 0, downG = 0, downB = 0;
    for (let ty = y; ty < y + regionSize; ty++) {
      for (let x = 0; x < width; x++) {
        const idx = (ty * width + x) * 4;
        downR += data[idx];
        downG += data[idx + 1];
        downB += data[idx + 2];
      }
    }
    downR /= upCount; downG /= upCount; downB /= upCount;
    
    // 计算颜色距离
    colorBoundaries[y] = Math.sqrt(
      Math.pow(upR - downR, 2) + 
      Math.pow(upG - downG, 2) + 
      Math.pow(upB - downB, 2)
    );
  }

  // 方法4: 水平边缘检测（类似Sobel算子）
  const edgeStrength = new Float64Array(height);
  for (let y = 1; y < height - 1; y++) {
    let edge = 0;
    const prevBase = (y - 1) * width * 4;
    const nextBase = (y + 1) * width * 4;
    
    for (let x = 0; x < width; x++) {
      const prevIdx = prevBase + x * 4;
      const nextIdx = nextBase + x * 4;
      
      // 计算垂直梯度
      const rGrad = Math.abs(data[nextIdx] - data[prevIdx]);
      const gGrad = Math.abs(data[nextIdx + 1] - data[prevIdx + 1]);
      const bGrad = Math.abs(data[nextIdx + 2] - data[prevIdx + 2]);
      
      edge += rGrad + gGrad + bGrad;
    }
    edgeStrength[y] = edge / width;
  }

  // 综合多种检测方法
  const combined = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    // 归一化各种指标到0-1范围
    const normalizedRowDiff = Math.min(1, rowDiffs[y] / 100);
    const normalizedVariance = Math.min(1, rowVariances[y] / 10000);
    const normalizedBoundary = Math.min(1, colorBoundaries[y] / 100);
    const normalizedEdge = Math.min(1, edgeStrength[y] / 100);
    
    // 加权组合，行差异和颜色边界权重较高
    combined[y] = normalizedRowDiff * 0.4 + 
                  normalizedBoundary * 0.3 + 
                  normalizedEdge * 0.2 + 
                  (1 - normalizedVariance) * 0.1; // 低方差（一致性）也是边界特征
  }

  // 平滑处理
  const smooth = new Float64Array(height);
  const W = 3;
  for (let y = 0; y < height; y++) {
    let s = 0, c = 0;
    for (let k = -W; k <= W; k++) {
      const yy = y + k;
      if (yy >= 0 && yy < height) { s += combined[yy]; c++; }
    }
    smooth[y] = s / (c || 1);
  }

  // 自适应阈值计算
  const sorted = Array.from(smooth).sort((a, b) => a - b);
  const q90 = sorted[Math.floor(0.90 * sorted.length)];
  const q95 = sorted[Math.floor(0.95 * sorted.length)];
  const q99 = sorted[Math.floor(0.99 * sorted.length)];
  
  // 根据图片特征选择合适的阈值
  let threshold;
  if (q99 - q90 > 0.3) {
    // 高对比度图片，使用较高阈值
    threshold = q95;
  } else {
    // 低对比度图片，使用较低阈值
    threshold = q90;
  }

  // 改进的峰值检测
  const candidates = [];
  const minPeakWidth = 2;
  const minPeakHeight = threshold;
  
  for (let y = minPeakWidth; y < height - minPeakWidth; y++) {
    if (smooth[y] > minPeakHeight) {
      // 检查是否为局部最大值
      let isLocalMax = true;
      for (let k = 1; k <= minPeakWidth; k++) {
        if (smooth[y] < smooth[y - k] || smooth[y] < smooth[y + k]) {
          isLocalMax = false;
          break;
        }
      }
      
      if (isLocalMax) {
        // 进一步验证：检查峰值的突出程度
        const leftMin = Math.min(...Array.from(smooth.slice(Math.max(0, y - 10), y)));
        const rightMin = Math.min(...Array.from(smooth.slice(y + 1, Math.min(height, y + 11))));
        const prominence = smooth[y] - Math.max(leftMin, rightMin);
        
        if (prominence > threshold * 0.3) {
          // 精确定位分割线
          const preciseY = findPreciseSplitLine(imageData, width, height, y);
          if (preciseY !== null) {
            candidates.push(preciseY);
          }
        }
      }
    }
  }

  // 合并相近的候选
  const merged = [];
  let group = [];
  const MIN_GAP = Math.max(15, Math.floor(height * 0.02)); // 动态最小间隔
  
  candidates.sort((a, b) => a - b);
  
  for (const y of candidates) {
    if (!group.length || y - group[group.length - 1] <= MIN_GAP) {
      group.push(y);
    } else {
      const centerY = Math.round(group.reduce((sum, yy) => sum + yy, 0) / group.length);
      merged.push(centerY);
      group = [y];
    }
  }
  if (group.length) {
    const centerY = Math.round(group.reduce((sum, yy) => sum + yy, 0) / group.length);
    merged.push(centerY);
  }

  // 最终过滤：确保分割片段有足够大小
  const MIN_SLICE = Math.max(30, Math.floor(height * 0.03));
  const lines = [];
  let prev = 0;
  
  for (const y of [...merged, height]) {
    if (y - prev >= MIN_SLICE) {
      lines.push(y);
      prev = y;
    }
  }
  
  if (lines.length && lines[lines.length - 1] === height) lines.pop();
  return lines;
}

// 验证是否为有效的分割线，并返回精确的分割位置
function findPreciseSplitLine(imageData, width, height, roughY) {
  const { data } = imageData;
  const searchRange = 8; // 扩大搜索范围
  const checkHeight = Math.min(15, Math.floor(height * 0.03)); // 增加检查区域
  
  let bestY = roughY;
  let maxScore = 0;
  
  // 在粗略位置附近搜索最佳分割线
  for (let y = Math.max(checkHeight, roughY - searchRange); 
       y <= Math.min(height - checkHeight - 1, roughY + searchRange); y++) {
    
    // 计算多种特征的综合评分
    const colorScore = calculateColorDifferenceScore(data, width, height, y, checkHeight);
    const consistencyScore = calculateRegionConsistencyScore(data, width, height, y, checkHeight);
    const edgeScore = calculateEdgeScore(data, width, height, y);
    
    // 综合评分
    const totalScore = colorScore * 0.5 + consistencyScore * 0.3 + edgeScore * 0.2;
    
    if (totalScore > maxScore) {
      maxScore = totalScore;
      bestY = y;
    }
  }
  
  // 如果综合评分足够高，返回精确位置
  return maxScore > 30 ? bestY : null;
}

// 计算颜色差异评分
function calculateColorDifferenceScore(data, width, height, y, checkHeight) {
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
  
  if (count === 0) return 0;
  
  upR /= count; upG /= count; upB /= count;
  downR /= count; downG /= count; downB /= count;
  
  // 计算Lab色彩空间的感知差异（更准确）
  const deltaE = calculateDeltaE(upR, upG, upB, downR, downG, downB);
  return Math.min(100, deltaE * 2);
}

// 计算区域一致性评分
function calculateRegionConsistencyScore(data, width, height, y, checkHeight) {
  const upVariance = calculateRegionVariance(data, width, y - checkHeight, y);
  const downVariance = calculateRegionVariance(data, width, y + 1, y + checkHeight + 1);
  
  // 两个区域内部越一致（方差越小），分割线越可能正确
  const avgVariance = (upVariance + downVariance) / 2;
  return Math.max(0, 100 - avgVariance / 100);
}

// 计算边缘强度评分
function calculateEdgeScore(data, width, height, y) {
  if (y === 0 || y >= height - 1) return 0;
  
  let edgeStrength = 0;
  const prevBase = (y - 1) * width * 4;
  const nextBase = (y + 1) * width * 4;
  
  for (let x = 0; x < width; x++) {
    const prevIdx = prevBase + x * 4;
    const nextIdx = nextBase + x * 4;
    
    const rGrad = Math.abs(data[nextIdx] - data[prevIdx]);
    const gGrad = Math.abs(data[nextIdx + 1] - data[prevIdx + 1]);
    const bGrad = Math.abs(data[nextIdx + 2] - data[prevIdx + 2]);
    
    edgeStrength += rGrad + gGrad + bGrad;
  }
  
  return Math.min(100, edgeStrength / (width * 3));
}

// 计算区域方差
function calculateRegionVariance(data, width, startY, endY) {
  let rSum = 0, gSum = 0, bSum = 0;
  let count = 0;
  
  // 计算平均值
  for (let y = startY; y < endY; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rSum += data[idx];
      gSum += data[idx + 1];
      bSum += data[idx + 2];
      count++;
    }
  }
  
  if (count === 0) return 0;
  
  const rMean = rSum / count;
  const gMean = gSum / count;
  const bMean = bSum / count;
  
  // 计算方差
  let variance = 0;
  for (let y = startY; y < endY; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      variance += Math.pow(data[idx] - rMean, 2) + 
                  Math.pow(data[idx + 1] - gMean, 2) + 
                  Math.pow(data[idx + 2] - bMean, 2);
    }
  }
  
  return variance / count;
}

// 计算感知颜色差异（简化的Delta E）
function calculateDeltaE(r1, g1, b1, r2, g2, b2) {
  // 简化的Lab颜色空间转换和Delta E计算
  const deltaR = r1 - r2;
  const deltaG = g1 - g2;
  const deltaB = b1 - b2;
  
  // 权重反映人眼对不同颜色的敏感度
  return Math.sqrt(2 * deltaR * deltaR + 4 * deltaG * deltaG + 3 * deltaB * deltaB);
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

// 打开可编辑分割线的编辑器
function openSplitEditor(canvas, width, height, initialLines, imageData) {
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
  header.innerHTML = `<div class="is-title">编辑分割线</div>`;
  const actions = document.createElement('div'); actions.className = 'is-actions';
  const cancelBtn = document.createElement('button'); cancelBtn.className = 'is-btn'; cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', () => { cleanup(); mask.remove(); modal.remove(); });
  actions.appendChild(cancelBtn);
  header.appendChild(actions);

  const body = document.createElement('div'); body.className = 'is-body';
  const wrap = document.createElement('div'); wrap.className = 'is-editor-wrap';
  const toolbar = document.createElement('div'); toolbar.className = 'is-toolbar';
  const badge = document.createElement('span'); badge.className = 'is-badge'; badge.textContent = '分割线编辑器';
  const addBtn = document.createElement('button'); addBtn.className = 'is-btn is-mode-btn'; addBtn.textContent = '添加 (Ctrl)'; addBtn.dataset.mode = IS_MODE_ADD;
  const selectBtn = document.createElement('button'); selectBtn.className = 'is-btn is-mode-btn'; selectBtn.textContent = '选择'; selectBtn.dataset.mode = IS_MODE_SELECT;
  const sep1 = document.createElement('div'); sep1.className = 'is-sep';
  const autoBtn = document.createElement('button'); autoBtn.className = 'is-btn'; autoBtn.textContent = '自动检测';
  const clearBtn = document.createElement('button'); clearBtn.className = 'is-btn'; clearBtn.textContent = '清空';
  const sep2 = document.createElement('div'); sep2.className = 'is-sep';
  const hint = document.createElement('span'); hint.className = 'is-empty-hint'; hint.textContent = '提示：按住 Ctrl 在图片上单击添加分割线';
  const spacer = document.createElement('div'); spacer.style.flex = '1';
  const okBtn = document.createElement('button'); okBtn.className = 'is-btn'; okBtn.textContent = '确认切割';
  toolbar.append(badge, addBtn, selectBtn, sep1, autoBtn, clearBtn, sep2, hint, spacer, okBtn);

  const outer = document.createElement('div'); outer.className = 'is-canvas-outer';
  const img = document.createElement('img'); img.className = 'is-img'; img.alt = 'source'; img.src = canvas.toDataURL('image/png');
  const linesLayer = document.createElement('div'); linesLayer.className = 'is-lines-layer'; linesLayer.id = IS_LINES_LAYER_ID;
  const inner = document.createElement('div'); inner.className = 'is-canvas-inner';
  inner.appendChild(img);
  outer.append(inner, linesLayer);

  wrap.append(toolbar, outer);
  body.appendChild(wrap);

  const footer = document.createElement('div'); footer.className = 'is-footer';
  footer.textContent = '拖动分割线可调整位置；Delete 删除选中分割线。';

  modal.append(header, body, footer);
  document.body.append(mask);
  document.body.append(modal);

  // 状态与工具
  let mode = IS_MODE_SELECT;
  let lines = Array.isArray(initialLines) ? [...initialLines] : [];
  let selectedIndex = -1;
  const MIN_GAP = Math.max(8, Math.floor(height * 0.01));
  const MIN_SLICE = Math.max(20, Math.floor(height * 0.02));

  function setMode(newMode) {
    mode = newMode;
    addBtn.classList.toggle('active', mode === IS_MODE_ADD);
    selectBtn.classList.toggle('active', mode === IS_MODE_SELECT);
  }

  // 无分割线时默认添加模式
  if (!lines.length) setMode(IS_MODE_ADD); else setMode(IS_MODE_SELECT);

  function getImageRect() {
    return img.getBoundingClientRect();
  }
  function yImageFromClient(clientY) {
    const rect = getImageRect();
    const rel = clientY - rect.top;
    const ratio = rect.height > 0 ? rel / rect.height : 0;
    return Math.max(MIN_GAP, Math.min(height - MIN_GAP, Math.round(ratio * height)));
  }
  function topPxFromYImage(yImg) {
    const rect = getImageRect();
    return (yImg / height) * rect.height;
  }

  function dedupAndSort() {
    lines = Array.from(new Set(lines.map(v => Math.max(MIN_GAP, Math.min(height - MIN_GAP, Math.round(v)))))).sort((a, b) => a - b);
  }

  function updateHint() {
    hint.style.display = lines.length ? 'none' : 'inline';
  }

  function renderLines() {
    // 清空
    linesLayer.innerHTML = '';
    lines.forEach((y, idx) => {
      const line = document.createElement('div');
      line.className = 'is-line' + (idx === selectedIndex ? ' selected' : '');
      line.style.top = `${topPxFromYImage(y)}px`;
      const handle = document.createElement('div'); handle.className = 'handle'; handle.textContent = `${idx + 1}`;
      line.appendChild(handle);
      // 选择
      line.addEventListener('mousedown', (ev) => {
        if (ev.button !== 0) return; // 仅左键
        ev.stopPropagation();
        // 选择
        selectedIndex = idx;
        renderLines();
        // 拖动
        let startYImage = y;
        const onMove = (mv) => {
          const yImg = yImageFromClient(mv.clientY);
          // 约束于相邻线与边界
          const prev = idx > 0 ? lines[idx - 1] + MIN_GAP : MIN_GAP;
          const next = idx < lines.length - 1 ? lines[idx + 1] - MIN_GAP : height - MIN_GAP;
          const clamped = Math.max(prev, Math.min(next, yImg));
          if (clamped !== lines[idx]) {
            lines[idx] = clamped;
            renderLines();
          }
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          dedupAndSort();
          selectedIndex = lines.indexOf(lines[idx]);
          renderLines();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp, { once: true });
      });
      linesLayer.appendChild(line);
    });
    updateHint();
  }

  function addLineAt(yImage) {
    lines.push(yImage);
    dedupAndSort();
    selectedIndex = lines.indexOf(yImage);
    renderLines();
  }

  // Ctrl+单击添加；添加模式下单击添加
  linesLayer.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    const yImg = yImageFromClient(ev.clientY);
    if (ev.ctrlKey || mode === IS_MODE_ADD) {
      addLineAt(yImg);
    } else {
      // 选择模式下，点击空白取消选择
      selectedIndex = -1; renderLines();
    }
  });

  // 处理缩放导致位置变化
  window.addEventListener('resize', renderLines);
  const ro = new (window.ResizeObserver || function(func){ return { observe(){}, disconnect(){} };})(() => renderLines());
  try { ro.observe(img); } catch {}

  // 按钮交互
  addBtn.addEventListener('click', () => setMode(IS_MODE_ADD));
  selectBtn.addEventListener('click', () => setMode(IS_MODE_SELECT));
  clearBtn.addEventListener('click', () => { lines = []; selectedIndex = -1; setMode(IS_MODE_ADD); renderLines(); });
  autoBtn.addEventListener('click', () => {
    try {
      const detected = detectSplits(imageData, width, height);
      if (detected && detected.length) {
        lines = detected.slice();
        dedupAndSort();
        setMode(IS_MODE_SELECT);
        renderLines();
      } else {
        alert('未检测到分割线，可手动添加');
        setMode(IS_MODE_ADD);
        renderLines();
      }
    } catch (e) {
      alert('自动检测失败：' + toErrorMessage(e));
    }
  });
  okBtn.addEventListener('click', () => {
    // 验证片段高度
    const sorted = [...lines].sort((a,b)=>a-b);
    let prev = 0;
    for (const y of [...sorted, height]) {
      if (y - prev < MIN_SLICE) {
        if (!confirm('有些片段高度过小，仍要继续切割吗？')) return;
        break;
      }
      prev = y;
    }
    // 切片
    finalizeSlicing(canvas, width, height, sorted);
    cleanup();
    mask.remove(); modal.remove();
  });

  // 键盘删除与取消
  const onKey = (ev) => {
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (selectedIndex >= 0) {
        ev.preventDefault();
        lines.splice(selectedIndex, 1);
        selectedIndex = -1;
        if (!lines.length) setMode(IS_MODE_ADD);
        renderLines();
      }
    } else if (ev.key === 'Escape') {
      cleanup();
      mask.remove(); modal.remove();
    }
  };
  document.addEventListener('keydown', onKey);
  function cleanup(){
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', renderLines);
    try { ro.disconnect(); } catch {}
  }
  // 兜底：若节点被外部移除，也执行清理
  const mo = new (window.MutationObserver || function(){ return { observe(){}, disconnect(){} };})(() => {
    if (!document.body.contains(modal)) { cleanup(); try{ mo.disconnect(); }catch{} }
  });
  try { mo.observe(document.body, { childList: true, subtree: true }); } catch {}

  // 初始化
  renderLines();
}

function finalizeSlicing(canvas, width, height, lines) {
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
    // 打开编辑器（即使没有检测到分割线，也允许手动添加）
    openSplitEditor(canvas, width, height, lines, imageData);
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
