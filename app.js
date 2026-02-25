// ===== State =====
let uploadedImage = null; // HTMLImageElement
let customSizes = [];     // [{w, h}]
const fullResCrops = {};  // { thumbMain: Canvas, thumbBg: Canvas, ... } full-resolution crops for composition

// 統一元素繪製順序（上→下 = 先繪製→後繪製），背景圖固定最底層不參與排序
let layerOrder = ['thumbMain', 'thumbTitle', 'thumbAux', 'thumbLogo', 'textTitle', 'textSubtitle', 'textDesc', 'textNote', 'textDate'];

// Store the last AI-generated image (as base64) for refine and Section 5
let lastAIGeneratedBase64 = null;
let lastAIBgBase64 = null; // raw AI background (before text overlay)
let sec4SourceImage = null; // Section 4 custom uploaded source image

// ===== Service Worker =====
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ===== Section 1: File Upload =====
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const urlInput = document.getElementById('urlInput');
const fileInfo = document.getElementById('fileInfo');

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});

fileInput.addEventListener('change', e => {
  if (e.target.files.length) handleFile(e.target.files[0]);
});

urlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && urlInput.value.trim()) loadImageFromURL(urlInput.value.trim());
});
urlInput.addEventListener('blur', () => {
  if (urlInput.value.trim()) loadImageFromURL(urlInput.value.trim());
});
urlInput.addEventListener('paste', () => {
  setTimeout(() => {
    if (urlInput.value.trim()) loadImageFromURL(urlInput.value.trim());
  }, 100);
});

function handleFile(file) {
  if (!file.type.startsWith('image/')) return alert('請上傳圖片檔案');
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      uploadedImage = img;
      showFileInfo(file.name, file.type.split('/')[1].toUpperCase(), img.width, img.height, file.size);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

let _lastLoadedURL = '';
function loadImageFromURL(url) {
  if (!url || url === _lastLoadedURL) return;
  try { new URL(url); } catch { return; }
  _lastLoadedURL = url;

  // Show loading state
  fileInfo.style.display = 'flex';
  document.getElementById('fileName').textContent = '載入中...';
  document.getElementById('fileType').textContent = '—';
  document.getElementById('fileDims').textContent = '—';
  document.getElementById('fileSize').textContent = '—';
  const thumbBox = document.getElementById('thumbBox');
  thumbBox.innerHTML = '<span style="font-size:11px;color:#8B8FA3">載入中</span>';

  const name = url.split('/').pop().split('?')[0] || 'image.png';

  // Download as Blob → Blob URL → Image (same-origin, canvas never tainted)
  fetch(url)
    .then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
    .then(blob => loadImageFromBlob(blob, name, blob.size))
    .catch(() => {
      // CORS blocked fetch — try public proxy
      const proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent(url);
      fetch(proxyUrl)
        .then(r => { if (!r.ok) throw new Error(r.status); return r.blob(); })
        .then(blob => loadImageFromBlob(blob, name, blob.size))
        .catch(() => {
          _lastLoadedURL = '';
          document.getElementById('fileName').textContent = '載入失敗';
          thumbBox.innerHTML = '<span style="font-size:11px;color:#DC2626">無法載入圖片</span>';
        });
    });
}

function loadImageFromBlob(blob, name, bytes) {
  const blobUrl = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    uploadedImage = img;
    const ext = blob.type ? blob.type.split('/')[1].toUpperCase() : 'URL';
    showFileInfo(name, ext, img.width, img.height, bytes);
  };
  img.onerror = () => {
    _lastLoadedURL = '';
    document.getElementById('fileName').textContent = '載入失敗';
    document.getElementById('thumbBox').innerHTML = '<span style="font-size:11px;color:#DC2626">無法載入圖片</span>';
    URL.revokeObjectURL(blobUrl);
  };
  img.src = blobUrl;
}

function showFileInfo(name, type, w, h, bytes) {
  fileInfo.style.display = 'flex';
  document.getElementById('fileName').textContent = name;
  document.getElementById('fileType').textContent = type;
  document.getElementById('fileDims').textContent = `${w} × ${h} px`;
  document.getElementById('fileSize').textContent = bytes ? formatBytes(bytes) : '—';

  // Enable analyze button
  const ab = document.getElementById('analyzeBtn');
  ab.disabled = false;
  ab.classList.remove('disabled');

  // Update thumbnail
  const thumbBox = document.getElementById('thumbBox');
  thumbBox.innerHTML = '';
  const thumbImg = document.createElement('img');
  thumbImg.src = uploadedImage.src;
  thumbBox.appendChild(thumbImg);
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

// ===== AI Element Analysis (Transformers.js + fallback) =====
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';
env.allowLocalModels = false;

const analyzeBtn = document.getElementById('analyzeBtn');
const ocrStatus = document.getElementById('ocrStatus');
let detectorPipeline = null;
let lastDetections = []; // store detected objects globally for Section 3

analyzeBtn.addEventListener('click', () => {
  if (!uploadedImage) return alert('請先上傳圖片');
  startAnalysis();
});

// Custom image upload for each element
document.querySelectorAll('.add-img-btn input[type="file"]').forEach(input => {
  input.addEventListener('change', e => {
    if (!e.target.files.length) return;
    const thumbId = e.target.dataset.thumb;
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        const thumbEl = document.getElementById(thumbId);
        thumbEl.innerHTML = '';
        thumbEl.style.background = 'none';
        thumbEl.dataset.empty = '';
        // Store full-resolution canvas for composition (preserves alpha)
        const fc = document.createElement('canvas');
        fc.width = img.width; fc.height = img.height;
        const fctx = fc.getContext('2d');
        fctx.clearRect(0, 0, fc.width, fc.height);
        fctx.drawImage(img, 0, 0);
        fullResCrops[thumbId] = fc;

        // Small thumbnail for UI display — use canvas to preserve transparency
        const maxDim = 192;
        const ratio = img.width / img.height;
        const tc = document.createElement('canvas');
        tc.width = ratio >= 1 ? maxDim : Math.round(maxDim * ratio);
        tc.height = ratio >= 1 ? Math.round(maxDim / ratio) : maxDim;
        const tctx = tc.getContext('2d');
        tctx.clearRect(0, 0, tc.width, tc.height);
        tctx.drawImage(fc, 0, 0, tc.width, tc.height);
        tc.style.maxWidth = '100%'; tc.style.maxHeight = '100%'; tc.style.borderRadius = '4px';
        thumbEl.classList.add('has-checkerboard');
        thumbEl.appendChild(tc);
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });
});

// Background color picker
document.getElementById('bgColorPicker').addEventListener('input', e => {
  const color = e.target.value;
  const thumbEl = document.getElementById('thumbBg');
  thumbEl.innerHTML = '';
  thumbEl.dataset.empty = '';
  thumbEl.classList.remove('has-checkerboard');
  thumbEl.style.background = color;

  // Store a solid-color full-res canvas (use uploaded image size, or default 1920x1080)
  const w = uploadedImage ? uploadedImage.width : 1920;
  const h = uploadedImage ? uploadedImage.height : 1080;
  const fc = document.createElement('canvas');
  fc.width = w; fc.height = h;
  const fctx = fc.getContext('2d');
  fctx.fillStyle = color;
  fctx.fillRect(0, 0, w, h);
  fullResCrops.thumbBg = fc;

  // Update thumbnail display with a small color swatch
  const tc = document.createElement('canvas');
  tc.width = 192; tc.height = 128;
  const tctx = tc.getContext('2d');
  tctx.fillStyle = color;
  tctx.fillRect(0, 0, 192, 128);
  tc.style.maxWidth = '100%'; tc.style.maxHeight = '100%'; tc.style.borderRadius = '4px';
  thumbEl.style.background = 'none';
  thumbEl.appendChild(tc);

  // Remove confidence tag
  const conf = thumbEl.closest('.element-item').querySelector('.confidence-tag');
  if (conf) conf.remove();
});

// Text color pickers — sync swatch display
document.querySelectorAll('.text-color-pick input[type="color"]').forEach(input => {
  input.addEventListener('input', e => {
    const swatch = e.target.parentElement.querySelector('.color-swatch');
    if (swatch) swatch.style.background = e.target.value;
  });
});

// Date range picker — auto-fill txtDate
function syncDateRange() {
  const s = document.getElementById('dateStart').value;
  const e = document.getElementById('dateEnd').value;
  if (!s) return;
  const fmt = d => d.replace(/-/g, '.');
  const startStr = fmt(s);
  if (!e || e <= s) {
    document.getElementById('txtDate').value = startStr;
  } else {
    // Same year → omit year on end date
    const endStr = s.slice(0, 4) === e.slice(0, 4) ? fmt(e).slice(5) : fmt(e);
    document.getElementById('txtDate').value = startStr + ' - ' + endStr;
  }
}
document.getElementById('dateStart').addEventListener('change', syncDateRange);
document.getElementById('dateEnd').addEventListener('change', syncDateRange);

// Clear (blank) buttons for image elements
document.querySelectorAll('.clear-img-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const thumbId = btn.dataset.thumb;
    const thumbEl = document.getElementById(thumbId);
    thumbEl.innerHTML = '';
    thumbEl.style.background = '#D4D6E0';
    thumbEl.classList.remove('has-checkerboard');
    thumbEl.dataset.empty = 'true';
    delete fullResCrops[thumbId]; // remove full-res crop
    const conf = thumbEl.closest('.element-item').querySelector('.confidence-tag');
    if (conf) conf.remove();
  });
});

