/* =====================================================================
 * probe6.jsx - faithful transliteration of the SHIPPED place.js steps 4-5
 * (placedLayerResetTransforms + 2-pass measure/scale/move loop with hit()).
 * Validates what was actually written to disk, not an approximation.
 * ASCII only.
 * ===================================================================== */

var RESULT = "";

(function () {

var DIR = "/private/tmp/claude-501/-Users-zg-mrclick/aac28652-71d2-4dd7-bb5c-b1277bfa35c2/scratchpad/psverify";
var PNG_SQ = DIR + "/vt_1024_p300.png";
var PNG_WD = DIR + "/vt_1000x600_p300.png";
var sID = stringIDToTypeID, cID = charIDToTypeID;

var LOG = [];
function say(s) { LOG.push(String(s)); }
function n4(v) { return (v === null || v === undefined) ? "null" : String(Math.round(v * 10000) / 10000); }
function fmt(f) {
    if (!f) return "null";
    return "L" + n4(f.left) + " T" + n4(f.top) + " R" + n4(f.right) + " B" + n4(f.bottom) +
           " (" + n4(f.right - f.left) + "x" + n4(f.bottom - f.top) + ")";
}
function listNum(l, i) {
    var t = l.getType(i);
    if (t == DescValueType.DOUBLETYPE) return l.getDouble(i);
    if (t == DescValueType.UNITDOUBLE) return l.getUnitDoubleValue(i);
    if (t == DescValueType.INTEGERTYPE) return l.getInteger(i);
    return null;
}
function layerRef() {
    var r = new ActionReference();
    r.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
    return r;
}

/* ---- port of place.js readSoFrame(), including the skew comparison ---- */
function readSoFrame() {
    var r = new ActionReference();
    r.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
    var d;
    try { d = executeActionGet(r); } catch (e) { return null; }
    if (!d.hasKey(sID("smartObjectMore"))) return null;
    var more = d.getObjectValue(sID("smartObjectMore"));
    if (!more.hasKey(sID("transform"))) return null;
    var l = more.getList(sID("transform"));
    if (l.count < 8) return null;
    var q = []; for (var i = 0; i < 8; i++) q.push(listNum(l, i));
    for (var c = 0; c < 8; c++) if (q[c] === null || isNaN(q[c])) return null;
    var xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    var skewed = false;
    if (more.hasKey(sID("nonAffineTransform"))) {
        var nl = more.getList(sID("nonAffineTransform"));
        if (nl.count >= 8) {
            for (var k = 0; k < 8; k++) {
                if (Math.abs(listNum(nl, k) - q[k]) > 0.001) { skewed = true; break; }
            }
        }
    }
    var size = null;
    if (more.hasKey(sID("size"))) {
        var sz = more.getObjectValue(sID("size"));
        function num(dd, key) {
            var kk = sID(key); if (!dd.hasKey(kk)) return null;
            var tt = dd.getType(kk);
            if (tt == DescValueType.UNITDOUBLE) return dd.getUnitDoubleValue(kk);
            if (tt == DescValueType.DOUBLETYPE) return dd.getDouble(kk);
            return null;
        }
        size = { w: num(sz, "width"), h: num(sz, "height") };
    }
    return { left: Math.min.apply(null, xs), right: Math.max.apply(null, xs),
             top: Math.min.apply(null, ys), bottom: Math.max.apply(null, ys),
             size: size, skewed: skewed };
}

/* ---- port of place.js scaleSo / moveSo ---- */
function scaleSo(pw, ph) {
    var interp = (pw >= 100 || ph >= 100) ? "bicubicSmoother" : "bicubicSharper";
    var d = new ActionDescriptor();
    d.putReference(cID("null"), layerRef());
    d.putEnumerated(sID("freeTransformCenterState"), sID("quadCenterState"), sID("QCSAverage"));
    d.putUnitDouble(sID("width"), sID("percentUnit"), pw);
    d.putUnitDouble(sID("height"), sID("percentUnit"), ph);
    d.putEnumerated(sID("interpolation"), sID("interpolationType"), sID(interp));
    executeAction(sID("transform"), d, DialogModes.NO);
}
function moveSo(dx, dy) {
    var h = Math.round(dx), v = Math.round(dy);
    if (h === 0 && v === 0) return;
    var d = new ActionDescriptor();
    d.putReference(cID("null"), layerRef());
    var ofs = new ActionDescriptor();
    ofs.putUnitDouble(sID("horizontal"), sID("pixelsUnit"), h);
    ofs.putUnitDouble(sID("vertical"), sID("pixelsUnit"), v);
    d.putObject(sID("to"), sID("offset"), ofs);
    executeAction(sID("move"), d, DialogModes.NO);
}
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
function killDoc(d) { if (d) { try { d.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {} } }
function mkDoc(spec) {
    return app.documents.add(spec.w, spec.h, spec.res, "PROBE6", spec.mode,
                             DocumentFill.WHITE, 1, spec.depth);
}

/* ---- port of place.js integerTarget + planFrame ---- */
function integerTarget(b) {
    var left = Math.round(b.left), top = Math.round(b.top);
    var right = Math.round(b.right), bottom = Math.round(b.bottom);
    return { left: left, top: top, right: right, bottom: bottom,
             w: right - left, h: bottom - top };
}
var ASPECT_TOL = 0.005;
function planFrame(t, nat) {
    var aspectErr = Math.abs((t.w / t.h) / (nat.w / nat.h) - 1);
    if (aspectErr <= ASPECT_TOL) {
        return { mode: "exact", left: t.left, top: t.top, right: t.right, bottom: t.bottom };
    }
    var s = Math.max(t.w / nat.w, t.h / nat.h);
    var fw = Math.round(nat.w * s), fh = Math.round(nat.h * s);
    var left = t.left + Math.round((t.w - fw) / 2);
    var top = t.top + Math.round((t.h - fh) / 2);
    return { mode: "cover", left: left, top: top, right: left + fw, bottom: top + fh };
}

/* ---- port of place.js steps 4-5, verbatim structure ---- */
function shippedPipeline(spec, png, nat, rawBounds) {
    var doc = null, out = { warnings: [], steps: [] };
    try {
        doc = mkDoc(spec);
        var target = integerTarget(rawBounds);
        var dst = planFrame(target, nat);
        out.dst = dst;
        out.target = target;

        placeFile(png);

        /* step 4 */
        try { executeAction(sID("placedLayerResetTransforms"), undefined, DialogModes.NO); }
        catch (e) { out.warnings.push("placedLayerResetTransforms недоступний"); }

        /* step 5 */
        function measure() {
            var f = readSoFrame();
            if (f) {
                var w = f.right - f.left, h = f.bottom - f.top;
                var sane = w > 0.005 && h > 0.005 &&
                    f.left > -3 * doc.width.as("px") && f.right < 4 * doc.width.as("px") &&
                    f.top > -3 * doc.height.as("px") && f.bottom < 4 * doc.height.as("px");
                if (!sane) { out.warnings.push("transform неправдоподібний"); f = null; }
            }
            if (!f) {
                var b = app.activeDocument.activeLayer.bounds;
                f = { left: b[0].as("px"), top: b[1].as("px"),
                      right: b[2].as("px"), bottom: b[3].as("px"), size: null, skewed: false };
                out.warnings.push("резерв на layer.bounds");
            }
            return f;
        }

        var cur = measure();
        out.steps.push("after reset " + fmt(cur) +
                       " size " + (cur.size ? n4(cur.size.w) + "x" + n4(cur.size.h) : "?"));
        if (cur.size && (Math.abs(cur.size.w - nat.w) > 1 || Math.abs(cur.size.h - nat.h) > 1)) {
            out.warnings.push("size != IHDR");
        }
        var tw = dst.right - dst.left, th = dst.bottom - dst.top;
        function hit(f) {
            return Math.abs(dst.left - f.left) < 0.01 && Math.abs(dst.top - f.top) < 0.01 &&
                   Math.abs(tw - (f.right - f.left)) < 0.01 &&
                   Math.abs(th - (f.bottom - f.top)) < 0.01;
        }
        var passes = 0;
        for (var pass = 0; pass < 2 && !hit(cur); pass++) {
            passes++;
            var cw = cur.right - cur.left, ch = cur.bottom - cur.top;
            if (cw < 0.005 || ch < 0.005) { out.warnings.push("рамка виродилась"); break; }
            var pw = tw / cw * 100, ph = th / ch * 100;
            if (Math.abs(pw - 100) > 1e-9 || Math.abs(ph - 100) > 1e-9) {
                scaleSo(pw, ph);
                cur = measure();
                out.steps.push("scale " + fmt(cur) + " pw=" + n4(pw) + "% ph=" + n4(ph) + "%");
            }
            moveSo(dst.left - cur.left, dst.top - cur.top);
            cur = measure();
            out.steps.push("move  " + fmt(cur));
        }
        out.passes = passes;
        out.residual = { dx: dst.left - cur.left, dy: dst.top - cur.top,
                         dw: tw - (cur.right - cur.left), dh: th - (cur.bottom - cur.top) };
        if (cur.skewed) out.warnings.push("неафінний трансформ");
        out.natKept = cur.size ? (Math.abs(cur.size.w - nat.w) < 0.5 &&
                                  Math.abs(cur.size.h - nat.h) < 0.5) : null;
        out.ok = Math.abs(out.residual.dx) < 0.01 && Math.abs(out.residual.dy) < 0.01 &&
                 Math.abs(out.residual.dw) < 0.01 && Math.abs(out.residual.dh) < 0.01;
        out.modeAfter = String(app.activeDocument.mode);
        out.depthAfter = String(app.activeDocument.bitsPerChannel);
        var hs = [];
        for (var i = 0; i < app.activeDocument.historyStates.length; i++) {
            hs.push(app.activeDocument.historyStates[i].name);
        }
        out.converted = /convert|преобраз|перевести/i.test(hs.join(" | "));
        return out;
    } catch (e) { out.err = e.message + (e.line ? (" line " + e.line) : ""); return out; }
    finally { killDoc(doc); }
}

var oldUnits = app.preferences.rulerUnits;
var oldDialogs = app.displayDialogs;
app.preferences.rulerUnits = Units.PIXELS;
app.displayDialogs = DialogModes.NO;

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
    return gp.hasKey(sID("resizePastePlace")) ? gp.getBoolean(sID("resizePastePlace")) : null;
}
function setResize(v) {
    var to = new ActionDescriptor(); to.putBoolean(sID("resizePastePlace"), v);
    var d = new ActionDescriptor(); d.putReference(cID("null"), prefRef());
    d.putObject(sID("to"), sID("generalPreferences"), to);
    executeAction(sID("set"), d, DialogModes.NO);
}
var prefWas = null;

try {
    say("=== probe6: the SHIPPED place.js algorithm ===");
    say("Photoshop " + app.version + " | docs open: " + app.documents.length);
    prefWas = getResize();
    if (prefWas === true) setResize(false);

    var RGB8_300   = { mode: NewDocumentMode.RGB,  depth: BitsPerChannelType.EIGHT,     w: 2000, h: 1500, res: 300 };
    var CMYK8_300  = { mode: NewDocumentMode.CMYK, depth: BitsPerChannelType.EIGHT,     w: 2000, h: 1500, res: 300 };
    var CMYK16_300 = { mode: NewDocumentMode.CMYK, depth: BitsPerChannelType.SIXTEEN,   w: 2000, h: 1500, res: 300 };
    var CMYK8_72   = { mode: NewDocumentMode.CMYK, depth: BitsPerChannelType.EIGHT,     w: 900,  h: 700,  res: 72 };
    var RGB16_72   = { mode: NewDocumentMode.RGB,  depth: BitsPerChannelType.SIXTEEN,   w: 800,  h: 600,  res: 72 };
    var RGB32_300  = { mode: NewDocumentMode.RGB,  depth: BitsPerChannelType.THIRTYTWO, w: 1200, h: 900,  res: 300 };
    var GRAY16_300 = { mode: NewDocumentMode.GRAYSCALE, depth: BitsPerChannelType.SIXTEEN, w: 1200, h: 900, res: 300 };
    var SQ = { w: 1024, h: 1024 }, WD = { w: 1000, h: 600 };

    var CASES = [
        { tag: "RGB8 300  even 200x200",      spec: RGB8_300,   png: PNG_SQ, nat: SQ, b: { left: 400, top: 300, right: 600, bottom: 500 } },
        { tag: "RGB8 300  ODD 201x201",       spec: RGB8_300,   png: PNG_SQ, nat: SQ, b: { left: 333, top: 277, right: 534, bottom: 478 } },
        { tag: "RGB8 300  FRACTIONAL bounds", spec: RGB8_300,   png: PNG_SQ, nat: SQ, b: { left: 332.6, top: 276.4, right: 533.5, bottom: 477.5 } },
        { tag: "RGB8 300  1x1",               spec: RGB8_300,   png: PNG_SQ, nat: SQ, b: { left: 999, top: 749, right: 1000, bottom: 750 } },
        { tag: "RGB8 300  cover 400x400",     spec: RGB8_300,   png: PNG_WD, nat: WD, b: { left: 700, top: 500, right: 1100, bottom: 900 } },
        { tag: "RGB8 300  off-canvas",        spec: RGB8_300,   png: PNG_SQ, nat: SQ, b: { left: 1850, top: 1400, right: 2150, bottom: 1700 } },
        { tag: "RGB8 300  negative origin",   spec: RGB8_300,   png: PNG_SQ, nat: SQ, b: { left: -120, top: -80, right: 180, bottom: 220 } },
        { tag: "RGB8 300  upscale 1601",      spec: RGB8_300,   png: PNG_SQ, nat: SQ, b: { left: 199, top: -51, right: 1800, bottom: 1550 } },
        { tag: "CMYK8 300 ODD 201x201",       spec: CMYK8_300,  png: PNG_SQ, nat: SQ, b: { left: 333, top: 277, right: 534, bottom: 478 } },
        { tag: "CMYK16 300 ODD 201x201",      spec: CMYK16_300, png: PNG_SQ, nat: SQ, b: { left: 333, top: 277, right: 534, bottom: 478 } },
        { tag: "CMYK8 72   ODD 201x201",      spec: CMYK8_72,   png: PNG_SQ, nat: SQ, b: { left: 333, top: 277, right: 534, bottom: 478 } },
        { tag: "RGB16 72   ODD 201x201",      spec: RGB16_72,   png: PNG_SQ, nat: SQ, b: { left: 251, top: 131, right: 452, bottom: 332 } },
        { tag: "RGB32 300  ODD 201x201",      spec: RGB32_300,  png: PNG_SQ, nat: SQ, b: { left: 251, top: 131, right: 452, bottom: 332 } },
        { tag: "GRAY16 300 ODD 201x201",      spec: GRAY16_300, png: PNG_SQ, nat: SQ, b: { left: 251, top: 131, right: 452, bottom: 332 } }
    ];

    var bad = [], conv = [];
    for (var i = 0; i < CASES.length; i++) {
        var r = shippedPipeline(CASES[i].spec, CASES[i].png, CASES[i].nat, CASES[i].b);
        say("");
        say("  " + CASES[i].tag);
        if (r.err) { say("      ERROR: " + r.err); bad.push(CASES[i].tag); continue; }
        say("      target " + fmt(r.target) + " -> dst [" + r.dst.mode + "] " + fmt(r.dst));
        for (var s = 0; s < r.steps.length; s++) say("      " + r.steps[s]);
        say("      residual dx=" + n4(r.residual.dx) + " dy=" + n4(r.residual.dy) +
            " dw=" + n4(r.residual.dw) + " dh=" + n4(r.residual.dh) +
            "  => " + (r.ok ? "EXACT" : "OFF") +
            " | passes=" + r.passes + " | nativeKept=" + r.natKept +
            " | doc " + r.modeAfter + "/" + r.depthAfter +
            (r.converted ? " | CONVERTED!" : ""));
        if (r.warnings.length) say("      warnings: " + r.warnings.join(" ; "));
        if (!r.ok) bad.push(CASES[i].tag);
        if (r.converted) conv.push(CASES[i].tag);
    }

    say("");
    say("RESULT: " + (CASES.length - bad.length) + "/" + CASES.length + " EXACT" +
        (bad.length ? "   FAILED: " + bad.join(" ; ") : "") +
        (conv.length ? "   CONVERTED DOCS: " + conv.join(" ; ") : "   no document was converted"));
    say("docs open at end: " + app.documents.length);
    say("=== end ===");
} catch (e) {
    say("!!! FATAL: " + e.message + (e.line ? (" line " + e.line) : ""));
} finally {
    try { if (prefWas !== null) setResize(prefWas); } catch (e) {}
    try { app.preferences.rulerUnits = oldUnits; } catch (e) {}
    try { app.displayDialogs = oldDialogs; } catch (e) {}
}

try {
    var f = new File(DIR + "/probe6.txt");
    f.encoding = "UTF-8"; f.open("w"); f.write(LOG.join("\n")); f.close();
    RESULT = "probe6 written";
} catch (e) { RESULT = "WRITE FAILED: " + e.message; }

})();

RESULT;
