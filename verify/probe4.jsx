/* =====================================================================
 * probe4.jsx - final descriptor set, zero DOM geometry calls.
 *   scale:  transform / QCSAverage / width+height percentUnit
 *   move:   move / to:<Ofst> horizontal+vertical distanceUnit
 * Tests the charID "T   " key (suspected cause of the probe3 miss),
 * fractional deltas, and interpolation enums.
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
        function num(dd, k) {
            var kk = sID(k); if (!dd.hasKey(kk)) return null;
            var tt = dd.getType(kk);
            if (tt == DescValueType.UNITDOUBLE) return dd.getUnitDoubleValue(kk);
            if (tt == DescValueType.DOUBLETYPE) return dd.getDouble(kk);
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
function layerRef() {
    var r = new ActionReference();
    r.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
    return r;
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
function mkDoc(mode, depth, w, h, res) {
    return app.documents.add(w, h, res, "PROBE4", mode, DocumentFill.WHITE, 1, depth);
}

/* ---------- the two shipping primitives ---------- */

function actScale(pw, ph, interp) {
    var d = new ActionDescriptor();
    d.putReference(cID("null"), layerRef());
    d.putEnumerated(sID("freeTransformCenterState"), sID("quadCenterState"), sID("QCSAverage"));
    d.putUnitDouble(sID("width"), sID("percentUnit"), pw);
    d.putUnitDouble(sID("height"), sID("percentUnit"), ph);
    d.putEnumerated(sID("interpolation"), sID("interpolationType"), sID(interp));
    executeAction(sID("transform"), d, DialogModes.NO);
}
/* variant 1: key via charID "T   " (ScriptListener form) */
function actMoveCharT(dx, dy) {
    var d = new ActionDescriptor();
    d.putReference(cID("null"), layerRef());
    var ofs = new ActionDescriptor();
    ofs.putUnitDouble(sID("horizontal"), sID("distanceUnit"), dx);
    ofs.putUnitDouble(sID("vertical"), sID("distanceUnit"), dy);
    d.putObject(cID("T   "), cID("Ofst"), ofs);
    executeAction(sID("move"), d, DialogModes.NO);
}
/* variant 2: stringID "to" but object class "offset" (probe3 form, was OFF) */
function actMoveSidTo(dx, dy) {
    var d = new ActionDescriptor();
    d.putReference(cID("null"), layerRef());
    var ofs = new ActionDescriptor();
    ofs.putUnitDouble(sID("horizontal"), sID("distanceUnit"), dx);
    ofs.putUnitDouble(sID("vertical"), sID("distanceUnit"), dy);
    d.putObject(sID("to"), sID("offset"), ofs);
    executeAction(sID("move"), d, DialogModes.NO);
}
function domMove(dx, dy) {
    app.activeDocument.activeLayer.translate(new UnitValue(dx, "px"), new UnitValue(dy, "px"));
}

say("=== probe4: shipping descriptor set ===");
say("key ids: sID('to')=" + sID("to") + " cID('T   ')=" + cID("T   ") +
    " | sID('offset')=" + sID("offset") + " cID('Ofst')=" + cID("Ofst"));

var oldUnits = app.preferences.rulerUnits;
var oldDialogs = app.displayDialogs;
app.preferences.rulerUnits = Units.PIXELS;
app.displayDialogs = DialogModes.NO;

/* mirror place.js: kill fit-to-canvas, restore afterwards */
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

