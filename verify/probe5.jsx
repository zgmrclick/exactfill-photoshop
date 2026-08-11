/* =====================================================================
 * probe5.jsx - (a) a pure-action move that is correct, (b) the layer-mask
 * from saved-selection path used by place.js:applySelectionMask.
 * ASCII only.
 * ===================================================================== */

var RESULT = "";

(function () {

var DIR = "/private/tmp/claude-501/-Users-zg-mrclick/aac28652-71d2-4dd7-bb5c-b1277bfa35c2/scratchpad/psverify";
var PNG_SQ = DIR + "/vt_1024_p300.png";
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
function layerDesc() {
    var r = new ActionReference();
    r.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
    return executeActionGet(r);
}
function frameOf() {
    var d = layerDesc();
    if (!d.hasKey(sID("smartObjectMore"))) return null;
    var more = d.getObjectValue(sID("smartObjectMore"));
    if (!more.hasKey(sID("transform"))) return null;
    var l = more.getList(sID("transform"));
    if (l.count < 8) return null;
    var q = []; for (var i = 0; i < 8; i++) q.push(listNum(l, i));
    var xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    return { left: Math.min.apply(null, xs), right: Math.max.apply(null, xs),
             top: Math.min.apply(null, ys), bottom: Math.max.apply(null, ys) };
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
    return app.documents.add(w, h, res, "PROBE5", mode, DocumentFill.WHITE, 1, depth);
}
function actScale(pw, ph, interp) {
    var d = new ActionDescriptor();
    d.putReference(cID("null"), layerRef());
    d.putEnumerated(sID("freeTransformCenterState"), sID("quadCenterState"), sID("QCSAverage"));
    d.putUnitDouble(sID("width"), sID("percentUnit"), pw);
    d.putUnitDouble(sID("height"), sID("percentUnit"), ph);
    d.putEnumerated(sID("interpolation"), sID("interpolationType"), sID(interp));
    executeAction(sID("transform"), d, DialogModes.NO);
}
/* move variants */
function movePixelsUnit(dx, dy) {
    var d = new ActionDescriptor();
    d.putReference(cID("null"), layerRef());
    var ofs = new ActionDescriptor();
    ofs.putUnitDouble(sID("horizontal"), sID("pixelsUnit"), dx);
    ofs.putUnitDouble(sID("vertical"), sID("pixelsUnit"), dy);
    d.putObject(sID("to"), sID("offset"), ofs);
    executeAction(sID("move"), d, DialogModes.NO);
}
function moveDistanceScaled(dx, dy) {
    var k = 72 / app.activeDocument.resolution;   /* px -> points */
    var d = new ActionDescriptor();
    d.putReference(cID("null"), layerRef());
    var ofs = new ActionDescriptor();
    ofs.putUnitDouble(sID("horizontal"), sID("distanceUnit"), dx * k);
    ofs.putUnitDouble(sID("vertical"), sID("distanceUnit"), dy * k);
    d.putObject(sID("to"), sID("offset"), ofs);
    executeAction(sID("move"), d, DialogModes.NO);
}

var oldUnits = app.preferences.rulerUnits;
var oldDialogs = app.displayDialogs;
app.preferences.rulerUnits = Units.PIXELS;
app.displayDialogs = DialogModes.NO;

try {
    say("=== probe5 ===");
    say("Photoshop " + app.version);

    /* ---------- (a) move variants, at 300 ppi AND 72 ppi ---------- */
    var MV = [
        { name: "move + pixelsUnit", fn: movePixelsUnit },
        { name: "move + distanceUnit * 72/ppi", fn: moveDistanceScaled }
    ];
    var DOCS = [
        { tag: "300 ppi", res: 300, w: 2000, h: 1500 },
        { tag: "72 ppi",  res: 72,  w: 2000, h: 1500 }
    ];
    for (var dq = 0; dq < DOCS.length; dq++) {
        say("");
        say("######## move descriptors, " + DOCS[dq].tag + " document ########");
        for (var mq = 0; mq < MV.length; mq++) {
            var doc = null;
            try {
                doc = mkDoc(NewDocumentMode.RGB, BitsPerChannelType.EIGHT,
                            DOCS[dq].w, DOCS[dq].h, DOCS[dq].res);
                placeFile(PNG_SQ);
                var f0 = frameOf();
                var want = { dx: -567, dy: -373 };
                var threw = null;
                try { MV[mq].fn(want.dx, want.dy); } catch (e) { threw = e.message; }
                var f1 = frameOf();
                var gotx = f1.left - f0.left, goty = f1.top - f0.top;
                say("  " + MV[mq].name + ": asked (" + want.dx + "," + want.dy + ") got (" +
                    n4(gotx) + "," + n4(goty) + ") => " +
                    ((Math.abs(gotx - want.dx) < 0.01 && Math.abs(goty - want.dy) < 0.01)
                        ? "CORRECT" : "WRONG") + (threw ? "  THREW: " + threw : ""));
                killDoc(doc); doc = null;
            } catch (e) { say("  " + MV[mq].name + ": error " + e.message); killDoc(doc); }
        }
    }

    /* ---------- (b) layer mask from a saved selection channel ---------- */
    say("");
    say("######## applySelectionMask path ########");
    var md = null;
    try {
        md = mkDoc(NewDocumentMode.CMYK, BitsPerChannelType.SIXTEEN, 2000, 1500, 300);
        var SEL = { left: 333, top: 277, right: 534, bottom: 478 };

        /* 1. rectangular selection */
        var selDesc = new ActionDescriptor();
        var selRef = new ActionReference(); selRef.putProperty(sID("channel"), sID("selection"));
        selDesc.putReference(cID("null"), selRef);
        var rect = new ActionDescriptor();
        rect.putUnitDouble(sID("top"), sID("pixelsUnit"), SEL.top);
        rect.putUnitDouble(sID("left"), sID("pixelsUnit"), SEL.left);
        rect.putUnitDouble(sID("bottom"), sID("pixelsUnit"), SEL.bottom);
        rect.putUnitDouble(sID("right"), sID("pixelsUnit"), SEL.right);
        selDesc.putObject(sID("to"), sID("rectangle"), rect);
        executeAction(sID("set"), selDesc, DialogModes.NO);
        say("  selection made: " + SEL.left + "," + SEL.top + " " +
            (SEL.right - SEL.left) + "x" + (SEL.bottom - SEL.top));

        /* 2. save it to an alpha channel, same as main.js does */
        var CH = "aiSel";
        var dup = new ActionDescriptor();
        var dupRef = new ActionReference(); dupRef.putProperty(sID("channel"), sID("selection"));
        dup.putReference(cID("null"), dupRef);
        dup.putString(sID("name"), CH);
        executeAction(sID("duplicate"), dup, DialogModes.NO);
        var chNames = [];
        for (var c = 0; c < md.channels.length; c++) chNames.push(md.channels[c].name);
        say("  channels now: [" + chNames.join(", ") + "]");

        /* 3. drop the selection, place, position exactly */
        executeAction(sID("set"), (function () {
            var d = new ActionDescriptor();
            var r = new ActionReference(); r.putProperty(sID("channel"), sID("selection"));
            d.putReference(cID("null"), r);
            d.putEnumerated(sID("to"), sID("ordinal"), sID("none"));
            return d;
        })(), DialogModes.NO);

        placeFile(PNG_SQ);
        var c0 = frameOf();
        var pw = (SEL.right - SEL.left) / (c0.right - c0.left) * 100;
        var ph = (SEL.bottom - SEL.top) / (c0.bottom - c0.top) * 100;
        actScale(pw, ph, "bicubicSharper");
        var c1 = frameOf();
        app.activeDocument.activeLayer.translate(new UnitValue(SEL.left - c1.left, "px"),
                                                 new UnitValue(SEL.top - c1.top, "px"));
        say("  SO placed at " + fmt(frameOf()));

        /* 4. restore selection FROM the channel */
        var res = new ActionDescriptor();
        var resRef = new ActionReference(); resRef.putProperty(sID("channel"), sID("selection"));
        res.putReference(cID("null"), resRef);
        var chRef = new ActionReference(); chRef.putName(sID("channel"), CH);
        res.putReference(sID("to"), chRef);
        executeAction(sID("set"), res, DialogModes.NO);
        say("  selection restored from channel '" + CH + "': ok");

        /* 5. add a layer mask revealing the selection */
        var mk = new ActionDescriptor();
        var newDesc = new ActionDescriptor();
        mk.putClass(sID("new"), sID("channel"));
        var atRef = new ActionReference();
        atRef.putEnumerated(sID("channel"), sID("channel"), sID("mask"));
        mk.putReference(sID("at"), atRef);
        mk.putEnumerated(sID("using"), sID("userMaskEnabled"), sID("revealSelection"));
        executeAction(sID("make"), mk, DialogModes.NO);

        var ld = layerDesc();
        var hasMask = ld.hasKey(sID("userMaskEnabled")) ? ld.getBoolean(sID("userMaskEnabled")) : null;
        var lay = app.activeDocument.activeLayer;
        var b = lay.bounds;
        say("  layer mask created: userMaskEnabled=" + hasMask);
        say("  layer.bounds after mask: L" + n4(b[0].as("px")) + " T" + n4(b[1].as("px")) +
            " R" + n4(b[2].as("px")) + " B" + n4(b[3].as("px")) +
            "  (selection was " + SEL.left + "," + SEL.top + ".." + SEL.right + "," + SEL.bottom + ")");
        say("  transform frame still: " + fmt(frameOf()));
        say("  doc mode/depth after everything: " + String(md.mode) + " / " + String(md.bitsPerChannel));
        var hist = [];
        for (var hh = 0; hh < md.historyStates.length; hh++) hist.push(md.historyStates[hh].name);
        say("  history: [" + hist.join(" | ") + "]");

        killDoc(md); md = null;
    } catch (e) {
        say("  MASK PATH ERROR: " + e.message + (e.line ? (" line " + e.line) : ""));
        killDoc(md); md = null;
    }

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
    var f = new File(DIR + "/probe5.txt");
    f.encoding = "UTF-8"; f.open("w"); f.write(LOG.join("\n")); f.close();
    RESULT = "probe5 written";
} catch (e) { RESULT = "WRITE FAILED: " + e.message; }

})();

RESULT;