async function startAnalysis() {
  analyzeBtn.classList.add('analyzing');
  analyzeBtn.innerHTML = '<div class="spinner"></div> AI 分析中...';
  ocrStatus.innerHTML = '<span>正在載入 AI 辨識模型...</span><div class="progress-bar"><div class="progress-fill" id="ocrProgress" style="width:2%"></div></div>';

  try {
    // Step 1: Load & run object detection with Transformers.js
    updateProgress(5, '正在載入物件偵測模型...');
    const useML = await loadDetector();

    if (useML) {
      updateProgress(15, '正在執行物件偵測...');
      await runObjectDetection();
    } else {
      updateProgress(15, '模型載入失敗，使用進階影像分析...');
      extractImageElementsFallback();
    }

    // Step 2: OCR text recognition with Tesseract.js
    updateProgress(40, '正在辨識文字（OCR）...');
    await runOCR();

    // Done
    updateProgress(100, '分析完成');
    analyzeBtn.classList.remove('analyzing');
    analyzeBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      分析完成 — 重新分析
    `;
    await delay(500);
    ocrStatus.textContent = '';
    document.getElementById('sec2').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    console.error('Analysis error:', err);
    analyzeBtn.classList.remove('analyzing');
    analyzeBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
      重新分析
    `;
    ocrStatus.textContent = '分析過程發生錯誤，請重試';
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function updateProgress(pct, msg) {
  const fill = document.getElementById('ocrProgress');
  if (fill) fill.style.width = pct + '%';
  const span = ocrStatus.querySelector('span');
  if (span && msg) span.textContent = msg;
}

// ===== Transformers.js Object Detection =====
async function loadDetector() {
  if (detectorPipeline) return true;
  try {
    detectorPipeline = await pipeline('object-detection', 'Xenova/yolos-tiny', {
      progress_callback: p => {
        if (p.status === 'progress' && p.progress) {
          updateProgress(5 + p.progress * 0.1, `下載模型中 ${Math.round(p.progress)}%...`);
        }
      }
    });
    return true;
  } catch (e) {
    console.warn('ML model failed to load:', e);
    return false;
  }
}

async function runObjectDetection() {
  const img = uploadedImage;
  // Create temp canvas for detection input
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').drawImage(img, 0, 0);
  const dataUrl = c.toDataURL('image/jpeg', 0.85);

  const results = await detectorPipeline(dataUrl, { threshold: 0.3, percentage: true });
  lastDetections = results || [];
  updateProgress(30, `偵測到 ${lastDetections.length} 個物件，分類中...`);
  await delay(200);

  mapDetectionsToElements(c, lastDetections, img.width, img.height);
}

// Map COCO detected objects → our 5 image element categories
function mapDetectionsToElements(sourceCanvas, detections, w, h) {
  // Sort by area descending
  const sorted = detections.map(d => {
    const bx = d.box.xmin * w, by = d.box.ymin * h;
    const bw = (d.box.xmax - d.box.xmin) * w, bh = (d.box.ymax - d.box.ymin) * h;
    const area = bw * bh;
    const cx = bx + bw / 2, cy = by + bh / 2;
    return { ...d, bx, by, bw, bh, area, cx, cy };
  }).sort((a, b) => b.area - a.area);

  // 背景圖: always full image
  cropToThumbFromCanvas(sourceCanvas, { x: 0, y: 0, w, h }, 'thumbBg', '背景', 0.95);

  if (sorted.length === 0) {
    // No objects found — use heuristic fallback for remaining
    extractImageElementsFallback();
    return;
  }

  // 主視覺圖: largest object
  const main = sorted[0];
  cropToThumbFromCanvas(sourceCanvas, { x: main.bx, y: main.by, w: main.bw, h: main.bh },
    'thumbMain', main.label, main.score);

  // Logo / 標誌: smallest object in a corner area
  const cornerObjs = sorted.filter(d => {
    const inCorner = (d.cx < w * 0.3 || d.cx > w * 0.7) && (d.cy < h * 0.3 || d.cy > h * 0.7);
    return inCorner && d !== main;
  });
  if (cornerObjs.length > 0) {
    const logo = cornerObjs[cornerObjs.length - 1]; // smallest in corner
    cropToThumbFromCanvas(sourceCanvas, { x: logo.bx, y: logo.by, w: logo.bw, h: logo.bh },
      'thumbLogo', logo.label, logo.score);
  } else {
    // Fallback: top-left corner region
    cropToThumbFromCanvas(sourceCanvas, { x: 0, y: 0, w: w * 0.25, h: h * 0.25 },
      'thumbLogo', 'Logo 區域', 0.4);
  }

  // 圖像標題: object near the top
  const topObjs = sorted.filter(d => d.cy < h * 0.35 && d !== main);
  if (topObjs.length > 0) {
    const title = topObjs[0];
    cropToThumbFromCanvas(sourceCanvas, { x: title.bx, y: title.by, w: title.bw, h: title.bh },
      'thumbTitle', title.label, title.score);
  } else {
    cropToThumbFromCanvas(sourceCanvas, { x: 0, y: 0, w: w, h: h * 0.22 },
      'thumbTitle', '頂部區域', 0.5);
  }

  // 輔助圖像: second largest or object away from main
  const auxCandidates = sorted.filter(d => d !== main && d !== (cornerObjs[cornerObjs.length - 1]) && d !== topObjs[0]);
  if (auxCandidates.length > 0) {
    const aux = auxCandidates[0];
    cropToThumbFromCanvas(sourceCanvas, { x: aux.bx, y: aux.by, w: aux.bw, h: aux.bh },
      'thumbAux', aux.label, aux.score);
  } else {
    const auxY = main.cy < h * 0.5 ? h * 0.6 : 0;
    cropToThumbFromCanvas(sourceCanvas, { x: w * 0.1, y: auxY, w: w * 0.8, h: h * 0.3 },
      'thumbAux', '輔助區域', 0.35);
  }
}

// ===== Fallback: Canvas Saliency Analysis =====
function extractImageElementsFallback() {
  const img = uploadedImage;
  const w = img.width, h = img.height;
  const ac = document.createElement('canvas');
  ac.width = w; ac.height = h;
  const actx = ac.getContext('2d');
  actx.drawImage(img, 0, 0);
  const fullData = actx.getImageData(0, 0, w, h);
  const sal = computeSaliencyMap(fullData, w, h);
  const mainBBox = findSalientRegion(sal, w, h, 0.6);

  cropToThumbFromCanvas(ac, mainBBox, 'thumbMain', '主視覺', calcConfidence(sal, mainBBox, w));
  cropToThumbFromCanvas(ac, detectLogoRegion(fullData, w, h), 'thumbLogo', 'Logo', 0.55);
  cropToThumbFromCanvas(ac, { x: 0, y: 0, w, h: Math.min(mainBBox.y, h * 0.3) || h * 0.2 }, 'thumbTitle', '標題區', 0.5);
  cropToThumbFromCanvas(ac, { x: 0, y: 0, w, h }, 'thumbBg', '背景', 0.9);
  cropToThumbFromCanvas(ac, findAuxRegion(sal, mainBBox, w, h), 'thumbAux', '輔助', 0.4);
}

function computeSaliencyMap(imageData, w, h) {
  const data = imageData.data;
  const sal = new Float32Array(w * h);
  let rSum = 0, gSum = 0, bSum = 0;
  const total = w * h;
  for (let i = 0; i < total; i++) { rSum += data[i*4]; gSum += data[i*4+1]; bSum += data[i*4+2]; }
  const rM = rSum/total, gM = gSum/total, bM = bSum/total;
  for (let i = 0; i < total; i++) {
    const dr = data[i*4]-rM, dg = data[i*4+1]-gM, db = data[i*4+2]-bM;
    const mx = Math.max(data[i*4],data[i*4+1],data[i*4+2]), mn = Math.min(data[i*4],data[i*4+1],data[i*4+2]);
    sal[i] = Math.sqrt(dr*dr+dg*dg+db*db) + (mx===0?0:(mx-mn)/mx)*80;
  }
  return sal;
}

function findSalientRegion(sal, w, h, thr) {
  const sorted = [...sal].sort((a,b) => b-a);
  const cut = sorted[Math.floor(sorted.length*(1-thr))]||0;
  let x1=w,x2=0,y1=h,y2=0;
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) if(sal[y*w+x]>=cut){if(x<x1)x1=x;if(x>x2)x2=x;if(y<y1)y1=y;if(y>y2)y2=y;}
  const p=Math.min(w,h)*0.03;
  return {x:Math.max(0,x1-p),y:Math.max(0,y1-p),w:Math.min(w,x2+p)-Math.max(0,x1-p),h:Math.min(h,y2+p)-Math.max(0,y1-p)};
}

function detectLogoRegion(imgData, w, h) {
  const corners=[{x:0,y:0},{x:w*.7,y:0},{x:0,y:h*.7},{x:w*.7,y:h*.7}];
  const rw=w*.3,rh=h*.3; let best=corners[0],bv=0; const d=imgData.data;
  for(const c of corners){let s=0,sq=0,n=0;for(let y=Math.floor(c.y);y<Math.min(c.y+rh,h);y+=3)for(let x=Math.floor(c.x);x<Math.min(c.x+rw,w);x+=3){const i=(y*w+x)*4,l=d[i]*.299+d[i+1]*.587+d[i+2]*.114;s+=l;sq+=l*l;n++;}const v=sq/n-(s/n)**2;if(v>bv){bv=v;best=c;}}
  return {x:best.x,y:best.y,w:rw,h:rh};
}

function findAuxRegion(sal, mainBBox, w, h) {
  return (mainBBox.y+mainBBox.h/2 < h*.5) ? {x:w*.1,y:h*.6,w:w*.8,h:h*.35} : {x:w*.1,y:h*.05,w:w*.8,h:h*.3};
}

function calcConfidence(sal, bbox, w) {
  let s=0,n=0;for(let y=Math.floor(bbox.y);y<bbox.y+bbox.h&&y<sal.length/w;y+=2)for(let x=Math.floor(bbox.x);x<bbox.x+bbox.w&&x<w;x+=2){s+=sal[y*w+x];n++;}
  return Math.min(0.95,Math.max(0.3,(s/n)/150));
}

function cropToThumbFromCanvas(canvas, bbox, thumbId, label, confidence) {
  const sx = Math.max(0, Math.round(bbox.x));
  const sy = Math.max(0, Math.round(bbox.y));
  const sw = Math.max(1, Math.round(bbox.w));
  const sh = Math.max(1, Math.round(bbox.h));
  // ===== Full-resolution crop for composition (preserves alpha) =====
  const fc = document.createElement('canvas');
  fc.width = sw; fc.height = sh;
  const fctx = fc.getContext('2d');
  fctx.clearRect(0, 0, sw, sh);
  fctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  fullResCrops[thumbId] = fc;

  // ===== Small thumbnail for UI display =====
  const maxDim = 192;
  const ratio = sw / sh;
  let tw, th;
  if (ratio >= 1) { tw = maxDim; th = Math.round(maxDim / ratio); }
  else { th = maxDim; tw = Math.round(maxDim * ratio); }

  const tc = document.createElement('canvas');
  tc.width = tw; tc.height = th;
  const tctx = tc.getContext('2d');
  tctx.clearRect(0, 0, tw, th);
  tctx.drawImage(fc, 0, 0, tw, th);

  const thumbEl = document.getElementById(thumbId);
  thumbEl.innerHTML = '';
  thumbEl.style.background = 'none';
  thumbEl.dataset.empty = '';
  thumbEl.classList.add('has-checkerboard');

  tc.style.maxWidth = '100%';
  tc.style.maxHeight = '100%';
  tc.style.borderRadius = '4px';
  thumbEl.appendChild(tc);

  // Add confidence tag to parent element-item
  const item = thumbEl.closest('.element-item');
  const existingConf = item.querySelector('.confidence-tag');
  if (existingConf) existingConf.remove();
  const confTag = document.createElement('span');
  const pct = Math.round(confidence * 100);
  confTag.className = 'confidence-tag ' + (pct >= 70 ? 'high' : pct >= 45 ? 'medium' : 'low');
  confTag.textContent = pct + '%';
  item.appendChild(confTag);
}

// ===== Background Removal (edge-color flood fill) =====
function removeBackground(ctx, w, h) {
  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const total = w * h;

  // Sample edge pixels to determine background color
  const edgePixels = [];
  for (let x = 0; x < w; x++) {
    edgePixels.push(x);                       // top row
    edgePixels.push((h - 1) * w + x);         // bottom row
  }
  for (let y = 1; y < h - 1; y++) {
    edgePixels.push(y * w);                    // left col
    edgePixels.push(y * w + (w - 1));          // right col
  }

  // Compute average edge color
  let rSum = 0, gSum = 0, bSum = 0;
  for (const idx of edgePixels) {
    rSum += d[idx * 4];
    gSum += d[idx * 4 + 1];
    bSum += d[idx * 4 + 2];
  }
  const n = edgePixels.length;
  const bgR = rSum / n, bgG = gSum / n, bgB = bSum / n;

  // Determine adaptive threshold based on edge color variance
  let variance = 0;
  for (const idx of edgePixels) {
    const dr = d[idx * 4] - bgR, dg = d[idx * 4 + 1] - bgG, db = d[idx * 4 + 2] - bgB;
    variance += dr * dr + dg * dg + db * db;
  }
  variance = Math.sqrt(variance / n);
  const threshold = Math.max(30, Math.min(80, variance * 1.5 + 25));

  // Flood fill from edges: mark background pixels
  const visited = new Uint8Array(total);
  const isBg = new Uint8Array(total);
  const queue = [];

  // Seed from all edge pixels
  for (const idx of edgePixels) {
    const dr = d[idx * 4] - bgR, dg = d[idx * 4 + 1] - bgG, db = d[idx * 4 + 2] - bgB;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
    if (dist < threshold) {
      queue.push(idx);
      visited[idx] = 1;
      isBg[idx] = 1;
    }
  }

  // BFS flood fill
  while (queue.length > 0) {
    const idx = queue.shift();
    const x = idx % w, y = Math.floor(idx / w);
    const neighbors = [];
    if (x > 0) neighbors.push(idx - 1);
    if (x < w - 1) neighbors.push(idx + 1);
    if (y > 0) neighbors.push(idx - w);
    if (y < h - 1) neighbors.push(idx + w);

    for (const ni of neighbors) {
      if (visited[ni]) continue;
      visited[ni] = 1;
      const dr = d[ni * 4] - bgR, dg = d[ni * 4 + 1] - bgG, db = d[ni * 4 + 2] - bgB;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      if (dist < threshold) {
        isBg[ni] = 1;
        queue.push(ni);
      }
    }
  }

  // Apply: set background pixels to transparent, add soft edge
  for (let i = 0; i < total; i++) {
    if (isBg[i]) {
      d[i * 4 + 3] = 0; // fully transparent
    } else {
      // Soft edge: check if any neighbor is bg
      const x = i % w, y = Math.floor(i / w);
      let nearBg = false;
      if (x > 0 && isBg[i - 1]) nearBg = true;
      if (x < w - 1 && isBg[i + 1]) nearBg = true;
      if (y > 0 && isBg[i - w]) nearBg = true;
      if (y < h - 1 && isBg[i + w]) nearBg = true;
      if (nearBg) {
        d[i * 4 + 3] = Math.round(d[i * 4 + 3] * 0.6); // semi-transparent edge
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

// ===== Tesseract.js OCR =====
async function runOCR() {
  const img = uploadedImage;
  // Draw image to canvas for Tesseract
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d').drawImage(img, 0, 0);

  updateProgress(30, '正在載入 OCR 引擎...');

  const result = await Tesseract.recognize(c, 'chi_tra+eng', {
    logger: m => {
      if (m.status === 'recognizing text') {
        const pct = 30 + Math.round(m.progress * 60);
        updateProgress(pct, `文字辨識中 ${Math.round(m.progress * 100)}%...`);
      }
    }
  });

  updateProgress(92, '正在分類文字...');
  await delay(200);

  classifyTextBySize(result.data);
}

function classifyTextBySize(ocrData) {
  if (!ocrData || !ocrData.lines || ocrData.lines.length === 0) {
    ocrStatus.querySelector('span').textContent = '未偵測到文字';
    return;
  }

  // Collect lines with their bounding box heights (proxy for font size)
  const lines = ocrData.lines
    .filter(l => l.text.trim().length > 0 && l.confidence > 30)
    .map(l => ({
      text: l.text.trim(),
      height: l.bbox.y1 - l.bbox.y0,
      confidence: l.confidence,
      y: l.bbox.y0
    }))
    .sort((a, b) => b.height - a.height); // sort by size descending

  if (lines.length === 0) {
    ocrStatus.querySelector('span').textContent = '未偵測到有效文字';
    return;
  }

  // Classify: largest → 標題, 2nd → 次標題, medium → 說明文字, smallest → 註釋文字
  const heights = lines.map(l => l.height);
  const maxH = Math.max(...heights);
  const minH = Math.min(...heights);
  const range = maxH - minH || 1;

  const buckets = { title: [], subtitle: [], body: [], note: [] };

  for (const line of lines) {
    const ratio = (line.height - minH) / range;
    if (ratio > 0.7) buckets.title.push(line);
    else if (ratio > 0.4) buckets.subtitle.push(line);
    else if (ratio > 0.15) buckets.body.push(line);
    else buckets.note.push(line);
  }

  // If only 1-2 lines, distribute differently
  if (lines.length === 1) {
    buckets.title = [lines[0]];
    buckets.subtitle = []; buckets.body = []; buckets.note = [];
  } else if (lines.length === 2) {
    buckets.title = [lines[0]];
    buckets.subtitle = [lines[1]];
    buckets.body = []; buckets.note = [];
  }

  // Fill inputs
  fillTextInput('txtTitle', buckets.title);
  fillTextInput('txtSubtitle', buckets.subtitle);
  fillTextInput('txtDesc', buckets.body);
  fillTextInput('txtNote', buckets.note);
}

function fillTextInput(inputId, lines) {
  const input = document.getElementById(inputId);
  if (lines.length > 0) {
    // Sort by Y position (top to bottom), strip spaces and join
    const sorted = lines.sort((a, b) => a.y - b.y);
    input.value = sorted.map(l => l.text.replace(/\s+/g, '')).join('');
    input.style.color = '';
  } else {
    input.value = '';
    input.placeholder = '未偵測到對應文字';
  }
}

// ===== Section 3: AI Image Generation (Puter.js + Nano Banana) =====
const aiGenerateBtn = document.getElementById('aiGenerateBtn');
const refineBtn = document.getElementById('refineBtn');

// recomposeBtn: only generate prompt, scroll to Section 3 for user to pick model
const recomposeBtn = document.getElementById('recomposeBtn');

recomposeBtn.addEventListener('click', () => {
  document.getElementById('aiPrompt').value = buildAIPrompt();
  document.getElementById('sec3').scrollIntoView({ behavior: 'smooth' });
});

aiGenerateBtn.addEventListener('click', () => startAIGenerate());
refineBtn.addEventListener('click', () => refineAIImage());

// Enter key in refine input
document.getElementById('refinePrompt').addEventListener('keydown', e => {
  if (e.key === 'Enter') refineBtn.click();
});

// ===== Section 3: Save & Go Resize buttons =====
let saveImageCounter = 0;
let saveFolderHandle = null; // File System Access API directory handle

document.getElementById('saveImageBtn').addEventListener('click', async () => {
  if (!lastAIGeneratedBase64) return alert('尚未生成廣宣圖');

  // Build folder name: 廣宣生成_YYYYMMDD_HHmmss
  const now = new Date();
  const pad = (n, d = 2) => String(n).padStart(d, '0');
  const folderName = `廣宣生成_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  saveImageCounter++;
  const fileName = `廣宣生成aimages-${saveImageCounter}.png`;

  // Convert base64 to blob
  const res = await fetch(lastAIGeneratedBase64);
  const blob = await res.blob();

  // Try File System Access API (Chrome/Edge) to save to desktop folder
  try {
    if ('showDirectoryPicker' in window) {
      if (!saveFolderHandle) {
        const desktopHandle = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'desktop' });
        saveFolderHandle = await desktopHandle.getDirectoryHandle(folderName, { create: true });
      }
      const fileHandle = await saveFolderHandle.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      alert(`已儲存：${fileName}`);
      return;
    }
  } catch (e) {
    // User cancelled or API not supported — fallback to download
    if (e.name === 'AbortError') { saveImageCounter--; return; }
    console.warn('File System Access fallback:', e);
  }

  // Fallback: regular download
  const a = document.createElement('a');
  a.href = lastAIGeneratedBase64;
  a.download = fileName;
  a.click();
});

document.getElementById('goResizeBtn').addEventListener('click', () => {
  ['sec1', 'sec2', 'sec3'].forEach(id => {
    document.getElementById(id).classList.add('locked');
  });
  const actions = document.getElementById('sec3Actions');
  if (actions) actions.style.pointerEvents = 'auto';
  document.getElementById('unlockBtn').style.display = 'inline-flex';

  // Show Section 3 result as default source preview
  updateSec4DefaultPreview();

  document.getElementById('sec4').scrollIntoView({ behavior: 'smooth' });
});

document.getElementById('unlockBtn').addEventListener('click', () => {
  ['sec1', 'sec2', 'sec3'].forEach(id => {
    document.getElementById(id).classList.remove('locked');
  });
  document.getElementById('unlockBtn').style.display = 'none';
  document.getElementById('sec2').scrollIntoView({ behavior: 'smooth' });
});

// Gather all text fields + styles from Section 2
function gatherTexts() {
  return {
    title:    { text: document.getElementById('txtTitle').value.trim(),    weight: document.getElementById('weightTitle').value,    color: document.getElementById('colorTitle').value,    shadow: document.getElementById('shadowTitle').checked },
    subtitle: { text: document.getElementById('txtSubtitle').value.trim(), weight: document.getElementById('weightSubtitle').value, color: document.getElementById('colorSubtitle').value, shadow: document.getElementById('shadowSubtitle').checked },
    desc:     { text: document.getElementById('txtDesc').value.trim(),     weight: document.getElementById('weightDesc').value,     color: document.getElementById('colorDesc').value,     shadow: document.getElementById('shadowDesc').checked },
    note:     { text: document.getElementById('txtNote').value.trim(),     weight: document.getElementById('weightNote').value,     color: document.getElementById('colorNote').value,     shadow: document.getElementById('shadowNote').checked },
    date:     { text: document.getElementById('txtDate').value.trim(),     weight: document.getElementById('weightDate').value,     color: document.getElementById('colorDate').value,     shadow: document.getElementById('shadowDate').checked }
  };
}

// Helper: get layer display label
function layerLabel(id) {
  const map = {
    thumbMain: '主視覺圖', thumbTitle: '圖像標題', thumbAux: '輔助圖像',
    thumbLogo: 'Logo標誌', textTitle: '大標題', textSubtitle: '次標題',
    textDesc: '說明文字', textNote: '註釋文字', textDate: '活動日期'
  };
  return map[id] || id;
}

// Extract dominant colors from uploaded image
function getDominantColors() {
  if (!uploadedImage) return [];
  const c = document.createElement('canvas');
  const size = 64; // sample at small size for speed
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.drawImage(uploadedImage, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  const colorCounts = {};
  for (let i = 0; i < data.length; i += 16) { // sample every 4th pixel
    const r = Math.round(data[i] / 32) * 32;
    const g = Math.round(data[i+1] / 32) * 32;
    const b = Math.round(data[i+2] / 32) * 32;
    const key = `${r},${g},${b}`;
    colorCounts[key] = (colorCounts[key] || 0) + 1;
  }
  return Object.entries(colorCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([c]) => `rgb(${c})`);
}

// Describe color in human-readable words
function describeColor(hex) {
  const r = parseInt(hex.slice(1,3), 16), g = parseInt(hex.slice(3,5), 16), b = parseInt(hex.slice(5,7), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  if (brightness > 220) return 'white';
  if (brightness < 35) return 'black';
  if (r > 180 && g < 100 && b < 100) return 'red';
  if (r > 180 && g > 150 && b < 80) return 'yellow/gold';
  if (r < 80 && g < 80 && b > 150) return 'blue';
  if (r < 80 && g > 150 && b < 80) return 'green';
  if (brightness > 160) return 'light-colored';
  return 'dark-colored';
}

// Build AI prompt — ONLY visual/color/theme, absolutely NO text content
function buildAIPrompt() {
  const parts = [];

  // Core instruction — only positive visual descriptions, never mention "text/words/letters"
  parts.push('Create a clean 1:1 square background image (1024x1024).');
  parts.push('Pure abstract visual design: only colors, gradients, shapes, light, and shadow.');

  // Theme from detected objects
  if (lastDetections.length > 0) {
    const objectNames = [...new Set(lastDetections.map(d => d.label))].slice(0, 5);
    parts.push(`Visual theme: ${objectNames.join(', ')}.`);
  }

  // Dominant color palette from source image
  const colors = getDominantColors();
  if (colors.length > 0) {
    parts.push(`Color palette: ${colors.join(', ')}.`);
  }

  // Background color if user set one
  const bgColor = document.getElementById('bgColorPicker').value;
  if (bgColor && bgColor !== '#1a1a2e') {
    parts.push(`Dominant tone: ${describeColor(bgColor)}.`);
  }

  // Style — only positive visual descriptions
  parts.push('Style: clean, modern graphic design background with smooth gradients, abstract shapes, bokeh, or soft photography.');
  parts.push('Keep large open empty areas. Visually striking but minimal and uncluttered.');

  return parts.join('\n');
}

// Helper: load a data URL image into a Canvas element
function loadImageToCanvas(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth || img.width;
      c.height = img.naturalHeight || img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => reject(new Error('AI 背景圖載入失敗'));
    img.src = dataUrl;
  });
}

// Create a reference collage from all Section 2 image elements for Vision analysis
function createReferenceCollage() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 1024;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(0, 0, 1024, 1024);

  const elements = [];
  ['thumbBg', 'thumbMain', 'thumbTitle', 'thumbAux', 'thumbLogo'].forEach(id => {
    const el = document.getElementById(id);
    if (fullResCrops[id] && el && el.dataset.empty !== 'true') {
      elements.push(fullResCrops[id]);
    }
  });

  if (elements.length === 0 && uploadedImage) {
    // Fallback: use the uploaded original image
    drawCover(ctx, uploadedImage, 0, 0, 1024, 1024);
  } else if (elements.length > 0) {
    // Arrange elements in a grid so Vision model sees all of them
    const cols = Math.ceil(Math.sqrt(elements.length));
    const rows = Math.ceil(elements.length / cols);
    const cellW = Math.floor(1024 / cols);
    const cellH = Math.floor(1024 / rows);
    elements.forEach((canvas, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      drawCover(ctx, canvas, col * cellW + 2, row * cellH + 2, cellW - 4, cellH - 4);
    });
  }

  return c.toDataURL('image/jpeg', 0.8);
}

// Use Together AI Vision model to analyze image elements → detailed description
async function analyzeImageElements(collageBase64) {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) return '';

  const res = await fetch('https://api.together.xyz/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'meta-llama/Llama-3.2-11B-Vision-Instruct-Turbo',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Describe ONLY the visual design elements of this image: colors, color gradients, shapes, objects, patterns, textures, mood, lighting, composition, and visual style. Skip any written content entirely — focus purely on the visual aesthetics. Be specific and concise (under 120 words).'
          },
          {
            type: 'image_url',
            image_url: { url: collageBase64 }
          }
        ]
      }],
      max_tokens: 300
    })
  });

  if (!res.ok) {
    console.warn('Vision analysis failed:', res.status);
    return '';
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || '';
  // Post-process: strip any sentences that mention text/words/letters/characters
  return stripTextReferences(raw);
}

// Remove sentences from vision description that reference text, words, or characters
function stripTextReferences(desc) {
  if (!desc) return '';
  // Split into sentences
  const sentences = desc.split(/(?<=[.!?;])\s+/);
  const textPatterns = /\b(text|word|letter|character|typograph|font|caption|title|heading|slogan|label|banner text|written|reads?|says?|spell|quot|inscri|numer|digit|number|alphabet|script)\b/i;
  // Also match quoted content like "SALE", 'Hello', etc.
  const quotedPattern = /["'"'「」『』【】].{1,30}["'"'「」『』【】]/;
  const filtered = sentences.filter(s => !textPatterns.test(s) && !quotedPattern.test(s));
  return filtered.join(' ').trim();
}

// ===== Together AI — Free Image Generation (FLUX.1-schnell-Free) =====
// Docs: https://docs.together.ai/docs/images-overview
// Free signup: https://api.together.xyz/settings/api-keys

let lastAIPrompt = '';

// API key: persist in localStorage
const apiKeyInput = document.getElementById('togetherApiKey');
const toggleKeyBtn = document.getElementById('toggleKeyBtn');
apiKeyInput.value = localStorage.getItem('together_api_key') || '';
apiKeyInput.addEventListener('change', () => {
  localStorage.setItem('together_api_key', apiKeyInput.value.trim());
});
toggleKeyBtn.addEventListener('click', () => {
  const isHidden = apiKeyInput.type === 'password';
  apiKeyInput.type = isHidden ? 'text' : 'password';
  toggleKeyBtn.textContent = isHidden ? '隱藏' : '顯示';
});

// Call Together AI image generation API
async function callTogetherAI(prompt, model) {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) throw new Error('請先輸入 Together AI API Key');

  const res = await fetch('https://api.together.xyz/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      prompt,
      width: 1024,
      height: 1024,
      steps: 4,
      n: 1,
      response_format: 'b64_json'
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `API 錯誤 ${res.status}`);
  }

  const data = await res.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('API 未回傳圖像資料');
  return 'data:image/png;base64,' + b64;
}

// Main generation flow
async function startAIGenerate() {
  const model = document.getElementById('modelSelect').value;
  const previewBox = document.getElementById('aiPreviewBox');

  // === Mode: No AI — direct canvas composition ===
  if (model === 'none') {
    previewBox.innerHTML = '<div class="spinner-large"></div><span class="loading-text">正在組合圖像元素...</span>';
    aiGenerateBtn.classList.add('generating');
    aiGenerateBtn.innerHTML = '<div class="spinner"></div> 組合中...';
    await new Promise(r => setTimeout(r, 50));

    try {
      const texts = gatherTexts();
      const compositeCanvas = composeImage(1024, 1024, texts, fullResCrops, null);
      const dataUrl = compositeCanvas.toDataURL('image/png');
      const imgElement = new Image();
      imgElement.src = dataUrl;
      previewBox.innerHTML = '';
      previewBox.appendChild(imgElement);
      lastAIGeneratedBase64 = dataUrl;
      lastAIBgBase64 = null;
      document.getElementById('refineRow').style.display = 'none';
      document.getElementById('sec3Actions').style.display = 'flex';
    } catch (err) {
      console.error('[Compose] error:', err);
      previewBox.innerHTML = `<span class="ai-placeholder">組合失敗：${err.message}</span>`;
    }

    aiGenerateBtn.classList.remove('generating');
    aiGenerateBtn.innerHTML = '生成廣宣圖';
    return;
  }

  // === Mode: AI background generation (3 steps) ===
  const promptEl = document.getElementById('aiPrompt');
  if (!promptEl.value.trim()) promptEl.value = buildAIPrompt();
  const finalPrompt = promptEl.value.trim();
  if (!finalPrompt) return alert('請輸入或自動產生提示詞');

  aiGenerateBtn.classList.add('generating');
  aiGenerateBtn.innerHTML = '<div class="spinner"></div> AI 生成中...';

  try {
    // Step 1: Vision model analyzes all image elements
    previewBox.innerHTML = '<div class="spinner-large"></div><span class="loading-text">Step 1/3：AI 正在分析圖像元素...</span>';
    const collageBase64 = createReferenceCollage();
    let visionDesc = '';
    try {
      visionDesc = await analyzeImageElements(collageBase64);
      console.log('[Vision] description:', visionDesc);
    } catch (e) {
      console.warn('[Vision] analysis skipped:', e);
    }

    // Step 2: Combine vision description + user prompt → generate background
    previewBox.innerHTML = '<div class="spinner-large"></div><span class="loading-text">Step 2/3：AI 正在生成背景圖...</span>';
    let imagePrompt = finalPrompt;
    if (visionDesc) {
      imagePrompt = `Visual reference (colors, shapes, mood only): ${visionDesc}\n\n${finalPrompt}`;
    }
    lastAIPrompt = imagePrompt;

    const bgDataUrl = await callTogetherAI(imagePrompt, model);
    const aiBgCanvas = await loadImageToCanvas(bgDataUrl);

    // Step 3: Composite — overlay text elements on AI background
    previewBox.innerHTML = '<div class="spinner-large"></div><span class="loading-text">Step 3/3：正在疊加文字元素...</span>';
    await new Promise(r => setTimeout(r, 100));

    const compositeCanvas = compositeAIWithElements(aiBgCanvas, 1024, 1024);

    // Display composite result
    const dataUrl = compositeCanvas.toDataURL('image/png');
    const imgElement = new Image();
    imgElement.src = dataUrl;
    previewBox.innerHTML = '';
    previewBox.appendChild(imgElement);

    lastAIGeneratedBase64 = dataUrl;
    lastAIBgBase64 = bgDataUrl;
    document.getElementById('refineRow').style.display = 'flex';
    document.getElementById('sec3Actions').style.display = 'flex';
  } catch (err) {
    console.error('[AI Gen] error:', err);
    previewBox.innerHTML = `<span class="ai-placeholder">AI 生成失敗：${err.message}</span>`;
  }

  aiGenerateBtn.classList.remove('generating');
  aiGenerateBtn.innerHTML = '生成廣宣圖';
}

// Composite: draw AI background + overlay all Section 2 elements (images + text)
function compositeAIWithElements(aiBgCanvas, tw, th) {
  const canvas = document.createElement('canvas');
  canvas.width = tw; canvas.height = th;
  const ctx = canvas.getContext('2d');

  // Layer 1: AI-generated background (fills entire canvas)
  drawCover(ctx, aiBgCanvas, 0, 0, tw, th);

  // Prepare text data
  const texts = gatherTexts();
  const base = Math.min(tw, th) * 0.028;
  const fontSizes = {
    note:     Math.round(base),
    date:     Math.round(base * PHI * 0.8),
    desc:     Math.round(base * PHI),
    subtitle: Math.round(base * PHI * PHI),
    title:    Math.round(base * PHI * PHI * PHI)
  };
  const isPortrait = th > tw * 1.2;
  const isLandscape = tw > th * 1.2;
  const isSquare = !isPortrait && !isLandscape;
  const textShift = isPortrait ? 0 : th * 0.10;

  // Default offsets — thumbMain scaled down to 60% so AI background remains visible
  const defaultOffsets = {
    thumbMain: { dx: 0, dy: 0, scale: 0.6 },
    logo: { dx: 0, dy: 0, scale: 2 },
    thumbTitle: { dx: 0, dy: 0, scale: 1 },
    thumbAux: { dx: 0, dy: 0, scale: 1 },
    title: { dx: 0, dy: 0 },
    subtitle: { dx: 0, dy: 0 },
    desc: { dx: 0, dy: 0 },
    note: { dx: 0, dy: 0 },
    date: { dx: 0, dy: 0 }
  };

  // Use fullResCrops for image elements but skip thumbBg (AI already provides the bg)
  // Also skip thumbMain — the AI background IS the main visual; we don't want the original
  // uploaded image covering the AI art. Logo, title image, and aux image are kept.
  const crops = { ...fullResCrops };
  delete crops.thumbBg;
  delete crops.thumbMain; // AI background replaces the main visual

  const params = { tw, th, crops, offsets: defaultOffsets, isPortrait, isLandscape, isSquare, texts, fontSizes, textShift };

  // Layer 2+: overlay smaller image elements (logo, title img, aux img) and all text
  for (const layerId of layerOrder) {
    drawLayer(ctx, layerId, params);
  }

  return canvas;
}

// Refine: default = re-composite text on existing AI bg (fast, no API call)
// Only regenerate AI background when input contains "重新生成背景"
async function refineAIImage() {
  const modification = document.getElementById('refinePrompt').value.trim();
  if (!modification) return alert('請輸入修改指令');

  const previewBox = document.getElementById('aiPreviewBox');
  const savedHTML = previewBox.innerHTML;
  const needRegenBg = /重新生成背景/.test(modification);

  refineBtn.disabled = true;
  refineBtn.textContent = '修改中...';

  try {
    if (needRegenBg && lastAIBgBase64) {
      // === Regenerate AI background ===
      const model = document.getElementById('modelSelect').value;
      if (model === 'none') throw new Error('目前模式為不使用 AI 背景，無法重新生成');

      const cleanMod = modification.replace(/重新生成背景[圖]?[，,]?/g, '').trim();
      const combinedPrompt = lastAIPrompt
        ? `${lastAIPrompt}\n\nAdditional modification: ${cleanMod || 'regenerate with a fresh style'}.`
        : lastAIPrompt;

      previewBox.innerHTML = '<div class="spinner-large"></div><span class="loading-text">AI 正在重新生成背景圖...</span>';

      const bgDataUrl = await callTogetherAI(combinedPrompt, model);
      const aiBgCanvas = await loadImageToCanvas(bgDataUrl);
      const compositeCanvas = compositeAIWithElements(aiBgCanvas, 1024, 1024);
      const dataUrl = compositeCanvas.toDataURL('image/png');

      const imgElement = new Image();
      imgElement.src = dataUrl;
      previewBox.innerHTML = '';
      previewBox.appendChild(imgElement);

      lastAIPrompt = combinedPrompt;
      lastAIGeneratedBase64 = dataUrl;
      lastAIBgBase64 = bgDataUrl;
    } else if (lastAIBgBase64) {
      // === Re-composite only (fast, no API call) ===
      previewBox.innerHTML = '<div class="spinner-large"></div><span class="loading-text">正在重新疊合元素...</span>';
      await new Promise(r => setTimeout(r, 50));

      const aiBgCanvas = await loadImageToCanvas(lastAIBgBase64);
      const compositeCanvas = compositeAIWithElements(aiBgCanvas, 1024, 1024);
      const dataUrl = compositeCanvas.toDataURL('image/png');

      const imgElement = new Image();
      imgElement.src = dataUrl;
      previewBox.innerHTML = '';
      previewBox.appendChild(imgElement);

      lastAIGeneratedBase64 = dataUrl;
    } else {
      throw new Error('尚未生成 AI 背景，請先點擊生成廣宣圖');
    }

    document.getElementById('refinePrompt').value = '';
  } catch (err) {
    console.error('[AI Refine] error:', err);
    previewBox.innerHTML = savedHTML;
    alert('修改失敗：' + err.message);
  }

  refineBtn.disabled = false;
  refineBtn.textContent = '修改';
}

// LINE Seed font family string
const FONT_STACK = '"LINE Seed JP", "Noto Sans TC", "PingFang TC", sans-serif';

// Golden ratio (1.618) modular scale for text hierarchy
const PHI = 1.618;

// Helper: draw source canvas into destination, covering the area while preserving aspect ratio
function drawCover(ctx, src, dx, dy, dw, dh) {
  const sw = src.width, sh = src.height;
  const srcRatio = sw / sh, dstRatio = dw / dh;
  let cropW, cropH, cropX, cropY;
  if (srcRatio > dstRatio) {
    cropH = sh; cropW = sh * dstRatio;
    cropX = (sw - cropW) / 2; cropY = 0;
  } else {
    cropW = sw; cropH = sw / dstRatio;
    cropX = 0; cropY = (sh - cropH) / 2;
  }
  ctx.drawImage(src, cropX, cropY, cropW, cropH, dx, dy, dw, dh);
}

// Helper: draw source canvas fitted inside area while preserving aspect ratio (contain)
function drawContain(ctx, src, dx, dy, dw, dh) {
  const sw = src.width, sh = src.height;
  const scale = Math.min(dw / sw, dh / sh);
  const rw = sw * scale, rh = sh * scale;
  const rx = dx + (dw - rw) / 2, ry = dy + (dh - rh) / 2;
  ctx.drawImage(src, 0, 0, sw, sh, rx, ry, rw, rh);
}

// Draw a single layer (image or text) by its layerId
function drawLayer(ctx, layerId, p) {
  const { tw, th, crops, offsets, isPortrait, isLandscape, isSquare, texts, fontSizes, textShift } = p;
  switch (layerId) {
    // ===== Image layers =====
    case 'thumbMain':
      if (crops.thumbMain) {
        const mScale = offsets.thumbMain ? (offsets.thumbMain.scale || 1) : 1;
        const mw = tw * mScale, mh = th * mScale;
        const mx = (tw - mw) / 2 + tw * (offsets.thumbMain ? offsets.thumbMain.dx : 0) / 100;
        const my = (th - mh) / 2 + th * (offsets.thumbMain ? offsets.thumbMain.dy : 0) / 100;
        drawCover(ctx, crops.thumbMain, mx, my, mw, mh);
      }
      break;
    case 'thumbTitle':
      if (crops.thumbTitle) {
        const tScale = offsets.thumbTitle.scale || 1;
        let tx, ty, tsw, tsh;
        if (isPortrait) { tsw = tw * 0.30; tsh = th * 0.08; tx = (tw - tsw) / 2; ty = th * 0.47; }
        else if (isLandscape) { tsw = tw * 0.22; tsh = th * 0.12; tx = tw * 0.58; ty = th * 0.06; }
        else { tsw = tw * 0.28; tsh = th * 0.10; tx = (tw - tsw) / 2; ty = th * 0.53; }
        const tswS = tsw * tScale, tshS = tsh * tScale;
        tx += (tsw - tswS) / 2 + tw * offsets.thumbTitle.dx / 100;
        ty += (tsh - tshS) / 2 + th * offsets.thumbTitle.dy / 100;
        drawContain(ctx, crops.thumbTitle, tx, ty, tswS, tshS);
      }
      break;
    case 'thumbAux':
      if (crops.thumbAux) {
        const aScale = offsets.thumbAux.scale || 1;
        let ax, ay, asw, ash;
        if (isPortrait) { asw = tw * 0.22; ash = tw * 0.22; ax = tw * 0.74; ay = th * 0.40; }
        else if (isLandscape) { asw = tw * 0.14; ash = tw * 0.14; ax = tw * 0.82; ay = th * 0.04; }
        else { asw = tw * 0.18; ash = tw * 0.18; ax = tw * 0.78; ay = th * 0.36; }
        const aswS = asw * aScale, ashS = ash * aScale;
        ax += (asw - aswS) / 2 + tw * offsets.thumbAux.dx / 100;
        ay += (ash - ashS) / 2 + th * offsets.thumbAux.dy / 100;
        drawContain(ctx, crops.thumbAux, ax, ay, aswS, ashS);
      }
      break;
    case 'thumbLogo':
      if (crops.thumbLogo) {
        const logoScale = offsets.logo.scale || 1;
        const logoMax = Math.round(Math.min(tw, th) * 0.30 * logoScale);
        const lRatio = crops.thumbLogo.width / crops.thumbLogo.height;
        let lw, lh;
        if (lRatio >= 1) { lw = logoMax; lh = Math.round(logoMax / lRatio); }
        else { lh = logoMax; lw = Math.round(logoMax * lRatio); }
        // Force logo height to exactly 100px
        if (lh !== 100) { lw = Math.round(100 * lRatio); lh = 100; }
        const lx = (tw - lw) / 2 + tw * offsets.logo.dx / 100;
        const ly = (th * 0.28 - lh) / 2 - th * 0.04 + th * offsets.logo.dy / 100;

        const logoInvert = document.getElementById('logoInvert')?.checked;
        if (logoInvert) {
          // Draw inverted (white) logo: use off-screen canvas with invert filter
          const tmp = document.createElement('canvas');
          tmp.width = crops.thumbLogo.width; tmp.height = crops.thumbLogo.height;
          const tctx = tmp.getContext('2d');
          tctx.filter = 'invert(1)';
          tctx.drawImage(crops.thumbLogo, 0, 0);
          tctx.filter = 'none';
          ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, lx, ly, lw, lh);
        } else {
          ctx.drawImage(crops.thumbLogo, 0, 0, crops.thumbLogo.width, crops.thumbLogo.height, lx, ly, lw, lh);
        }
      }
      break;
    // ===== Text layers =====
    case 'textTitle':
    case 'textSubtitle':
    case 'textDesc':
    case 'textNote':
    case 'textDate':
      drawTextLayer(ctx, layerId, p);
      break;
  }
}

// Draw a single text element as a layer
function drawTextLayer(ctx, layerId, p) {
  const { tw, th, offsets, isPortrait, texts, fontSizes, textShift } = p;
  const keyMap = { textTitle: 'title', textSubtitle: 'subtitle', textDesc: 'desc', textNote: 'note', textDate: 'date' };
  const key = keyMap[layerId];
  const td = texts[key];
  if (!td || !td.text) return;

  const baseTextX = tw / 2;
  const maxTextW = tw * 0.85;
  const o = offsets[key] || { dx: 0, dy: 0 };
  let x, y, fs, dw, sb;

  switch (key) {
    case 'title':
      y = th * 0.28 + textShift + th * o.dy / 100;
      x = baseTextX + tw * o.dx / 100;
      fs = fontSizes.title; dw = 800; sb = 12;
      break;
    case 'subtitle': {
      const stBaseY = th * 0.28 + fontSizes.title * 1.3 + textShift;
      y = stBaseY + th * o.dy / 100;
      x = baseTextX + tw * o.dx / 100;
      fs = fontSizes.subtitle; dw = 700; sb = 10;
      break;
    }
    case 'desc': {
      const stBaseY2 = th * 0.28 + fontSizes.title * 1.3 + textShift;
      const dBaseY = isPortrait ? th * 0.40 : stBaseY2 + fontSizes.subtitle + th * 0.10;
      y = dBaseY + th * o.dy / 100;
      x = baseTextX + tw * o.dx / 100;
      fs = fontSizes.desc; dw = 400; sb = 6;
      break;
    }
    case 'note':
      y = th - 60 + th * o.dy / 100;
      x = baseTextX + tw * o.dx / 100;
      fs = fontSizes.note; dw = 400; sb = 3;
      break;
    case 'date':
      y = th * 0.28 + textShift - th * 0.10 - (isPortrait ? 0 : th * 0.05) + th * o.dy / 100;
      x = baseTextX + tw * o.dx / 100;
      fs = fontSizes.date; dw = 700; sb = 4;
      break;
    default: return;
  }

  if (td.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = sb; ctx.shadowOffsetX = 1; ctx.shadowOffsetY = 2; }
  ctx.textAlign = 'center';
  ctx.fillStyle = td.color || '#FFFFFF';
  ctx.font = `${td.weight || dw} ${fs}px ${FONT_STACK}`;
  ctx.fillText(td.text, x, y, maxTextW);
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
}

function composeImage(tw, th, texts, crops, offsets) {
  if (!offsets) offsets = { thumbMain:{dx:0,dy:0,scale:1}, logo:{dx:0,dy:0,scale:1}, thumbTitle:{dx:0,dy:0,scale:1}, thumbAux:{dx:0,dy:0,scale:1}, title:{dx:0,dy:0}, subtitle:{dx:0,dy:0}, desc:{dx:0,dy:0}, note:{dx:0,dy:0}, date:{dx:0,dy:0} };
  const canvas = document.createElement('canvas');
  canvas.width = tw; canvas.height = th;
  const ctx = canvas.getContext('2d');
  const isPortrait = th > tw * 1.2;
  const isLandscape = tw > th * 1.2;
  const isSquare = !isPortrait && !isLandscape;

  // ===== Layer 1: Background (背景圖) — full bleed =====
  if (crops.thumbBg) {
    drawCover(ctx, crops.thumbBg, 0, 0, tw, th);
  } else {
    // Fallback gradient
    const g = ctx.createLinearGradient(0, 0, tw, th);
    g.addColorStop(0, '#1a1a2e'); g.addColorStop(1, '#16213e');
    ctx.fillStyle = g; ctx.fillRect(0, 0, tw, th);
  }

  // ===== 計算文字參數 =====
  const base = Math.min(tw, th) * 0.028;
  const fontSizes = {
    note:     Math.round(base),
    date:     Math.round(base * PHI * 0.8),
    desc:     Math.round(base * PHI),
    subtitle: Math.round(base * PHI * PHI),
    title:    Math.round(base * PHI * PHI * PHI)
  };
  const textShift = isPortrait ? 0 : th * 0.10;

  // ===== 按 layerOrder 統一繪製所有元素 =====
  const params = { tw, th, crops, offsets, isPortrait, isLandscape, isSquare, texts, fontSizes, textShift };
  for (const layerId of layerOrder) {
    drawLayer(ctx, layerId, params);
  }

  return canvas;
}

// (Old Section 3 prompt modify removed — now handled by refineAIImage above)

// (Old parsePositionCommands, parsePromptEffects, effect functions, and drawTextOverlay removed — AI handles all modifications now)

// ===== Section 4: Source Image Upload =====
const sec4UploadBtn = document.getElementById('sec4UploadBtn');
const sec4ResetBtn = document.getElementById('sec4ResetBtn');
const sec4FileInput = document.getElementById('sec4FileInput');
const sec4SourceThumb = document.getElementById('sec4SourceThumb');
const sec4SourceName = document.getElementById('sec4SourceName');

// Show Section 3 generated result as default source preview
function updateSec4DefaultPreview() {
  if (sec4SourceImage) return; // custom image uploaded, don't override
  if (lastAIGeneratedBase64) {
    const preview = new Image();
    preview.onload = () => {
      sec4SourceThumb.innerHTML = '';
      sec4SourceThumb.appendChild(preview);
    };
    preview.src = lastAIGeneratedBase64;
    sec4SourceName.textContent = '區塊三廣宣圖';
  } else {
    sec4SourceThumb.innerHTML = '<span class="sec4-source-placeholder">尚未生成廣宣圖</span>';
    sec4SourceName.textContent = '請先在區塊三生成廣宣圖';
  }
}

sec4UploadBtn.addEventListener('click', () => sec4FileInput.click());

sec4FileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) return alert('請上傳圖片檔案');
  const reader = new FileReader();
  reader.onload = ev => {
    const img = new Image();
    img.onload = () => {
      sec4SourceImage = img;
      sec4SourceThumb.innerHTML = '';
      sec4SourceThumb.appendChild(img);
      sec4SourceName.textContent = file.name;
      sec4ResetBtn.style.display = '';
    };
    img.onerror = () => alert('圖片載入失敗，請重新上傳');
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
  sec4FileInput.value = '';
});

sec4ResetBtn.addEventListener('click', () => {
  sec4SourceImage = null;
  updateSec4DefaultPreview();
  sec4ResetBtn.style.display = 'none';
});

// ===== Section 4: Size Management =====
const addSizeBtn = document.getElementById('addSizeBtn');
const widthInput = document.getElementById('widthInput');
const heightInput = document.getElementById('heightInput');
const addedList = document.getElementById('addedList');

addSizeBtn.addEventListener('click', () => {
  const w = parseInt(widthInput.value);
  const h = parseInt(heightInput.value);
  if (!w || !h || w <= 0 || h <= 0) return alert('請輸入有效的寬度和高度');
  customSizes.push({ w, h });
  widthInput.value = '';
  heightInput.value = '';
  renderAddedList();
});

function renderAddedList() {
  addedList.innerHTML = customSizes.map((s, i) => {
    const escapedName = (s.name || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `
    <div class="added-item">
      <span class="added-dims">${s.w} × ${s.h}</span>
      <input class="input-field added-name-input" placeholder="自訂名稱" value="${escapedName}" data-idx="${i}">
      <button class="save-to-preset-btn" data-idx="${i}" title="儲存到常用">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
      </button>
      <button class="remove-btn" data-idx="${i}" title="移除">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
  }).join('');

  // Sync name edits back to customSizes
  addedList.querySelectorAll('.added-name-input').forEach(input => {
    input.addEventListener('input', () => {
      const idx = parseInt(input.dataset.idx);
      customSizes[idx].name = input.value;
    });
  });

  // Save to preset list
  addedList.querySelectorAll('.save-to-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      const s = customSizes[idx];
      const name = (s.name || '').trim() || `自訂 ${s.w}×${s.h}`;
      allPresets.push({ w: s.w, h: s.h, name });
      persistPresets();
      renderPresetList();
      // Visual feedback
      btn.style.color = 'var(--primary)';
      btn.title = '已儲存';
      setTimeout(() => { btn.style.color = ''; btn.title = '儲存到常用'; }, 1200);
    });
  });

  // Remove from list
  addedList.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      customSizes.splice(parseInt(btn.dataset.idx), 1);
      renderAddedList();
    });
  });
}

