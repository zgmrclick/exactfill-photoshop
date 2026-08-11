/* =====================================================================
 * probe3.jsx - nail down a batchPlay-expressible descriptor that scales a
 * placed Smart Object EXACTLY, so the plugin does not depend on a DOM
 * wrapper. Also: fractional translate, off-canvas, CMYK/16-bit parity.
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
function frames() {
    var r = new ActionReference();
    r.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
    var d = executeActionGet(r);
    if (!d.hasKey(sID("smartObjectMore"))) return null;
    var more = d.getObjectValue(sID("smartObjectMore"));
    function grab(key) {
        if (!more.hasKey(sID(key))) return null;
        var l = more.getList(sID(key));
        if (l.count < 8) return null;
        var q = []; for (var i = 0; i < 8; i++) q.push(listNum(l, i));
        var xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
        return { left: Math.min.apply(null, xs), right: Math.max.apply(null, xs),
                 top: Math.min.apply(null, ys), bottom: Math.max.apply(null, ys), quad: q };
    }
    var out = { t: grab("transform"), n: grab("nonAffineTransform") };
    if (more.hasKey(sID("size"))) {
        var sz = more.getObjectValue(sID("size"));
        function num(d2, k) {
            var kk = sID(k); if (!d2.hasKey(kk)) return null;
            var tt = d2.getType(kk);
            if (tt == DescValueType.UNITDOUBLE) return d2.getUnitDoubleValue(kk);
            if (tt == DescValueType.DOUBLETYPE) return d2.getDouble(kk);
            return null;
        }
        out.size = { w: num(sz, "width"), h: num(sz, "height") };
    }
    return out;
}
function skewed(f) {
    if (!f || !f.t || !f.n) return null;
    for (var i = 0; i < 8; i++) if (Math.abs(f.t.quad[i] - f.n.quad[i]) > 0.001) return true;
    return false;
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
function layerRef() {
    var r = new ActionReference();
    r.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
    return r;
}
function killDoc(d) { if (d) { try { d.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {} } }

/* ---- candidate SCALE descriptors, all executeAction (== batchPlay) ---- */

/* H: centre-anchored percent scale, nothing else */
function scaleH(pw, ph) {
    var d = new ActionDescriptor();
    d.putReference(cID("null"), layerRef());
    d.putEnumerated(sID("freeTransformCenterState"), sID("quadCenterState"), sID("QCSAverage"));
    d.putUnitDouble(sID("width"), sID("percentUnit"), pw);
    d.putUnitDouble(sID("height"), sID("percentUnit"), ph);
    d.putEnumerated(sID("interpolation"), sID("interpolationType"), sID("bicubicSharper"));
    executeAction(sID("transform"), d, DialogModes.NO);
}
/* I: independent centre pinned to top-left via position in percent of bbox */
function scaleI(pw, ph) {
    var d = new ActionDescriptor();
    d.putReference(cID("null"), layerRef());
    d.putEnumerated(sID("freeTransformCenterState"), sID("quadCenterState"), sID("QCSIndependent"));
    var pos = new ActionDescriptor();
    pos.putUnitDouble(sID("horizontal"), sID("percentUnit"), 0);
    pos.putUnitDouble(sID("vertical"), sID("percentUnit"), 0);
    d.putObject(sID("position"), sID("position"), pos);
    d.putUnitDouble(sID("width"), sID("percentUnit"), pw);
    d.putUnitDouble(sID("height"), sID("percentUnit"), ph);
    d.putEnumerated(sID("interpolation"), sID("interpolationType"), sID("bicubicSharper"));
    executeAction(sID("transform"), d, DialogModes.NO);
}
/* DOM reference implementation, known EXACT from probe2 */
function scaleDom(pw, ph) {
    app.activeDocument.activeLayer.resize(pw, ph, AnchorPosition.TOPLEFT);
}

/* ---- translate variants ---- */
function transDomPx(dx, dy) {
    app.activeDocument.activeLayer.translate(new UnitValue(dx, "px"), new UnitValue(dy, "px"));
}
function transDomBare(dx, dy) {
    app.activeDocument.activeLayer.translate(dx, dy);
}
/* batchPlay move with #Rlt as an OBJECT-less pair, the form the DOM really uses */
function transAction(dx, dy) {
    var d = new ActionDescriptor();
    d.putReference(cID("null"), layerRef());
    var ofs = new ActionDescriptor();
    ofs.putUnitDouble(sID("horizontal"), sID("distanceUnit"), dx);
    ofs.putUnitDouble(sID("vertical"), sID("distanceUnit"), dy);
    d.putObject(sID("to"), sID("offset"), ofs);
    executeAction(sID("move"), d, DialogModes.NO);
}

/* ===================== main ===================== */

var oldUnits = app.preferences.rulerUnits;
var oldDialogs = app.displayDialogs;
app.preferences.rulerUnits = Units.PIXELS;
app.displayDialogs = DialogModes.NO;

