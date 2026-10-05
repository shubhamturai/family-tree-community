/*
 * NodeHandles — draw.io-style "+" handles around a Cytoscape node (shared by the public page and Admin Studio).
 *
 *   const h = NodeHandles.attach(cy, {
 *     enabled: () => true,                       // show handles at all?
 *     handles: [{kind, side, title, label}],     // optional; defaults: parent↑ child↓ spouse→ sibling←
 *     onAdd(kind, srcId, {x, y}),                // a handle was clicked (or activated with the keyboard)
 *     onDrop(kind, srcId, targetId|null, {x, y}) // a handle was dragged: onto another node, or onto empty canvas
 *     branch: {                                  // optional collapse/expand pill under a person
 *       has(id), collapsed(id), count(id),       //   can it collapse? is it? how many people are hidden?
 *       onToggle(id)
 *     }
 *   });
 *   h.refresh();  h.destroy();
 *
 * Handles follow the hovered node (or the selected one on touch screens), track pan/zoom, and a drag draws a
 * rubber-band line that highlights the node under the pointer. Keyboard users can Tab to the handles.
 */
(function (root) {
  "use strict";
  var DEFAULTS = [
    { kind: "parent", side: "top", title: "Add a parent", label: "Parent" },
    { kind: "child", side: "bottom", title: "Add a child", label: "Child" },
    { kind: "spouse", side: "right", title: "Add a spouse or partner", label: "Spouse" },
    { kind: "sibling", side: "left", title: "Add a brother or sister", label: "Sibling" }
  ];
  var OFFSET = 22;
  var css = ".nh-layer{position:absolute;inset:0;pointer-events:none;z-index:7;opacity:0;transition:opacity .12s}" +
    ".nh-layer.on{opacity:1}.nh-layer.on .nh-btn{pointer-events:auto}" +
    ".nh-btn{position:absolute;width:28px;height:28px;margin:-14px 0 0 -14px;padding:0;border-radius:50%;border:2px solid #fff;background:var(--brand,#6f64f6);color:#fff;font:700 20px/1 system-ui,sans-serif;box-shadow:0 4px 14px #0006;display:grid;place-items:center;cursor:pointer;touch-action:none;transition:transform .1s}" +
    ".nh-btn:hover,.nh-btn:focus-visible{transform:scale(1.18);background:var(--ring,#5b4fe7)}" +
    ".nh-btn::after{content:attr(data-label);position:absolute;white-space:nowrap;font:700 11px system-ui,sans-serif;padding:3px 8px;border-radius:999px;background:#0b1220ee;color:#fff;opacity:0;pointer-events:none;transition:opacity .1s}" +
    ".nh-btn:hover::after,.nh-btn:focus-visible::after{opacity:1}" +
    ".nh-top::after{bottom:34px}.nh-bottom::after{top:34px}.nh-right::after{left:36px}.nh-left::after{right:36px}" +
    ".nh-layer.dragging .nh-btn{opacity:.35}.nh-layer.dragging .nh-btn.nh-active{opacity:1}" +
    ".nh-rubber{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}" +
    ".nh-hit{position:absolute;border:3px solid #35d39a;border-radius:12px;background:#35d39a22;pointer-events:none;display:none}" +
    ".nh-branch{position:absolute;margin:-12px 0 0 -26px;height:24px;min-width:52px;padding:0 9px;border-radius:999px;border:2px solid #fff;background:#243049;color:#fff;font:700 12px/1 system-ui,sans-serif;box-shadow:0 4px 14px #0006;cursor:pointer;display:none;pointer-events:none;white-space:nowrap}" +
    ".nh-layer.on .nh-branch.show{display:block;pointer-events:auto}.nh-branch:hover,.nh-branch:focus-visible{background:var(--ring,#5b4fe7)}" +
    "@media(prefers-reduced-motion:reduce){.nh-layer,.nh-btn{transition:none}}";
  function injectCss() {
    if (document.getElementById("nh-style")) return;
    var s = document.createElement("style"); s.id = "nh-style"; s.textContent = css; document.head.appendChild(s);
  }

  function attach(cy, opts) {
    opts = opts || {};
    injectCss();
    var host = cy.container().parentElement, defs = opts.handles || DEFAULTS;
    var layer = document.createElement("div"); layer.className = "nh-layer"; host.appendChild(layer);
    var svgNS = "http://www.w3.org/2000/svg", svg = document.createElementNS(svgNS, "svg"); svg.setAttribute("class", "nh-rubber");
    var line = document.createElementNS(svgNS, "line"); line.setAttribute("stroke", "#35d39a"); line.setAttribute("stroke-width", "3"); line.setAttribute("stroke-dasharray", "7 5"); line.setAttribute("stroke-linecap", "round"); line.style.display = "none";
    svg.appendChild(line); layer.appendChild(svg);
    var hit = document.createElement("div"); hit.className = "nh-hit"; layer.appendChild(hit);

    var hoverId = null, hideTimer = null, overHandle = false, drag = null, raf = 0, alive = true;
    var enabled = function () { return !opts.enabled || opts.enabled(); };
    var cur = function () {
      if (drag) return drag.srcId;
      if (hoverId && cy.getElementById(hoverId).length) return hoverId;
      var s = cy.$("node:selected"); return s.length ? s[0].id() : null;
    };
    var branch = null;
    if (opts.branch) {
      branch = document.createElement("button"); branch.type = "button"; branch.className = "nh-branch"; layer.appendChild(branch);
      branch.addEventListener("pointerenter", function () { overHandle = true; clearTimeout(hideTimer); });
      branch.addEventListener("pointerleave", function () { overHandle = false; scheduleHide(); });
      branch.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
      branch.addEventListener("click", function (e) {
        e.stopPropagation(); var id = layer.dataset.node; if (id) { opts.branch.onToggle(id); schedule(); }
      });
    }
    var buttons = defs.map(function (h) {
      var b = document.createElement("button"); b.type = "button"; b.className = "nh-btn nh-" + h.side; b.textContent = "+";
      b.title = h.title; b.dataset.kind = h.kind; b.dataset.label = h.label || h.kind; b.setAttribute("aria-label", h.title);
      layer.appendChild(b); return { h: h, b: b };
    });

    function place() {
      raf = 0;
      if (!alive) return;
      var on = enabled(), id = (on || branch) ? cur() : null, n = id && cy.getElementById(id);
      if (!n || !n.length || cy.zoom() < (opts.minZoom || 0.2)) { layer.classList.remove("on"); layer.dataset.node = ""; return; }
      var bb = n.renderedBoundingBox({ includeLabels: false, includeOverlays: false, includeEdges: false, includeUnderlays: false });
      var cx = (bb.x1 + bb.x2) / 2, cyy = (bb.y1 + bb.y2) / 2, o = OFFSET;
      buttons.forEach(function (x) {
        x.b.style.display = on ? "" : "none";
        var s = x.h.side, px = cx, py = cyy;
        if (s === "top") py = bb.y1 - o; else if (s === "bottom") py = bb.y2 + o; else if (s === "right") px = bb.x2 + o; else px = bb.x1 - o;
        x.b.style.left = px + "px"; x.b.style.top = py + "px";
        x.b.setAttribute("aria-label", x.h.title + " — " + (opts.label ? opts.label(id) : id));
      });
      if (branch) {
        var can = opts.branch.has(id), isC = can && opts.branch.collapsed(id), cnt = can ? opts.branch.count(id) : 0;
        branch.classList.toggle("show", !!can);
        if (can) {
          branch.textContent = isC ? "▸ " + cnt + " hidden" : "▾ Collapse";
          branch.title = isC ? "Show the " + cnt + " people hidden under this person" : "Hide everyone below this person";
          branch.setAttribute("aria-label", (isC ? "Expand branch — " : "Collapse branch — ") + (opts.label ? opts.label(id) : id));
          branch.style.left = (cx + 26) + "px"; branch.style.top = (bb.y2 + o) + "px"; branch.style.marginLeft = "0px";   // beside the + child handle
        }
      }
      layer.dataset.node = id; layer.classList.add("on");
    }
    function schedule() { if (!raf && alive) raf = requestAnimationFrame(place); }
    function scheduleHide() { clearTimeout(hideTimer); hideTimer = setTimeout(function () { if (!overHandle && !drag) { hoverId = null; schedule(); } }, 260); }

    function hitNode(x, y, exclude) {
      var found = null;
      cy.nodes().forEach(function (n) {
        if (n.id() === exclude) return;
        var b = n.renderedBoundingBox({ includeLabels: false, includeOverlays: false, includeEdges: false, includeUnderlays: false });
        if (x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2) found = n;
      });
      return found;
    }
    function drawRubber() {
      if (!drag || !drag.moved) return;
      line.style.display = ""; line.setAttribute("x1", drag.ox); line.setAttribute("y1", drag.oy); line.setAttribute("x2", drag.x); line.setAttribute("y2", drag.y);
      var t = hitNode(drag.x, drag.y, drag.srcId);
      if (t) {
        var b = t.renderedBoundingBox({ includeLabels: false, includeOverlays: false, includeEdges: false, includeUnderlays: false });
        hit.style.display = "block"; hit.style.left = (b.x1 - 4) + "px"; hit.style.top = (b.y1 - 4) + "px"; hit.style.width = (b.x2 - b.x1 + 8) + "px"; hit.style.height = (b.y2 - b.y1 + 8) + "px";
      } else hit.style.display = "none";
    }
    function endDrag() { drag = null; line.style.display = "none"; hit.style.display = "none"; layer.classList.remove("dragging"); buttons.forEach(function (x) { x.b.classList.remove("nh-active"); }); }

    buttons.forEach(function (x) {
      var b = x.b;
      b.addEventListener("pointerenter", function () { overHandle = true; clearTimeout(hideTimer); });
      b.addEventListener("pointerleave", function () { overHandle = false; scheduleHide(); });
      b.addEventListener("pointerdown", function (e) {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        var id = layer.dataset.node; if (!id) return;
        e.preventDefault(); e.stopPropagation();
        try { b.setPointerCapture(e.pointerId); } catch (_) { /* older browsers */ }
        var r = b.getBoundingClientRect(), hr = host.getBoundingClientRect();
        drag = { srcId: id, kind: x.h.kind, sx: e.clientX, sy: e.clientY, ox: r.left + r.width / 2 - hr.left, oy: r.top + r.height / 2 - hr.top, moved: false, pid: e.pointerId, x: 0, y: 0 };
      });
      b.addEventListener("pointermove", function (e) {
        if (!drag || e.pointerId !== drag.pid) return;
        if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 6) return;
        drag.moved = true; layer.classList.add("dragging"); b.classList.add("nh-active");
        var hr = host.getBoundingClientRect(); drag.x = e.clientX - hr.left; drag.y = e.clientY - hr.top;
        drawRubber();
      });
      b.addEventListener("pointerup", function (e) {
        if (!drag || e.pointerId !== drag.pid) return;
        var d = drag; try { b.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        if (d.moved) {
          var t = hitNode(d.x, d.y, d.srcId); endDrag();
          if (opts.onDrop) opts.onDrop(d.kind, d.srcId, t ? t.id() : null, { x: d.x, y: d.y });
        } else { endDrag(); if (opts.onAdd) opts.onAdd(d.kind, d.srcId, { x: d.ox, y: d.oy }); }
        schedule();
      });
      b.addEventListener("pointercancel", function () { endDrag(); });
      b.addEventListener("click", function (e) {
        if (e.detail !== 0) return;               // pointer clicks are handled on pointerup; this is keyboard activation
        var id = layer.dataset.node; if (!id) return;
        var r = b.getBoundingClientRect(), hr = host.getBoundingClientRect();
        if (opts.onAdd) opts.onAdd(x.h.kind, id, { x: r.left + r.width / 2 - hr.left, y: r.top + r.height / 2 - hr.top });
      });
    });
    var onKey = function (e) { if (e.key === "Escape" && drag) endDrag(); };
    document.addEventListener("keydown", onKey);

    var onOver = function (e) { clearTimeout(hideTimer); hoverId = e.target.id(); schedule(); };
    var onGrab = function () { clearTimeout(hideTimer); };
    cy.on("mouseover", "node", onOver);
    cy.on("mouseout", "node", scheduleHide);
    cy.on("select unselect render resize", schedule);
    cy.on("grab", onGrab);
    schedule();

    return {
      refresh: schedule,
      destroy: function () { alive = false; clearTimeout(hideTimer); document.removeEventListener("keydown", onKey); if (layer.parentNode) layer.parentNode.removeChild(layer); try { cy.off("mouseover", "node", onOver); cy.off("mouseout", "node", scheduleHide); cy.off("select unselect render resize", schedule); cy.off("grab", onGrab); } catch (_) { /* cy already destroyed */ } },
      target: cur
    };
  }
  root.NodeHandles = { attach: attach };
})(typeof window !== "undefined" ? window : globalThis);