// ===== Preset List (localStorage, unified) =====
const PRESETS_KEY = 'preset_list';
const DEFAULT_PRESETS = [
  { w: 1200, h: 630,  name: 'Facebook 貼文' },
  { w: 1080, h: 1080, name: 'Instagram 貼文' },
  { w: 1080, h: 1920, name: 'Instagram 限動' },
  { w: 1280, h: 720,  name: 'YouTube 縮圖' },
  { w: 1040, h: 1040, name: 'LINE 橫幅' },
  { w: 300,  h: 250,  name: 'Google 廣告' },
  { w: 600,  h: 400,  name: '電子報' }
];

let allPresets;
const storedPresets = localStorage.getItem(PRESETS_KEY);
if (storedPresets) {
  allPresets = JSON.parse(storedPresets);
} else {
  // First load or migration from old key
  const oldSaved = JSON.parse(localStorage.getItem('saved_presets') || '[]');
  allPresets = [...DEFAULT_PRESETS, ...oldSaved];
  localStorage.removeItem('saved_presets');
  localStorage.setItem(PRESETS_KEY, JSON.stringify(allPresets));
}

function persistPresets() {
  localStorage.setItem(PRESETS_KEY, JSON.stringify(allPresets));
}

function renderPresetList() {
  const container = document.getElementById('presetList');
  if (!container) return;
  container.innerHTML = allPresets.map((p, i) => {
    const escapedName = p.name.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return `
    <label class="checkbox-row saved-preset-row">
      <input type="checkbox" data-w="${p.w}" data-h="${p.h}">
      <span class="custom-cb"></span>
      <span class="saved-preset-name">${escapedName}</span>
      <span class="preset-dims">${p.w} × ${p.h}</span>
      <button class="delete-preset-btn" data-idx="${i}" title="刪除">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </label>`;
  }).join('');

  container.querySelectorAll('.delete-preset-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      allPresets.splice(parseInt(btn.dataset.idx), 1);
      persistPresets();
      renderPresetList();
    });
  });

  // Show restore button if any defaults are missing
  const restoreBtn = document.getElementById('restoreDefaultsBtn');
  if (restoreBtn) {
    const hasMissing = DEFAULT_PRESETS.some(d =>
      !allPresets.some(p => p.w === d.w && p.h === d.h)
    );
    restoreBtn.style.display = hasMissing ? '' : 'none';
  }
}