function mkDoc(mode, depth, w, h, res) {
    return app.documents.add(w, h, res, "PROBE3", mode, DocumentFill.WHITE, 1, depth);
}

/** one full run: place -> scale -> measure -> translate -> measure */
function pipeline(docSpec, png, nat, dst, scaleFn, transFn) {
    var doc = null;
    var r = { steps: [], ok: false };
    try {
        doc = mkDoc(docSpec.mode, docSpec.depth, docSpec.w, docSpec.h, docSpec.res);
        placeFile(png);
        var f0 = frames();
        if (!f0 || !f0.t) { r.err = "no frame after place"; return r; }
        r.steps.push("place  " + fmt(f0.t) + " size " +
                     (f0.size ? n4(f0.size.w) + "x" + n4(f0.size.h) : "?"));

        var cw = f0.t.right - f0.t.left, ch = f0.t.bottom - f0.t.top;
        var pw = (dst.right - dst.left) / cw * 100, ph = (dst.bottom - dst.top) / ch * 100;
        if (Math.abs(pw - 100) > 1e-9 || Math.abs(ph - 100) > 1e-9) {
            try { scaleFn(pw, ph); } catch (e) { r.steps.push("scale THREW: " + e.message); }
            var f1 = frames();
            r.steps.push("scale  " + (f1 && f1.t ? fmt(f1.t) : "null") +
                         "  (pw=" + n4(pw) + "% ph=" + n4(ph) + "%)");
        }
        var f2 = frames();
        if (!f2 || !f2.t) { r.err = "no frame after scale"; return r; }
        var dx = dst.left - f2.t.left, dy = dst.top - f2.t.top;
        if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) {
            try { transFn(dx, dy); } catch (e) { r.steps.push("move THREW: " + e.message); }
            r.steps.push("move   " + fmt(frames().t) + "  (dx=" + n4(dx) + " dy=" + n4(dy) + ")");
        }
        var f3 = frames();
        r.res = {
            dx: dst.left - f3.t.left, dy: dst.top - f3.t.top,
            dw: (dst.right - dst.left) - (f3.t.right - f3.t.left),
            dh: (dst.bottom - dst.top) - (f3.t.bottom - f3.t.top)
        };
        r.skew = skewed(f3);
        r.natKept = f3.size ? (Math.abs(f3.size.w - nat.w) < 0.5 && Math.abs(f3.size.h - nat.h) < 0.5) : null;
        r.ok = Math.abs(r.res.dx) < 0.01 && Math.abs(r.res.dy) < 0.01 &&
               Math.abs(r.res.dw) < 0.01 && Math.abs(r.res.dh) < 0.01;
        return r;
    } catch (e) { r.err = e.message; return r; }
    finally { killDoc(doc); }
}
function report(label, r) {
    say("");
    say("  " + label);
    for (var i = 0; i < r.steps.length; i++) say("      " + r.steps[i]);
    if (r.err) { say("      ERROR: " + r.err); return; }
    say("      residual dx=" + n4(r.res.dx) + " dy=" + n4(r.res.dy) +
        " dw=" + n4(r.res.dw) + " dh=" + n4(r.res.dh) +
        "  => " + (r.ok ? "EXACT" : "OFF") +
        " | skewed=" + r.skew + " | nativeRasterKept=" + r.natKept);
}

