/* =====================================================================
 * ai_verify.jsx - measures the assumptions place.js is built on.
 * ASCII only on purpose: `do javascript file` does not guarantee encoding.
 * Creates its own documents, closes them without saving, never touches
 * documents that were already open.
 * ===================================================================== */

var RESULT = "";

(function () {

var DIR = "/private/tmp/claude-501/-Users-zg-mrclick/aac28652-71d2-4dd7-bb5c-b1277bfa35c2/scratchpad/psverify";
var sID = stringIDToTypeID, cID = charIDToTypeID;

var LOG = [];
function say(s) { LOG.push(String(s)); }
function n3(v) { return (v === null || v === undefined) ? "null" : String(Math.round(v * 1000) / 1000); }
function fmtFrame(f) {
    if (!f) return "null";
    return "L" + n3(f.left) + " T" + n3(f.top) + " R" + n3(f.right) + " B" + n3(f.bottom) +
           " (" + n3(f.right - f.left) + "x" + n3(f.bottom - f.top) + ")";
}
function verdict(id, name, ok, detail) {
    var m = ok === true ? "PASS" : (ok === false ? "FAIL" : "UNKNOWN");
    say("");
    say("[" + id + "] " + name);
    say("    " + m);
    say("    " + detail);
}

/* ---------- descriptor readers ---------- */

function anyNum(d, key) {
    if (!d.hasKey(key)) return null;
    var t = d.getType(key);
    if (t == DescValueType.DOUBLETYPE) return d.getDouble(key);
    if (t == DescValueType.UNITDOUBLE) return d.getUnitDoubleValue(key);
    if (t == DescValueType.INTEGERTYPE) return d.getInteger(key);
    if (t == DescValueType.LARGEINTEGERTYPE) return d.getLargeInteger(key);
    return null;
}
function listNum(l, i) {
    var t = l.getType(i);
    if (t == DescValueType.DOUBLETYPE) return l.getDouble(i);
    if (t == DescValueType.UNITDOUBLE) return l.getUnitDoubleValue(i);
    if (t == DescValueType.INTEGERTYPE) return l.getInteger(i);
    return null;
}
function typeName(t) {
    if (t == DescValueType.DOUBLETYPE) return "DOUBLE";
    if (t == DescValueType.UNITDOUBLE) return "UNITDOUBLE";
    if (t == DescValueType.INTEGERTYPE) return "INTEGER";
    return "other";
}

function measure() {
    var out = { hasMore: false, frame: null, quad: null, size: null,
                nonAffine: false, bounds: null, ttype: null, isSO: false };
    var r = new ActionReference();
    r.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
    var d;
    try { d = executeActionGet(r); } catch (e) { return out; }

    if (d.hasKey(sID("smartObject"))) out.isSO = true;

    if (d.hasKey(sID("smartObjectMore"))) {
        out.hasMore = true;
        var more = d.getObjectValue(sID("smartObjectMore"));
        if (more.hasKey(sID("transform"))) {
            var l = more.getList(sID("transform"));
            if (l.count > 0) out.ttype = typeName(l.getType(0));
            if (l.count >= 8) {
                var q = [];
                for (var i = 0; i < 8; i++) q.push(listNum(l, i));
                out.quad = q;
                var xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
                out.frame = { left: Math.min.apply(null, xs), right: Math.max.apply(null, xs),
                              top: Math.min.apply(null, ys), bottom: Math.max.apply(null, ys) };
            }
        }
        if (more.hasKey(sID("size"))) {
            var sz = more.getObjectValue(sID("size"));
            out.size = { w: anyNum(sz, sID("width")), h: anyNum(sz, sID("height")) };
        }
        out.nonAffine = more.hasKey(sID("nonAffineTransform"));
    }
    try {
        var b = app.activeDocument.activeLayer.bounds;
        out.bounds = { left: b[0].as("px"), top: b[1].as("px"),
                       right: b[2].as("px"), bottom: b[3].as("px") };
    } catch (e2) {}
    return out;
}

/* ---------- actions ---------- */

function placeFile(p) {
    var desc = new ActionDescriptor();
    desc.putPath(cID("null"), new File(p));
    desc.putBoolean(sID("linked"), false);
    desc.putEnumerated(sID("freeTransformCenterState"), sID("quadCenterState"), sID("QCSAverage"));
    var ofs = new ActionDescriptor();
    ofs.putUnitDouble(sID("horizontal"), sID("pixelsUnit"), 0);
    ofs.putUnitDouble(sID("vertical"), sID("pixelsUnit"), 0);
    desc.putObject(sID("offset"), sID("offset"), ofs);
    executeAction(sID("placeEvent"), desc, DialogModes.NO);
}

function pxList(v) {
    var l = new ActionList();
    for (var i = 0; i < v.length; i++) l.putUnitDouble(sID("pixelsUnit"), v[i]);
    return l;
}
function setFrame(cur, dst) {
    var d = new ActionDescriptor();
    var r = new ActionReference();
    r.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
    d.putReference(cID("null"), r);
    d.putEnumerated(sID("freeTransformCenterState"), sID("quadCenterState"), sID("QCSAverage"));
    d.putList(sID("rectangle"), pxList([cur.left, cur.top, cur.right, cur.bottom]));
    d.putList(sID("quadrilateral"), pxList([dst.left, dst.top, dst.right, dst.top,
                                            dst.right, dst.bottom, dst.left, dst.bottom]));
    d.putEnumerated(sID("interpolation"), sID("interpolationType"), sID("bicubicSharper"));
    executeAction(sID("transform"), d, DialogModes.NO);
}
function resetTransforms() {
    executeAction(sID("placedLayerResetTransforms"), undefined, DialogModes.NO);
}
function translateLayer(dx, dy) {
    var d = new ActionDescriptor();
    var r = new ActionReference();
    r.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
    d.putReference(cID("null"), r);
    d.putUnitDouble(sID("horizontal"), sID("pixelsUnit"), dx);
    d.putUnitDouble(sID("vertical"), sID("pixelsUnit"), dy);
    executeAction(sID("move"), d, DialogModes.NO);
}

function prefRef() {
    var r = new ActionReference();
    r.putProperty(sID("property"), sID("generalPreferences"));
    r.putEnumerated(sID("application"), sID("ordinal"), sID("targetEnum"));
    return r;
}
function getResize() {
    var d = executeActionGet(prefRef());
    if (!d.hasKey(sID("generalPreferences"))) return null;
    var gp = d.getObjectValue(sID("generalPreferences"));
    if (!gp.hasKey(sID("resizePastePlace"))) return null;
    return gp.getBoolean(sID("resizePastePlace"));
}
function setResize(v) {
    var to = new ActionDescriptor();
    to.putBoolean(sID("resizePastePlace"), v);
    var d = new ActionDescriptor();
    d.putReference(cID("null"), prefRef());
    d.putObject(sID("to"), sID("generalPreferences"), to);
    executeAction(sID("set"), d, DialogModes.NO);
}

function newDoc(name, mode, depth, w, h, res) {
    return app.documents.add(w, h, res, name, mode, DocumentFill.WHITE, 1, depth);
}
function killDoc(d) {
    if (!d) return;
    try { d.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {}
}

/* ---------- port of geometry.js (the parts place.js uses) ---------- */

var ASPECT_TOL = 0.005;
function planFrame(t, nat) {
    var aspectErr = Math.abs((t.w / t.h) / (nat.w / nat.h) - 1);
    if (aspectErr <= ASPECT_TOL) {
        return { mode: "exact", left: t.left, top: t.top, right: t.right, bottom: t.bottom };
    }
    var s = Math.max(t.w / nat.w, t.h / nat.h);
    var fw = Math.round(nat.w * s), fh = Math.round(nat.h * s);
    var left = t.left + Math.round((t.w - fw) / 2);
    var top  = t.top  + Math.round((t.h - fh) / 2);
    return { mode: "cover", left: left, top: top, right: left + fw, bottom: top + fh };
}

/* ---------- full place.js pipeline, measured ---------- */

function runPipeline(pngPath, natW, natH, target) {
    var t = { left: target.left, top: target.top, right: target.right, bottom: target.bottom,
              w: target.right - target.left, h: target.bottom - target.top };
    var dst = planFrame(t, { w: natW, h: natH });

    placeFile(pngPath);
    var steps = [];

    try { resetTransforms(); } catch (e) { steps.push("resetTransforms threw: " + e.message); }

    var cur = measure();
    if (!cur.frame) return { err: "no transform frame after place", dst: dst };
    steps.push("after place: " + fmtFrame(cur.frame));

    setFrame(cur.frame, dst);
    var after = measure();
    if (!after.frame) return { err: "no frame after setFrame", dst: dst };
    steps.push("after setFrame: " + fmtFrame(after.frame));

    var dw = (dst.right - dst.left) - (after.frame.right - after.frame.left);
    var dh = (dst.bottom - dst.top) - (after.frame.bottom - after.frame.top);
    if (Math.abs(dw) > 0.01 || Math.abs(dh) > 0.01) {
        setFrame(after.frame, dst);
        after = measure();
        steps.push("after 2nd setFrame: " + fmtFrame(after.frame));
    }
    var dx = dst.left - after.frame.left, dy = dst.top - after.frame.top;
    if (Math.abs(dx) >= 0.01 || Math.abs(dy) >= 0.01) {
        try { translateLayer(Math.round(dx), Math.round(dy)); } catch (e) { steps.push("move threw: " + e.message); }
        after = measure();
        steps.push("after move: " + fmtFrame(after.frame));
    }
    return {
        dst: dst, steps: steps, nonAffine: after.nonAffine,
        residual: {
            dx: (dst.left - after.frame.left), dy: (dst.top - after.frame.top),
            dw: (dst.right - dst.left) - (after.frame.right - after.frame.left),
            dh: (dst.bottom - dst.top) - (after.frame.bottom - after.frame.top)
        }
    };
}
function fmtResidual(r) {
    return "dx=" + n3(r.dx) + " dy=" + n3(r.dy) + " dw=" + n3(r.dw) + " dh=" + n3(r.dh);
}
function residualZero(r) {
    return Math.abs(r.dx) < 0.01 && Math.abs(r.dy) < 0.01 &&
           Math.abs(r.dw) < 0.01 && Math.abs(r.dh) < 0.01;
}

/* ===================== main ===================== */

var oldUnits = app.preferences.rulerUnits;
var oldDialogs = app.displayDialogs;
var prefWas = null;
var docsBefore = app.documents.length;

app.preferences.rulerUnits = Units.PIXELS;
app.displayDialogs = DialogModes.NO;

var P_1024_300  = DIR + "/vt_1024_p300.png";
var P_1024_NO   = DIR + "/vt_1024_nophys.png";
var P_1024_72   = DIR + "/vt_1024_p72.png";
var P_1000x600  = DIR + "/vt_1000x600_p300.png";
var P_MASK      = DIR + "/vt_mask_1024.png";

try {
    say("=== place.js assumption check ===");
    say("Photoshop " + app.version);
    say("documents already open: " + docsBefore);
    var dirty = 0;
    for (var i = 0; i < app.documents.length; i++) { if (!app.documents[i].saved) dirty++; }
    say("unsaved among them: " + dirty + " (this script never touches them)");

    /* pref: read + toggle + restore  => TEST 4 */
    prefWas = getResize();
    var t4ok = null, t4detail = "";
    if (prefWas === null) {
        t4detail = "resizePastePlace key absent from generalPreferences";
    } else {
        try {
            setResize(!prefWas);
            var mid = getResize();
            setResize(prefWas);
            var back = getResize();
            t4ok = (mid === !prefWas) && (back === prefWas);
            t4detail = "initial=" + prefWas + ", after toggle=" + mid + ", restored=" + back;
        } catch (e) { t4detail = "threw: " + e.message; }
    }
    verdict(4, "resizePastePlace readable and writable via generalPreferences", t4ok, t4detail);

    /* keep fit-to-canvas off for the geometry blocks, exactly like place.js does */
    if (prefWas === true) setResize(false);

    /* ---------- BLOCK A: RGB 8-bit 2000x1500 @300ppi ---------- */
    var docA = null;
    try {
        docA = newDoc("VT_RGB8", NewDocumentMode.RGB, BitsPerChannelType.EIGHT, 2000, 1500, 300);

        placeFile(P_1024_300);
        var mA = measure();

        say("");
        say("--- raw smartObjectMore, RGB8 2000x1500 @300, placed 1024px pHYs=300 ---");
        say("  isSmartObject: " + mA.isSO + " | hasSmartObjectMore: " + mA.hasMore);
        say("  transform element type: " + mA.ttype);
        say("  quad: " + (mA.quad ? mA.quad.join(", ") : "null"));
        say("  frame: " + fmtFrame(mA.frame));
        say("  size:  " + (mA.size ? n3(mA.size.w) + "x" + n3(mA.size.h) : "null"));
        say("  nonAffineTransform present: " + mA.nonAffine);
        say("  layer.bounds: " + fmtFrame(mA.bounds));

        var centered = null, d1 = "";
        if (mA.frame) {
            var cx = (mA.frame.left + mA.frame.right) / 2, cy = (mA.frame.top + mA.frame.bottom) / 2;
            var w = mA.frame.right - mA.frame.left;
            centered = Math.abs(cx - 1000) < 1 && Math.abs(cy - 750) < 1;
            d1 = "center=(" + n3(cx) + "," + n3(cy) + ") vs canvas center (1000,750); width=" + n3(w) +
                 " vs native 1024. " +
                 (centered ? "Coordinates ARE in document space, as place.js assumes."
                           : "Coordinates are NOT document-space.");
            if (mA.bounds) {
                d1 += " layer.bounds gives " + n3(mA.bounds.right - mA.bounds.left) + "x" +
                      n3(mA.bounds.bottom - mA.bounds.top) + " for the same layer.";
            }
        } else { d1 = "transform unavailable or shorter than 8 numbers"; }
        verdict(1, "smartObjectMore.transform coordinate system", centered, d1);

        /* TEST 6: pHYs neutralises PPI scaling. Same doc, pref already false. */
        var wWith = mA.frame ? (mA.frame.right - mA.frame.left) : null;
        placeFile(P_1024_NO);
        var mNo = measure();
        var wNo = mNo.frame ? (mNo.frame.right - mNo.frame.left) : null;
        placeFile(P_1024_72);
        var m72 = measure();
        var w72 = m72.frame ? (m72.frame.right - m72.frame.left) : null;

        var t6ok = null;
        if (wWith !== null && wNo !== null) {
            t6ok = Math.abs(wWith - 1024) < 1 && Math.abs(wNo - 1024) > 1;
        }
        verdict(6, "pHYs cancels Place PPI scaling",
            t6ok,
            "in a 300ppi document: pHYs=300 -> width " + n3(wWith) +
            " | no pHYs -> width " + n3(wNo) +
            (wNo ? " (" + n3(wNo / 1024) + "x, expected 300/72 = 4.167x)" : "") +
            " | pHYs=72 -> width " + n3(w72) + ". " +
            (t6ok === true
              ? "So writing pHYs = document ppi is what keeps Place at 1:1. setPngResolution is load-bearing."
              : "Result does not match the model - re-check setPngResolution."));

        /* TEST 3: placedLayerResetTransforms - operate on the scaled no-pHYs layer */
        var beforeReset = measure();
        var t3ok = null, t3detail = "command unavailable";
        try {
            resetTransforms();
            var afterReset = measure();
            if (beforeReset.frame && afterReset.frame) {
                var wB = beforeReset.frame.right - beforeReset.frame.left;
                var wA = afterReset.frame.right - afterReset.frame.left;
                var moved = Math.abs(afterReset.frame.left - beforeReset.frame.left) > 0.5 ||
                            Math.abs(afterReset.frame.top - beforeReset.frame.top) > 0.5;
                t3ok = Math.abs(wA - 1024) < 2;
                t3detail = "width " + n3(wB) + " -> " + n3(wA) + " (native 1024). " +
                    (t3ok ? "Resets scale to native 1:1. " : "Does NOT produce native size. ") +
                    (moved ? "It DOES move the layer (place.js survives - it measures afterwards)."
                           : "It does not move the layer.");
            }
        } catch (e) { t3detail = "threw: " + e.message; }
        verdict(3, "placedLayerResetTransforms", t3ok, t3detail);

        /* TEST 2: absolute rectangle -> quadrilateral */
        var cur2 = measure();
        var t2ok = null, t2detail = "could not measure";
        if (cur2.frame) {
            var dst2 = { left: 100, top: 100, right: 500, bottom: 400 };
            try {
                setFrame(cur2.frame, dst2);
                var m2 = measure();
                if (m2.frame) {
                    var ddx = m2.frame.left - dst2.left, ddy = m2.frame.top - dst2.top;
                    var ddw = (m2.frame.right - m2.frame.left) - 400;
                    var ddh = (m2.frame.bottom - m2.frame.top) - 300;
                    t2ok = Math.abs(ddx) < 0.01 && Math.abs(ddy) < 0.01 &&
                           Math.abs(ddw) < 0.01 && Math.abs(ddh) < 0.01;
                    t2detail = "target L100 T100 400x300 -> got " + fmtFrame(m2.frame) +
                        " (delta " + n3(ddx) + "," + n3(ddy) + "," + n3(ddw) + "," + n3(ddh) + "). " +
                        (m2.nonAffine ? "WARNING: nonAffineTransform present - corner order is wrong! " : "") +
                        (t2ok ? "Absolute frame placement works - this is the load-bearing idea of place.js."
                              : "Frame landed elsewhere - corner order or units need fixing.");
                }
            } catch (e) { t2detail = "transform threw: " + e.message; }
        }
        verdict(2, "transform rectangle->quadrilateral as pixel lists", t2ok, t2detail);

        /* TEST 9: the real complaint - end-to-end residual on odd/even/cover selections */
        var cases = [
            { name: "even 200x200 at (400,300)",  png: P_1024_300, nw: 1024, nh: 1024,
              t: { left: 400, top: 300, right: 600, bottom: 500 } },
            { name: "ODD 201x201 at (333,277)",   png: P_1024_300, nw: 1024, nh: 1024,
              t: { left: 333, top: 277, right: 534, bottom: 478 } },
            { name: "ODD 1x1 px 1 at (999,749)",  png: P_1024_300, nw: 1024, nh: 1024,
              t: { left: 999, top: 749, right: 1000, bottom: 750 } },
            { name: "cover 400x400 from 1000x600", png: P_1000x600, nw: 1000, nh: 600,
              t: { left: 700, top: 500, right: 1100, bottom: 900 } },
            { name: "off-canvas 300x300 at (1850,1400)", png: P_1024_300, nw: 1024, nh: 1024,
              t: { left: 1850, top: 1400, right: 2150, bottom: 1700 } }
        ];
        var allZero = true, lines = [];
        for (var c = 0; c < cases.length; c++) {
            var res;
            try { res = runPipeline(cases[c].png, cases[c].nw, cases[c].nh, cases[c].t); }
            catch (e) { res = { err: e.message }; }
            if (res.err) {
                allZero = false;
                lines.push("  " + cases[c].name + " -> ERROR: " + res.err);
            } else {
                var z = residualZero(res.residual);
                if (!z) allZero = false;
                lines.push("  " + cases[c].name + " [" + res.dst.mode + "] target " +
                    fmtFrame(res.dst) + " -> residual " + fmtResidual(res.residual) +
                    (z ? "  OK" : "  <-- OFF") + (res.nonAffine ? "  nonAffine!" : ""));
                for (var s = 0; s < res.steps.length; s++) lines.push("      " + res.steps[s]);
            }
        }
        verdict(9, "END-TO-END: residual of the full place.js pipeline", allZero,
            "Every residual must be 0 - this is the 'paste is not always exact' metric.\n" +
            lines.join("\n"));

        killDoc(docA); docA = null;
    } catch (e) {
        say("");
        say("!!! block A aborted: " + e.message);
        killDoc(docA); docA = null;
    }

    /* ---------- TEST 5: does place convert the document? ---------- */
    var t5cases = [
        { name: "CMYK 8-bit 2000x1500 @300", mode: NewDocumentMode.CMYK, depth: BitsPerChannelType.EIGHT,
          w: 2000, h: 1500, res: 300, png: P_1024_300, expectW: 1024 },
        { name: "CMYK 16-bit 2000x1500 @300", mode: NewDocumentMode.CMYK, depth: BitsPerChannelType.SIXTEEN,
          w: 2000, h: 1500, res: 300, png: P_1024_300, expectW: 1024 },
        { name: "RGB 16-bit 800x600 @72", mode: NewDocumentMode.RGB, depth: BitsPerChannelType.SIXTEEN,
          w: 800, h: 600, res: 72, png: P_1024_72, expectW: 1024 }
    ];
    for (var k = 0; k < t5cases.length; k++) {
        var tc = t5cases[k];
        var dc = null;
        try {
            dc = newDoc("VT_T5_" + k, tc.mode, tc.depth, tc.w, tc.h, tc.res);
            var modeB = String(dc.mode), bpcB = String(dc.bitsPerChannel);
            var histB = dc.historyStates.length;

            placeFile(tc.png);

            var ad = app.activeDocument;
            var modeA = String(ad.mode), bpcA = String(ad.bitsPerChannel);
            var names = [];
            for (var h2 = histB; h2 < ad.historyStates.length; h2++) names.push(ad.historyStates[h2].name);
            var joined = names.join(", ");
            var converted = (modeB !== modeA) || (bpcB !== bpcA) || /convert/i.test(joined);
            var mm = measure();
            var gotW = mm.frame ? (mm.frame.right - mm.frame.left) : null;

            verdict("5." + (k + 1), "place into " + tc.name + " leaves the document untouched",
                !converted,
                "mode " + modeB + " -> " + modeA + " | depth " + bpcB + " -> " + bpcA +
                " | new history steps: [" + joined + "]. " +
                (converted
                  ? "CONVERTED - the load-bearing assumption of place.js is FALSE, the paste path must change!"
                  : "Not converted - a Smart Object can be placed as-is and the document stays CMYK/16-bit.") +
                " Placed frame width " + n3(gotW) + " (expected " + tc.expectW + ", pHYs matches doc ppi)." +
                " isSmartObject=" + mm.isSO);

            /* geometry inside a CMYK / 16-bit document */
            var resC;
            try { resC = runPipeline(tc.png, 1024, 1024, { left: 251, top: 131, right: 452, bottom: 332 }); }
            catch (e) { resC = { err: e.message }; }
            verdict("9." + (k + 1), "END-TO-END residual, ODD 201x201, " + tc.name,
                resC.err ? null : residualZero(resC.residual),
                resC.err ? ("ERROR: " + resC.err)
                         : ("target " + fmtFrame(resC.dst) + " -> residual " + fmtResidual(resC.residual)));

            killDoc(dc); dc = null;
        } catch (e) {
            verdict("5." + (k + 1), "place into " + tc.name, null, "threw: " + e.message);
            killDoc(dc); dc = null;
        }
    }

    /* ---------- TEST 10: does Photoshop decode our own PNG encoder? ---------- */
    var t10 = [
        { p: P_1024_300, what: "RGB, colorType 2, fixed-Huffman deflate", w: 1024, h: 1024 },
        { p: P_MASK,     what: "Grey+Alpha mask, colorType 4",            w: 1024, h: 1024 }
    ];
    for (var q = 0; q < t10.length; q++) {
        var od = null;
        try {
            od = app.open(new File(t10[q].p));
            var okDim = Math.abs(od.width.as("px") - t10[q].w) < 1 &&
                        Math.abs(od.height.as("px") - t10[q].h) < 1;
            verdict("10." + (q + 1), "Photoshop decodes our png.js output: " + t10[q].what,
                okDim,
                "opened as " + n3(od.width.as("px")) + "x" + n3(od.height.as("px")) +
                ", mode " + String(od.mode) + ", depth " + String(od.bitsPerChannel) +
                ". If this passes, deflateRle is correct against a real decoder, not just zlib.");
            killDoc(od); od = null;
        } catch (e) {
            verdict("10." + (q + 1), "Photoshop decodes our png.js output: " + t10[q].what,
                false, "app.open threw: " + e.message + " -> our PNG stream is malformed.");
            killDoc(od); od = null;
        }
    }

    verdict(7, "imaging.getPixels componentSize:8 from a 16-bit document", null,
        "NOT TESTABLE from ExtendScript - imaging is a UXP-only module. capture.js falls back to the " +
        "duplicate-document path on any error, so this stays a graceful-degradation question, not a blocker.");
    verdict(8, "imaging.getPixels in CMYK", null,
        "NOT TESTABLE here, and deliberately never exercised: capture.js routes CMYK through a duplicate.");

    say("");
    say("documents open at end: " + app.documents.length + " (was " + docsBefore + ")");
    say("=== end ===");

} catch (e) {
    say("");
    say("!!! FATAL: " + e.message + (e.line ? (" at line " + e.line) : ""));
} finally {
    try { if (prefWas !== null) setResize(prefWas); } catch (e) {}
    try { app.preferences.rulerUnits = oldUnits; } catch (e) {}
    try { app.displayDialogs = oldDialogs; } catch (e) {}
}

var text = LOG.join("\n");
try {
    var f = new File(DIR + "/report.txt");
    f.encoding = "UTF-8";
    f.open("w");
    f.write(text);
    f.close();
    RESULT = "report written";
} catch (e) {
    RESULT = "REPORT WRITE FAILED: " + e.message;
}

})();

RESULT;