document.getElementById('restoreDefaultsBtn').addEventListener('click', () => {
  DEFAULT_PRESETS.forEach(d => {
    if (!allPresets.some(p => p.w === d.w && p.h === d.h)) {
      allPresets.unshift(d);
    }
  });
  persistPresets();
  renderPresetList();
});

renderPresetList();

// ===== Section 4: Confirm & Execute =====
const confirmBtn = document.getElementById('confirmBtn');
const executeBtn = document.getElementById('executeBtn');

confirmBtn.addEventListener('click', () => {
  const sizes = getSelectedSizes();
  if (sizes.length === 0) return alert('請至少選擇一個尺寸');
  confirmBtn.style.display = 'none';
  executeBtn.style.display = 'inline-flex';
});

executeBtn.addEventListener('click', async () => {
  if (!sec4SourceImage && !lastAIBgBase64 && !Object.keys(fullResCrops).length) {
    return alert('請先在區塊三生成廣宣圖或上傳圖片');
  }
  await generateResults();
});

function getSelectedSizes() {
  const sizes = [];
  document.querySelectorAll('#presetList input:checked').forEach(cb => {
    sizes.push({ w: parseInt(cb.dataset.w), h: parseInt(cb.dataset.h) });
  });
  customSizes.forEach(s => sizes.push(s));
  return sizes;
}