try {
    say("=== probe3: exact scale+move descriptor ===");
    say("Photoshop " + app.version + " | docs open: " + app.documents.length);

    var RGB8_300 = { mode: NewDocumentMode.RGB, depth: BitsPerChannelType.EIGHT, w: 2000, h: 1500, res: 300 };
    var CMYK16_300 = { mode: NewDocumentMode.CMYK, depth: BitsPerChannelType.SIXTEEN, w: 2000, h: 1500, res: 300 };
    var RGB16_72 = { mode: NewDocumentMode.RGB, depth: BitsPerChannelType.SIXTEEN, w: 800, h: 600, res: 72 };
    var NAT_SQ = { w: 1024, h: 1024 }, NAT_WD = { w: 1000, h: 600 };

    /* --- part 1: which SCALE descriptor is exact --- */
    say("");
    say("############ scale descriptor, target ODD 201x201 at (333,277), RGB8 ############");
    var DST_ODD = { left: 333, top: 277, right: 534, bottom: 478 };
    report("H. transform QCSAverage + width/height percent  -> then DOM translate",
        pipeline(RGB8_300, PNG_SQ, NAT_SQ, DST_ODD, scaleH, transDomPx));
    report("I. transform QCSIndependent + position 0%,0% + percent -> then DOM translate",
        pipeline(RGB8_300, PNG_SQ, NAT_SQ, DST_ODD, scaleI, transDomPx));
    report("DOM. resize(TOPLEFT) -> DOM translate  [reference from probe2]",
        pipeline(RGB8_300, PNG_SQ, NAT_SQ, DST_ODD, scaleDom, transDomPx));

    /* --- part 2: translate variants against the winning scale --- */
    say("");
    say("############ translate variants (scale = DOM resize) ############");
    report("translate: DOM with UnitValue px",
        pipeline(RGB8_300, PNG_SQ, NAT_SQ, DST_ODD, scaleDom, transDomPx));
    report("translate: DOM with bare numbers",
        pipeline(RGB8_300, PNG_SQ, NAT_SQ, DST_ODD, scaleDom, transDomBare));
    report("translate: executeAction move, to:{offset horizontal/vertical distanceUnit}",
        pipeline(RGB8_300, PNG_SQ, NAT_SQ, DST_ODD, scaleDom, transAction));

    /* --- part 3: awkward ratios, cover, off-canvas, 1x1 --- */
    say("");
    say("############ hard geometry (scale = winner from part 1 = H if exact else DOM) ############");
    var hardScale = scaleH;
    var probeH = pipeline(RGB8_300, PNG_SQ, NAT_SQ, DST_ODD, scaleH, transDomPx);
    if (!probeH.ok) { hardScale = scaleDom; say("  (H not exact -> hard cases use DOM resize)"); }
    else { say("  (H is exact -> hard cases use pure executeAction path)"); }

    var HARD = [
        { tag: "137x137 from 1024 (pw=13.3789%)", spec: RGB8_300, png: PNG_SQ, nat: NAT_SQ,
          dst: { left: 11, top: 7, right: 148, bottom: 144 } },
        { tag: "1x1 px at (999,749)", spec: RGB8_300, png: PNG_SQ, nat: NAT_SQ,
          dst: { left: 999, top: 749, right: 1000, bottom: 750 } },
        { tag: "cover 667x400 from 1000x600 at (567,500)", spec: RGB8_300, png: PNG_WD, nat: NAT_WD,
          dst: { left: 567, top: 500, right: 1234, bottom: 900 } },
        { tag: "OFF-CANVAS 300x300 at (1850,1400)", spec: RGB8_300, png: PNG_SQ, nat: NAT_SQ,
          dst: { left: 1850, top: 1400, right: 2150, bottom: 1700 } },
        { tag: "NEGATIVE origin 300x300 at (-120,-80)", spec: RGB8_300, png: PNG_SQ, nat: NAT_SQ,
          dst: { left: -120, top: -80, right: 180, bottom: 220 } },
        { tag: "UPSCALE 1600x1600 from 1024", spec: RGB8_300, png: PNG_SQ, nat: NAT_SQ,
          dst: { left: 200, top: -50, right: 1800, bottom: 1550 } },
        { tag: "CMYK 16-bit, ODD 201x201", spec: CMYK16_300, png: PNG_SQ, nat: NAT_SQ,
          dst: { left: 251, top: 131, right: 452, bottom: 332 } },
        { tag: "RGB 16-bit 72ppi 800x600, ODD 201x201", spec: RGB16_72, png: PNG_SQ, nat: NAT_SQ,
          dst: { left: 251, top: 131, right: 452, bottom: 332 } }
    ];
    var allOk = true;
    for (var i = 0; i < HARD.length; i++) {
        var r = pipeline(HARD[i].spec, HARD[i].png, HARD[i].nat, HARD[i].dst, hardScale, transDomPx);
        if (!r.ok) allOk = false;
        report(HARD[i].tag, r);
    }
    say("");
    say("ALL HARD CASES EXACT: " + allOk);

    /* --- part 4: is the 72ppi doc placing our 300ppi png at native size? --- */
    say("");
    say("############ pHYs must equal DOCUMENT ppi, not 300 ############");
    var dd = null;
    try {
        dd = mkDoc(NewDocumentMode.RGB, BitsPerChannelType.EIGHT, 800, 600, 72);
        placeFile(PNG_SQ);           /* pHYs = 300 in a 72 ppi doc */
        var fz = frames();
        say("  1024px pHYs=300 into a 72ppi doc -> " + fmt(fz.t) +
            "  (expect 1024*72/300 = 245.76 if PPI scaling applies)");
        killDoc(dd); dd = null;
        dd = mkDoc(NewDocumentMode.RGB, BitsPerChannelType.EIGHT, 800, 600, 72);
        placeFile(DIR + "/vt_1024_p72.png");
        var fz2 = frames();
        say("  1024px pHYs=72  into a 72ppi doc -> " + fmt(fz2.t) + "  (expect 1024 native)");
        killDoc(dd); dd = null;
    } catch (e) { say("  part4 error: " + e.message); killDoc(dd); }

    say("");
    say("docs open at end: " + app.documents.length);
    say("=== end ===");
} catch (e) {
    say("!!! FATAL: " + e.message + (e.line ? (" line " + e.line) : ""));
} finally {
    try { app.preferences.rulerUnits = oldUnits; } catch (e) {}
    try { app.displayDialogs = oldDialogs; } catch (e) {}
}

try {
    var f = new File(DIR + "/probe3.txt");
    f.encoding = "UTF-8"; f.open("w"); f.write(LOG.join("\n")); f.close();
    RESULT = "probe3 written";
} catch (e) { RESULT = "WRITE FAILED: " + e.message; }

})();

RESULT;
