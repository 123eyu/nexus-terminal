/**
 * Nexus Terminal — 浏览器内 DOM 诊断探针（零依赖，可直接 addScriptTag 注入）
 *
 * 设计原则：
 *   浏览器 MCP 的低效来自「LLM 逐步 snapshot + 逐步决策」。
 *   本探针把"什么算异常"编码成可执行的不变量，一次性在页面内算完，
 *   只把「异常清单 + 源文件定位」回传给调用方。
 *   一次 evaluate 取代 5~10 轮 snapshot。
 *
 * 挂载：window.__NEXUS_DOM__
 */
(function (global) {
  if (global.__NEXUS_DOM__ && global.__NEXUS_DOM__.version === '1.0.0') return;

  const VERSION = '1.0.0';
  const MAX_ISSUES = 80;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const trunc = (s, n) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) + '…' : s;
  };

  /* ------------------------------------------------------------------ *
   * 元素 → 选择器 / 组件源文件定位
   * ------------------------------------------------------------------ */

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el === document.body) return 'body';
    if (el.id) return '#' + CSS.escape(el.id);

    const testid = el.getAttribute('data-testid') || el.getAttribute('data-test');
    if (testid) return `[data-testid="${testid}"]`;

    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      let part = node.tagName.toLowerCase();
      const cls = Array.from(node.classList || [])
        .filter((c) => c && !/^(v-|el-|is-|nuxt|vue)/.test(c) || /^el-/.test(c))
        .slice(0, 2);
      if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.');
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (node.id) {
        parts[0] = '#' + CSS.escape(node.id);
        break;
      }
      node = parent;
      depth++;
    }
    return parts.join(' > ');
  }

  /** 从元素向上找到最近的 Vue 组件实例，取出组件名与源文件路径（Vite dev 下可用） */
  function vueInfo(el) {
    let node = el;
    let guard = 0;
    let fallback = null;
    while (node && guard++ < 40) {
      const inst = node.__vueParentComponent;
      if (inst) {
        const type = inst.type || {};
        const file = type.__file || (inst.ctx && inst.ctx.$options && inst.ctx.$options.__file) || null;
        const name = type.__name || type.name || '(Anonymous)';
        if (!fallback) fallback = { component: name, props: safeProps(inst.props) };
        // 内置组件（RouterLink / Transition 等）没有 __file，继续向上找真正的业务组件
        if (file) {
          return { component: name, file, props: fallback.props };
        }
      }
      node = node.parentElement;
    }
    return fallback ? { ...fallback, file: null } : { component: null, file: null, props: null };
  }

  function safeProps(props) {
    if (!props || typeof props !== 'object') return null;
    const out = {};
    let n = 0;
    for (const k of Object.keys(props)) {
      if (n++ > 8) break;
      const v = props[k];
      if (v == null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
      else out[k] = Array.isArray(v) ? `[${v.length}]` : typeof v;
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 可见性 / 几何
   * ------------------------------------------------------------------ */

  function rgba(str) {
    if (!str) return null;
    const m = str.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }

  function luminance(c) {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }

  function contrastRatio(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** 向上累积半透明背景，估算元素实际底色 */
  function effectiveBg(el) {
    let node = el;
    const stack = [];
    let guard = 0;
    while (node && node.nodeType === 1 && guard++ < 30) {
      const cs = getComputedStyle(node);
      const c = rgba(cs.backgroundColor);
      if (c && c.a > 0) {
        stack.push(c);
        if (c.a >= 0.99) break;
      }
      if (node === document.documentElement) break;
      node = node.parentElement;
    }
    let out = { r: 255, g: 255, b: 255 };
    for (let i = stack.length - 1; i >= 0; i--) {
      const c = stack[i];
      out = {
        r: c.r * c.a + out.r * (1 - c.a),
        g: c.g * c.a + out.g * (1 - c.a),
        b: c.b * c.a + out.b * (1 - c.a),
      };
    }
    return out;
  }

  const IGNORE_TAGS = new Set([
    'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'HEAD',
    'BR', 'HR', 'PATH', 'G', 'DEFS', 'CLIPPATH', 'LINEARPATH',
  ]);
  const DEFAULT_IGNORE = [
    '.xterm-helper-textarea', '.xterm-char-measure-element', '[aria-hidden="true"][data-probe-ignore]',
    '.vite-error-overlay', '[class*="devtools"]',
    // 终端内部有海量 span/行 div，对布局扫描没有意义（终端本身由 §9 专检负责）
    '.xterm *',
  ];

  function ignored(el, extra) {
    if (!el || el.nodeType !== 1) return true;
    if (IGNORE_TAGS.has(el.tagName)) return true;
    if (el.closest('[data-probe-ignore]')) return true;
    for (const sel of DEFAULT_IGNORE) {
      try { if (el.matches(sel)) return true; } catch (_) { /* noop */ }
    }
    if (extra && extra.length) {
      for (const sel of extra) {
        try { if (el.matches(sel) || el.closest(sel)) return true; } catch (_) { /* noop */ }
      }
    }
    return false;
  }

  function styleVisible(el) {
    // 原生 checkVisibility 会一次性判断祖先 display:none / content-visibility / opacity 等，
    // 比手写 getComputedStyle 准确得多（手写版会把隐藏弹窗里的元素当成"0 尺寸可见元素"误报）
    if (typeof el.checkVisibility === 'function') {
      const ok = el.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
        contentVisibilityAuto: true,
      });
      if (!ok) return false;
    }
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    if (cs.clipPath === 'inset(50%)' || cs.clip === 'rect(0px, 0px, 0px, 0px)') return false;
    // 祖先 display:none 时 offsetParent 为 null（position:fixed 例外）
    if (cs.position !== 'fixed' && el.offsetParent === null && el !== document.body) return false;
    return true;
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  }

  function interactive(el) {
    const tag = el.tagName.toLowerCase();
    if (['button', 'a', 'input', 'select', 'textarea', 'summary'].includes(tag)) return true;
    if (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab') return true;
    if (el.hasAttribute('contenteditable')) return true;
    const cs = getComputedStyle(el);
    if (cs.cursor === 'pointer' && el.textContent && el.textContent.trim().length < 40) return true;
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 不变量检查
   * ------------------------------------------------------------------ */

  function scan(options) {
    const opt = options || {};
    const ignore = opt.ignore || [];
    const issues = [];
    const kindCount = {};
    const PER_KIND_MAX = 6; // 同类问题只留前几条，其余只计数（避免一份报告里全是同一个误报刷屏）
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const isMobile = vw < 768;

    function push(kind, severity, el, detail, extra) {
      kindCount[kind] = (kindCount[kind] || 0) + 1;
      if (kindCount[kind] > PER_KIND_MAX) return;
      if (issues.length >= MAX_ISSUES) return;
      const vi = vueInfo(el);
      issues.push({
        kind,
        severity,
        selector: cssPath(el),
        rect: rectOf(el),
        text: trunc(el.textContent, 60),
        component: vi.component,
        file: vi.file,
        props: vi.props,
        detail: detail || '',
        ...(extra || {}),
      });
    }

    const all = document.body ? Array.from(document.body.querySelectorAll('*')) : [];
    const visible = [];
    for (const el of all) {
      if (ignored(el, ignore)) continue;
      if (!styleVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) {
        // 零尺寸：只有在自身承载内容时才值得报告
        const ownText = Array.from(el.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent)
          .join('')
          .trim();
        const hasMedia = el.querySelector('img,canvas,svg,video') != null;
        if (ownText.length > 0 || hasMedia) {
          push('zero-size', 'high', el, `可见元素尺寸为 0（${Math.round(r.width)}x${Math.round(r.height)}），内容被判为不可见`);
        }
        continue;
      }
      visible.push(el);
    }

    for (const el of visible) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);

      /* --- 1. 被裁剪：超出最近的 overflow:hidden 祖先 --- */
      let p = el.parentElement;
      let guard = 0;
      while (p && guard++ < 12) {
        const pcs = getComputedStyle(p);
        if (/hidden|clip/.test(pcs.overflowX) || /hidden|clip/.test(pcs.overflowY)) {
          const pr = p.getBoundingClientRect();
          const overX = Math.min(r.right - pr.right, pr.left - r.left);
          const overY = Math.min(r.bottom - pr.bottom, pr.top - r.top);
          // 阈值放宽到 8px，并跳过已经完全滚出视口的元素（滚动容器里的正常状态）
          const onScreen = r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
          if (onScreen && (overX > 8 || overY > 8)) {
            push('clipped', 'high', el,
              `超出裁剪祖先 ${overX > 8 ? '横向 ' + Math.round(overX) + 'px ' : ''}${overY > 8 ? '纵向 ' + Math.round(overY) + 'px' : ''}`.trim(),
              { container: cssPath(p), containerRect: rectOf(p) });
          }
          break;
        }
        p = p.parentElement;
      }

      /* --- 2. 可交互元素被遮挡（只查完全落在视口内、有实际点击面积的元素） --- */
      if (interactive(el) && r.width >= 16 && r.height >= 16
          && r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw) {
        const cx = clamp(r.left + r.width / 2, 0, vw - 1);
        const cy = clamp(r.top + r.height / 2, 0, vh - 1);
        const hit = document.elementFromPoint(cx, cy);
        if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
          const hcs = getComputedStyle(hit);
          const coveredBy = cssPath(hit);
          const isMask = /overlay|mask|backdrop|loading/i.test(hit.className || '') ||
            (hcs.position === 'fixed' && hcs.zIndex !== 'auto' && r.width > 30);
          push('covered', isMask ? 'medium' : 'high', el,
            `中心点 (${Math.round(cx)},${Math.round(cy)}) 命中的是 ${trunc(coveredBy, 70)}，点击会被它接走${isMask ? '（疑似遮罩/弹层，若不该出现则是 bug）' : ''}`,
            { coveredBy });
        }
      }

      /* --- 3. 文本溢出 --- */
      const hasText = el.textContent && el.textContent.trim().length > 0;
      if (hasText && el.children.length <= 2) {
        const overflowX = r.width > 0 && el.scrollWidth - el.clientWidth > 2;
        if (overflowX) {
          if (cs.overflowX === 'visible') {
            push('text-overflow', 'medium', el,
              `文本横向溢出容器 ${el.scrollWidth - el.clientWidth}px 且未被裁剪（会压到相邻元素）`);
          } else if (cs.textOverflow !== 'ellipsis' && cs.overflowX === 'hidden') {
            push('text-hard-clip', 'medium', el,
              `文本被硬裁 ${el.scrollWidth - el.clientWidth}px，未设 text-overflow:ellipsis（视觉上会缺字）`);
          }
        }
      }

      /* --- 4. 固定定位元素完全移出视口 --- *
       * 只查 position:fixed：absolute 元素经常被父级 overflow 裁剪或用于滑入动画，
       * 移出视口属于正常状态（例如侧栏折叠手柄），查它只会制造噪音。 */
      if (cs.position === 'fixed' && (r.width < vw * 1.5)) {
        if (r.right < -2 || r.bottom < -2 || r.left > vw + 2 || r.top > vh + 2) {
          push('offscreen', 'high', el,
            `fixed 元素完全在视口外 (x:${Math.round(r.left)}, y:${Math.round(r.top)})，用户看不见但仍在渲染树里`);
        }
      }

      /* --- 5. 低对比度文本 --- */
      if (hasText && el.children.length === 0) {
        const fg = rgba(cs.color);
        if (fg && fg.a > 0.3) {
          const bg = effectiveBg(el);
          const cr = contrastRatio(fg, bg);
          const fs = parseFloat(cs.fontSize) || 14;
          const bold = (parseInt(cs.fontWeight, 10) || 400) >= 700;
          const large = fs >= 24 || (fs >= 18.66 && bold);
          const min = large ? 3 : 4.5;
          if (cr < Math.min(min, 3.5) && cr > 1.05) {
            push('low-contrast', cr < 2 ? 'high' : 'low', el,
              `对比度 ${cr.toFixed(2)}:1（阈值 ${min}），前景 ${cs.color} 背景 rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`);
          }
        }
      }

      /* --- 6. 移动端触控目标过小 --- */
      if (isMobile && interactive(el) && (r.width < 30 || r.height < 30) && el.children.length === 0) {
        push('tiny-target', 'medium', el, `触控目标仅 ${Math.round(r.width)}x${Math.round(r.height)}px（建议 ≥30px）`);
      }
    }

    /* --- 7. 页面意外横向滚动 --- */
    const de = document.documentElement;
    if (de.scrollWidth - de.clientWidth > 2) {
      issues.push({
        kind: 'horizontal-scroll', severity: 'high', selector: 'html', rect: null, text: '',
        component: null, file: null,
        detail: `文档横向溢出 ${de.scrollWidth - de.clientWidth}px（视口 ${de.clientWidth}px），会出现横向滚动条`,
        ...(function () {
          // 找出真正撑宽的元素
          let culprit = null;
          let maxRight = 0;
          for (const el of visible) {
            const r = el.getBoundingClientRect();
            if (r.right > maxRight) { maxRight = r.right; culprit = el; }
          }
          return culprit ? { selector: cssPath(culprit), culprit: trunc(culprit.textContent, 40), right: Math.round(maxRight) } : {};
        })(),
      });
    }

    /* --- 8. 同级弹层重叠 --- */
    const layers = visible.filter((el) => {
      const cs = getComputedStyle(el);
      return (cs.position === 'fixed' || (cs.position === 'absolute' && cs.zIndex !== 'auto')) &&
        /modal|dialog|popover|drawer|dropdown|overlay|popper|tooltip/i.test(el.className + ' ' + el.getAttribute('role'));
    }).slice(0, 24);
    for (let i = 0; i < layers.length; i++) {
      for (let j = i + 1; j < layers.length; j++) {
        const a = layers[i].getBoundingClientRect();
        const b = layers[j].getBoundingClientRect();
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 8 && oy > 8) {
          const ratio = (ox * oy) / Math.min(a.width * a.height, b.width * b.height);
          if (ratio > 0.35 && !layers[i].contains(layers[j]) && !layers[j].contains(layers[i])) {
            push('layer-overlap', 'medium', layers[j],
              `与 ${trunc(cssPath(layers[i]), 50)} 重叠 ${(ratio * 100).toFixed(0)}%，两个浮层同时可见（可能是弹窗未关闭/叠了）`);
          }
        }
      }
    }

    /* --- 9. 终端专检 --- */
    document.querySelectorAll('.xterm').forEach((termEl) => {
      const screen = termEl.querySelector('.xterm-screen');
      if (!screen) {
        push('terminal-no-screen', 'high', termEl, '.xterm 存在但缺少 .xterm-screen（渲染器未初始化）');
        return;
      }
      const tr = termEl.getBoundingClientRect();
      const sr = screen.getBoundingClientRect();
      const rowsEl = termEl.querySelector('.xterm-rows');
      const renderedText = rowsEl ? (rowsEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
      const data = {
        selector: cssPath(termEl),
        container: { w: Math.round(tr.width), h: Math.round(tr.height) },
        screen: { w: Math.round(sr.width), h: Math.round(sr.height) },
        renderedChars: renderedText.length,
        sample: trunc(renderedText, 120),
        component: vueInfo(termEl).component,
        file: vueInfo(termEl).file,
      };
      if (sr.width < 4 || sr.height < 4) {
        issues.push({ ...data, kind: 'terminal-zero-screen', severity: 'high', detail: `.xterm-screen 尺寸 ${data.screen.w}x${data.screen.h}，典型黑屏特征` });
      }
      const dw = Math.abs(tr.width - sr.width);
      const dh = Math.abs(tr.height - sr.height);
      if (dw > 6 || dh > 6) {
        issues.push({ ...data, kind: 'terminal-size-mismatch', severity: 'high', detail: `渲染区与容器不匹配：容器 ${data.container.w}x${data.container.h} vs screen ${data.screen.w}x${data.screen.h}（差 ${Math.round(dw)}x${Math.round(dh)}，会导致行列错位/留白）` });
      }
    });

    return {
      version: VERSION,
      url: location.href,
      viewport: { w: vw, h: vh, dpr: window.devicePixelRatio },
      scanned: visible.length,
      issueCount: Object.values(kindCount).reduce((a, b) => a + b, 0),
      shown: issues.length,
      byKind: kindCount,
      issues,
    };
  }

  /* ------------------------------------------------------------------ *
   * 页面骨架：只输出"有信息量"的可见节点，体积远小于无障碍树
   * ------------------------------------------------------------------ */

  function outline(options) {
    const opt = options || {};
    const max = opt.max || 160;
    const nodes = [];
    const walk = (el, depth) => {
      if (nodes.length >= max || depth > 8) return;
      if (ignored(el, opt.ignore)) return;
      if (!styleVisible(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      if (r.bottom < -50 || r.top > window.innerHeight + 50) return;

      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .join(' ')
        .trim();
      const act = interactive(el);
      const meaningful = ownText.length > 0 || act || ['IMG', 'CANVAS', 'VIDEO', 'INPUT'].includes(el.tagName);
      if (meaningful) {
        const vi = vueInfo(el);
        nodes.push({
          d: depth,
          tag: el.tagName.toLowerCase(),
          cls: trunc(Array.from(el.classList || []).slice(0, 3).join('.'), 60),
          r: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
          text: ownText ? trunc(ownText, 40) : undefined,
          act: act || undefined,
          comp: vi.component || undefined,
        });
      }
      for (const child of el.children) walk(child, depth + 1);
    };
    if (document.body) walk(document.body, 0);
    return { url: location.href, count: nodes.length, nodes };
  }

  /** 单次往返的状态快照，供 AI 一个调用拿到"页面现在长什么样 + 哪里不对" */
  function snapshot(options) {
    const opt = options || {};
    const t0 = performance.now();
    const layout = scan(opt);
    const result = {
      version: VERSION,
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: layout.viewport,
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
      visibleElementCount: layout.scanned,
      issues: layout.issues.map((i) => ({
        kind: i.kind,
        sev: i.severity,
        file: i.file ? i.file.replace(/^.*?\/src\//, 'src/') : null,
        comp: i.component,
        sel: trunc(i.selector, 90),
        rect: i.rect,
        text: i.text,
        detail: i.detail,
      })),
      byKind: layout.byKind,
      terminals: document.querySelectorAll('.xterm').length,
      overlays: Array.from(document.querySelectorAll('.el-overlay, [class*="modal"], [class*="dialog"]'))
        .filter((e) => styleVisible(e))
        .map((e) => ({ sel: trunc(cssPath(e), 60), text: trunc(e.textContent, 60) })),
      outline: opt.includeOutline === false ? undefined : outline({ max: opt.maxOutline || 80, ignore: opt.ignore }),
      elapsedMs: Math.round(performance.now() - t0),
    };
    // 应用内探针补充的数据（store / xterm buffer）
    if (global.__NEXUS__ && typeof global.__NEXUS__.snapshot === 'function') {
      try { result.app = global.__NEXUS__.snapshot(); } catch (e) { result.appError = String(e); }
    }
    return result;
  }

  /** 文本快照：把页面可见文本按块拼接，用于"确认某个提示到底出没出现" */
  function text() {
    return (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n');
  }

  /** 稳定等待：DOM 连续 N 帧无变化即认为稳定（比 sleep 快） */
  function waitStable(options) {
    const opt = options || {};
    const quietMs = opt.quietMs || 250;
    const timeout = opt.timeout || 4000;
    return new Promise((resolve) => {
      let last = document.body ? document.body.innerHTML.length : 0;
      let lastChange = performance.now();
      let frames = 0;
      const t0 = performance.now();
      const tick = () => {
        frames++;
        const len = document.body ? document.body.innerHTML.length : 0;
        if (len !== last) { last = len; lastChange = performance.now(); }
        if (performance.now() - lastChange > quietMs) {
          resolve({ stable: true, ms: Math.round(performance.now() - t0), frames });
        } else if (performance.now() - t0 > timeout) {
          resolve({ stable: false, ms: Math.round(performance.now() - t0), frames });
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    });
  }

  global.__NEXUS_DOM__ = {
    version: VERSION,
    scan,
    snapshot,
    outline,
    text,
    waitStable,
    cssPath,
    vueInfo,
    rectOf,
  };
})(window);