// ===== Section 5: Generate Results =====
async function generateResults() {
  const sizes = getSelectedSizes();
  if (sizes.length === 0) return alert('請至少選擇一個尺寸');

  const sec5 = document.getElementById('sec5');
  const grid = document.getElementById('resultsGrid');
  sec5.style.display = 'flex';
  grid.innerHTML = '';

  // Progress UI
  const savedBtnHTML = executeBtn.innerHTML;
  executeBtn.disabled = true;
  executeBtn.textContent = '生成中...';
  const progressEl = document.getElementById('generateProgress');
  const progressFill = document.getElementById('generateProgressFill');
  const progressText = document.getElementById('generateProgressText');
  progressEl.style.display = 'flex';
  progressFill.style.width = '0%';
  progressText.textContent = `0 / ${sizes.length}`;

  try {
    const baseName = document.getElementById('fileName').textContent.replace(/\.[^.]+$/, '') || 'image';
    const texts = gatherTexts();

    // Determine background source: custom upload > AI background > composeImage fallback
    let bgCanvas = null;
    if (sec4SourceImage) {
      bgCanvas = document.createElement('canvas');
      bgCanvas.width = sec4SourceImage.width;
      bgCanvas.height = sec4SourceImage.height;
      bgCanvas.getContext('2d').drawImage(sec4SourceImage, 0, 0);
    } else if (lastAIBgBase64) {
      bgCanvas = await loadImageToCanvas(lastAIBgBase64);
    }

    const THUMB_MAX = 800;

    for (let i = 0; i < sizes.length; i++) {
      const s = sizes[i];
      let canvas;
      if (bgCanvas) {
        // Use background + re-layout all elements at target size
        canvas = compositeAIWithElements(bgCanvas, s.w, s.h);
      } else {
        // Non-AI mode: compose from original crops + elements
        canvas = composeImage(s.w, s.h, texts, fullResCrops, null);
      }

      const fileName = `${baseName}_${s.w}x${s.h}.png`;

      const item = document.createElement('div');
      item.className = 'result-item';
      item.innerHTML = `
        <div class="result-cb-row"><div class="result-cb checked" data-file="${fileName}"></div></div>
        <div class="result-thumb"></div>
        <span class="result-name">${fileName}</span>
        <span class="result-size">${s.w} × ${s.h}</span>
      `;

      // Downscaled thumbnail for preview (save memory)
      const thumbScale = Math.min(1, THUMB_MAX / Math.max(s.w, s.h));
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = Math.round(s.w * thumbScale);
      thumbCanvas.height = Math.round(s.h * thumbScale);
      thumbCanvas.getContext('2d').drawImage(canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
      item.querySelector('.result-thumb').appendChild(thumbCanvas);

      // Store full-size canvas for export
      item._canvas = canvas;
      item._fileName = fileName;

      const cb = item.querySelector('.result-cb');
      cb.addEventListener('click', () => cb.classList.toggle('checked'));

      grid.appendChild(item);

      // Trigger fade-in animation after DOM append
      item.style.animationDelay = `${i * 80}ms`;
      requestAnimationFrame(() => item.classList.add('fade-in'));

      // Update progress
      const pct = Math.round(((i + 1) / sizes.length) * 100);
      progressFill.style.width = pct + '%';
      progressText.textContent = `${i + 1} / ${sizes.length}`;
      await new Promise(r => setTimeout(r, 0)); // yield to UI
    }

    sec5.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    console.error('[generateResults] error:', err);
    alert('生成失敗：' + err.message);
  } finally {
    // Restore button & hide progress
    executeBtn.disabled = false;
    executeBtn.innerHTML = savedBtnHTML;
    progressEl.style.display = 'none';
  }
}

// ===== Section 5: Select All =====
document.getElementById('selectAll').addEventListener('change', e => {
  document.querySelectorAll('.result-cb').forEach(cb => {
    cb.classList.toggle('checked', e.target.checked);
  });
});

// ===== Section 5: Export ZIP =====
document.getElementById('exportBtn').addEventListener('click', async () => {
  const items = [...document.querySelectorAll('.result-item')].filter(
    item => item.querySelector('.result-cb').classList.contains('checked')
  );
  if (items.length === 0) return alert('請至少勾選一個項目');

  const zip = new JSZip();
  for (const item of items) {
    const blob = await new Promise(resolve => item._canvas.toBlob(resolve, 'image/png'));
    zip.file(item._fileName, blob);
  }

  const content = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(content);
  a.download = '廣宣設計稿_export.zip';
  a.click();
  URL.revokeObjectURL(a.href);
});

// ===== Layer Order Controls =====
function initLayerControls() {
  document.querySelectorAll('.sortable-layer .layer-up').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.sortable-layer');
      const layerId = item.dataset.layer;
      moveLayer(layerId, 'up');
    });
  });
  document.querySelectorAll('.sortable-layer .layer-down').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.sortable-layer');
      const layerId = item.dataset.layer;
      moveLayer(layerId, 'down');
    });
  });
}