function pipeline(spec, png, nat, dst, moveFn) {
    var doc = null, r = { steps: [] };
    try {
        doc = mkDoc(spec.mode, spec.depth, spec.w, spec.h, spec.res);
        placeFile(png);
        var f0 = frames();
        if (!f0 || !f0.t) { r.err = "no frame after place"; return r; }
        r.steps.push("place " + fmt(f0.t));

        var cw = f0.t.right - f0.t.left, ch = f0.t.bottom - f0.t.top;
        var tw = dst.right - dst.left, th = dst.bottom - dst.top;
        var pw = tw / cw * 100, ph = th / ch * 100;
        var interp = (pw >= 100 || ph >= 100) ? "bicubicSmoother" : "bicubicSharper";
        if (Math.abs(pw - 100) > 1e-9 || Math.abs(ph - 100) > 1e-9) {
            actScale(pw, ph, interp);
            r.steps.push("scale " + fmt(frames().t) + "  pw=" + n4(pw) + "% ph=" + n4(ph) + "% " + interp);
        }
        var f1 = frames();
        var dx = dst.left - f1.t.left, dy = dst.top - f1.t.top;
        if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) {
            moveFn(dx, dy);
            r.steps.push("move  " + fmt(frames().t) + "  dx=" + n4(dx) + " dy=" + n4(dy));
        }
        /* one corrective pass, exactly like place.js will do */
        var f2 = frames();
        var dw = tw - (f2.t.right - f2.t.left), dh = th - (f2.t.bottom - f2.t.top);
        if (Math.abs(dw) > 0.005 || Math.abs(dh) > 0.005) {
            actScale(tw / (f2.t.right - f2.t.left) * 100, th / (f2.t.bottom - f2.t.top) * 100, interp);
            var f2b = frames();
            moveFn(dst.left - f2b.t.left, dst.top - f2b.t.top);
            r.steps.push("fix2  " + fmt(frames().t));
        } else {
            var f2c = frames();
            var ddx = dst.left - f2c.t.left, ddy = dst.top - f2c.t.top;
            if (Math.abs(ddx) > 0.005 || Math.abs(ddy) > 0.005) {
                moveFn(ddx, ddy);
                r.steps.push("fix1  " + fmt(frames().t));
            }
        }
        var f3 = frames();
        r.res = { dx: dst.left - f3.t.left, dy: dst.top - f3.t.top,
                  dw: tw - (f3.t.right - f3.t.left), dh: th - (f3.t.bottom - f3.t.top) };
        r.skew = skewed(f3);
        r.natKept = f3.size ? (Math.abs(f3.size.w - nat.w) < 0.5 && Math.abs(f3.size.h - nat.h) < 0.5) : null;
        r.ok = Math.abs(r.res.dx) < 0.005 && Math.abs(r.res.dy) < 0.005 &&
               Math.abs(r.res.dw) < 0.005 && Math.abs(r.res.dh) < 0.005;
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
        "  => " + (r.ok ? "EXACT" : "OFF") + " | skewed=" + r.skew + " | nativeKept=" + r.natKept);
}