function moveLayer(layerId, direction) {
  const idx = layerOrder.indexOf(layerId);
  if (idx === -1) return;
  const newIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (newIdx < 0 || newIdx >= layerOrder.length) return;

  // Swap in layerOrder array
  [layerOrder[idx], layerOrder[newIdx]] = [layerOrder[newIdx], layerOrder[idx]];

  // Swap DOM positions
  const card = document.getElementById('layerCard');
  const items = [...card.querySelectorAll('.sortable-layer')];
  const currentItem = items.find(el => el.dataset.layer === layerId);
  const swapItem = items.find(el => el.dataset.layer === layerOrder[idx]);
  if (currentItem && swapItem) {
    if (direction === 'up') {
      card.insertBefore(currentItem, swapItem);
    } else {
      card.insertBefore(swapItem, currentItem);
    }
  }

  updateLayerNumbers();
}

function updateLayerNumbers() {
  const card = document.getElementById('layerCard');
  const items = card.querySelectorAll('.sortable-layer');
  items.forEach((item, i) => {
    const num = item.querySelector('.layer-num');
    if (num) num.textContent = i + 1; // 從 1 開始
  });
}

initLayerControls();

// ===== Lightbox: click any image to zoom 2x =====
const lightbox = document.createElement('div');
lightbox.className = 'lightbox';
lightbox.innerHTML = '<button class="lightbox-close">&times;</button><div class="lightbox-inner"></div>';
document.body.appendChild(lightbox);

function closeLightbox() { lightbox.classList.remove('active'); }
lightbox.addEventListener('click', closeLightbox);
lightbox.querySelector('.lightbox-close').addEventListener('click', e => { e.stopPropagation(); closeLightbox(); });

// ESC key to close
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

// Delegate click on any img/canvas inside zoomable containers
document.addEventListener('click', e => {
  const t = e.target;
  if (t.tagName !== 'CANVAS' && t.tagName !== 'IMG') return;
  const zoomable = t.closest('.thumb-box, .elem-thumb, .ai-preview-box, .result-thumb');
  if (!zoomable) return;

  e.stopPropagation();
  const inner = lightbox.querySelector('.lightbox-inner');
  inner.innerHTML = '';

  if (t.tagName === 'CANVAS') {
    // Render at 2x the canvas resolution
    const c = document.createElement('canvas');
    c.width = t.width * 2;
    c.height = t.height * 2;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(t, 0, 0, c.width, c.height);
    inner.appendChild(c);
  } else {
    // IMG element: show at 2x display size
    const img = document.createElement('img');
    img.src = t.src;
    inner.appendChild(img);
  }
  lightbox.classList.add('active');
});