try {
    prefWas = getResize();
    if (prefWas === true) setResize(false);

    var RGB8_300   = { mode: NewDocumentMode.RGB,  depth: BitsPerChannelType.EIGHT,   w: 2000, h: 1500, res: 300 };
    var CMYK8_300  = { mode: NewDocumentMode.CMYK, depth: BitsPerChannelType.EIGHT,   w: 2000, h: 1500, res: 300 };
    var CMYK16_300 = { mode: NewDocumentMode.CMYK, depth: BitsPerChannelType.SIXTEEN, w: 2000, h: 1500, res: 300 };
    var RGB16_72   = { mode: NewDocumentMode.RGB,  depth: BitsPerChannelType.SIXTEEN, w: 800,  h: 600,  res: 72 };
    var RGB32_300  = { mode: NewDocumentMode.RGB,  depth: BitsPerChannelType.THIRTYTWO, w: 1200, h: 900, res: 300 };
    var GRAY8_300  = { mode: NewDocumentMode.GRAYSCALE, depth: BitsPerChannelType.EIGHT, w: 1200, h: 900, res: 300 };
    var NAT_SQ = { w: 1024, h: 1024 }, NAT_WD = { w: 1000, h: 600 };
    var ODD = { left: 333, top: 277, right: 534, bottom: 478 };

    say("");
    say("############ which move descriptor is correct ############");
    report("move via charID 'T   ' + class 'Ofst'", pipeline(RGB8_300, PNG_SQ, NAT_SQ, ODD, actMoveCharT));
    report("move via stringID 'to' + class 'offset'", pipeline(RGB8_300, PNG_SQ, NAT_SQ, ODD, actMoveSidTo));
    report("move via DOM translate (reference)", pipeline(RGB8_300, PNG_SQ, NAT_SQ, ODD, domMove));

    /* pick the winner for the matrix */
    var probeT = pipeline(RGB8_300, PNG_SQ, NAT_SQ, ODD, actMoveCharT);
    var MOVE = probeT.ok ? actMoveCharT : domMove;
    say("");
    say("matrix uses: " + (probeT.ok ? "pure action move (charID T)" : "DOM translate fallback"));

    say("");
    say("############ full matrix ############");
    var MATRIX = [
        { tag: "RGB8 300 | even 200x200",        spec: RGB8_300,   png: PNG_SQ, nat: NAT_SQ, dst: { left: 400, top: 300, right: 600, bottom: 500 } },
        { tag: "RGB8 300 | ODD 201x201",         spec: RGB8_300,   png: PNG_SQ, nat: NAT_SQ, dst: ODD },
        { tag: "RGB8 300 | ODD 137x137",         spec: RGB8_300,   png: PNG_SQ, nat: NAT_SQ, dst: { left: 11, top: 7, right: 148, bottom: 144 } },
        { tag: "RGB8 300 | 1x1",                 spec: RGB8_300,   png: PNG_SQ, nat: NAT_SQ, dst: { left: 999, top: 749, right: 1000, bottom: 750 } },
        { tag: "RGB8 300 | cover 667x400",       spec: RGB8_300,   png: PNG_WD, nat: NAT_WD, dst: { left: 567, top: 500, right: 1234, bottom: 900 } },
        { tag: "RGB8 300 | off-canvas",          spec: RGB8_300,   png: PNG_SQ, nat: NAT_SQ, dst: { left: 1850, top: 1400, right: 2150, bottom: 1700 } },
        { tag: "RGB8 300 | negative origin",     spec: RGB8_300,   png: PNG_SQ, nat: NAT_SQ, dst: { left: -120, top: -80, right: 180, bottom: 220 } },
        { tag: "RGB8 300 | upscale 1601x1601",   spec: RGB8_300,   png: PNG_SQ, nat: NAT_SQ, dst: { left: 199, top: -51, right: 1800, bottom: 1550 } },
        { tag: "CMYK8 300 | ODD 201x201",        spec: CMYK8_300,  png: PNG_SQ, nat: NAT_SQ, dst: ODD },
        { tag: "CMYK16 300 | ODD 201x201",       spec: CMYK16_300, png: PNG_SQ, nat: NAT_SQ, dst: ODD },
        { tag: "RGB16 72 | ODD 201x201",         spec: RGB16_72,   png: PNG_SQ, nat: NAT_SQ, dst: { left: 251, top: 131, right: 452, bottom: 332 } },
        { tag: "RGB32 300 | ODD 201x201",        spec: RGB32_300,  png: PNG_SQ, nat: NAT_SQ, dst: { left: 251, top: 131, right: 452, bottom: 332 } },
        { tag: "GRAY8 300 | ODD 201x201",        spec: GRAY8_300,  png: PNG_SQ, nat: NAT_SQ, dst: { left: 251, top: 131, right: 452, bottom: 332 } }
    ];
    var bad = [];
    for (var i = 0; i < MATRIX.length; i++) {
        var r = pipeline(MATRIX[i].spec, MATRIX[i].png, MATRIX[i].nat, MATRIX[i].dst, MOVE);
        if (!r.ok) bad.push(MATRIX[i].tag);
        report(MATRIX[i].tag, r);
    }
    say("");
    say("MATRIX: " + (MATRIX.length - bad.length) + "/" + MATRIX.length + " EXACT" +
        (bad.length ? "   FAILED: " + bad.join(" ; ") : ""));

    /* fractional delta behaviour */
    say("");
    say("############ fractional move ############");
    var fd = null;
    try {
        fd = mkDoc(NewDocumentMode.RGB, BitsPerChannelType.EIGHT, 2000, 1500, 300);
        placeFile(PNG_SQ);
        var b0 = frames().t;
        MOVE(0.25, -0.75);
        var b1 = frames().t;
        say("  before " + fmt(b0));
        say("  after move(0.25,-0.75) " + fmt(b1) +
            "  actual dx=" + n4(b1.left - b0.left) + " dy=" + n4(b1.top - b0.top) +
            "  => " + ((Math.abs(b1.left - b0.left - 0.25) < 0.001 &&
                        Math.abs(b1.top - b0.top + 0.75) < 0.001) ? "fractional honoured"
                                                                  : "fractional NOT honoured (rounded)"));
        killDoc(fd); fd = null;
    } catch (e) { say("  error: " + e.message); killDoc(fd); }

    say("");
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
    var f = new File(DIR + "/probe4.txt");
    f.encoding = "UTF-8"; f.open("w"); f.write(LOG.join("\n")); f.close();
    RESULT = "probe4 written";
} catch (e) { RESULT = "WRITE FAILED: " + e.message; }

})();

RESULT;
