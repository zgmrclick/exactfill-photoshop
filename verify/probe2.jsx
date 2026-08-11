/* =====================================================================
 * probe2.jsx - find a mechanism that actually moves/scales a placed SO.
 * Each mechanism gets a FRESH document + FRESH place, so nothing leaks.
 * ASCII only.
 * ===================================================================== */

var RESULT = "";

(function () {

var DIR = "/private/tmp/claude-501/-Users-zg-mrclick/aac28652-71d2-4dd7-bb5c-b1277bfa35c2/scratchpad/psverify";
var PNG = DIR + "/vt_1024_p300.png";
var sID = stringIDToTypeID, cID = charIDToTypeID;

var LOG = [];
function say(s) { LOG.push(String(s)); }
function n3(v) { return (v === null || v === undefined) ? "null" : String(Math.round(v * 1000) / 1000); }
function fmt(f) {
    if (!f) return "null";
    return "L" + n3(f.left) + " T" + n3(f.top) + " R" + n3(f.right) + " B" + n3(f.bottom) +
           " (" + n3(f.right - f.left) + "x" + n3(f.bottom - f.top) + ")";
}

function listNum(l, i) {
    var t = l.getType(i);
    if (t == DescValueType.DOUBLETYPE) return l.getDouble(i);
    if (t == DescValueType.UNITDOUBLE) return l.getUnitDoubleValue(i);
    if (t == DescValueType.INTEGERTYPE) return l.getInteger(i);
    return null;
}
function frameOf() {
    var r = new ActionReference();
    r.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
    var d = executeActionGet(r);
    if (!d.hasKey(sID("smartObjectMore"))) return null;
    var more = d.getObjectValue(sID("smartObjectMore"));
    if (!more.hasKey(sID("transform"))) return null;
    var l = more.getList(sID("transform"));
    if (l.count < 8) return null;
    var q = [];
    for (var i = 0; i < 8; i++) q.push(listNum(l, i));
    var xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    return { left: Math.min.apply(null, xs), right: Math.max.apply(null, xs),
             top: Math.min.apply(null, ys), bottom: Math.max.apply(null, ys), quad: q };
}
function dumpMore() {
    var r = new ActionReference();
    r.putEnumerated(sID("layer"), sID("ordinal"), sID("targetEnum"));
    var d = executeActionGet(r);
    if (!d.hasKey(sID("smartObjectMore"))) return "(no smartObjectMore)";
    var more = d.getObjectValue(sID("smartObjectMore"));
    var out = [];
    for (var i = 0; i < more.count; i++) {
        var k = more.getKey(i);
        var name = typeIDToStringID(k);
        var t = more.getType(k);
        var v = "";
        if (t == DescValueType.LISTTYPE) {
            var l = more.getList(k);
            var vals = [];
            for (var j = 0; j < l.count && j < 12; j++) vals.push(n3(listNum(l, j)));
            v = "[" + vals.join(", ") + "]";
        } else if (t == DescValueType.BOOLEANTYPE) { v = String(more.getBoolean(k)); }
        else if (t == DescValueType.DOUBLETYPE) { v = n3(more.getDouble(k)); }
        else if (t == DescValueType.INTEGERTYPE) { v = String(more.getInteger(k)); }
        else if (t == DescValueType.OBJECTTYPE) { v = "{object}"; }
        else if (t == DescValueType.STRINGTYPE) { v = more.getString(k); }
        else { v = "(type " + t + ")"; }
        out.push("    " + name + " = " + v);
    }
    return out.join("\n");
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
function newDoc() {
    return app.documents.add(2000, 1500, 300, "PROBE", NewDocumentMode.RGB,
                             DocumentFill.WHITE, 1, BitsPerChannelType.EIGHT);
}
function killDoc(d) { if (d) { try { d.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {} } }

/* ---- mechanisms. Each returns a description; frame measured by caller. ---- */

var MECHS = [];

MECHS.push({ name: "A. transform rect->quad, pixelsUnit lists (current place.js)", run: function (cur, dst) {
    var d = new ActionDescriptor();
    d.putReference(cID("null"), layerRef());
    d.putEnumerated(sID("freeTransformCenterState"), sID("quadCenterState"), sID("QCSAverage"));
    var r = new ActionList(); var q = new ActionList();
    var rv = [cur.left, cur.top, cur.right, cur.bottom];
    var qv = [dst.left, dst.top, dst.right, dst.top, dst.right, dst.bottom, dst.left, dst.bottom];
    for (var i = 0; i < 4; i++) r.putUnitDouble(sID("pixelsUnit"), rv[i]);
    for (var j = 0; j < 8; j++) q.putUnitDouble(sID("pixelsUnit"), qv[j]);
    d.putList(sID("rectangle"), r);
    d.putList(sID("quadrilateral"), q);
    d.putEnumerated(sID("interpolation"), sID("interpolationType"), sID("bicubicSharper"));
    executeAction(sID("transform"), d, DialogModes.NO);
}});

MECHS.push({ name: "B. transform rect->quad, distanceUnit (#Rlt) lists", run: function (cur, dst) {
    var d = new ActionDescriptor();
    d.putReference(cID("null"), layerRef());
    d.putEnumerated(sID("freeTransformCenterState"), sID("quadCenterState"), sID("QCSAverage"));
    var r = new ActionList(); var q = new ActionList();
    var rv = [cur.left, cur.top, cur.right, cur.bottom];
    var qv = [dst.left, dst.top, dst.right, dst.top, dst.right, dst.bottom, dst.left, dst.bottom];
    for (var i = 0; i < 4; i++) r.putUnitDouble(sID("distanceUnit"), rv[i]);
    for (var j = 0; j < 8; j++) q.putUnitDouble(sID("distanceUnit"), qv[j]);
    d.putList(sID("rectangle"), r);
    d.putList(sID("quadrilateral"), q);
    d.putEnumerated(sID("interpolation"), sID("interpolationType"), sID("bicubicSharper"));
    executeAction(sID("transform"), d, DialogModes.NO);
}});

MECHS.push({ name: "C. transform rect->quad, plain doubles (no unit)", run: function (cur, dst) {
    var d = new ActionDescriptor();
    d.putReference(cID("null"), layerRef());
    d.putEnumerated(sID("freeTransformCenterState"), sID("quadCenterState"), sID("QCSAverage"));
    var r = new ActionList(); var q = new ActionList();
    var rv = [cur.left, cur.top, cur.right, cur.bottom];
    var qv = [dst.left, dst.top, dst.right, dst.top, dst.right, dst.bottom, dst.left, dst.bottom];
    for (var i = 0; i < 4; i++) r.putDouble(rv[i]);
    for (var j = 0; j < 8; j++) q.putDouble(qv[j]);
    d.putList(sID("rectangle"), r);
    d.putList(sID("quadrilateral"), q);
    executeAction(sID("transform"), d, DialogModes.NO);
}});

MECHS.push({ name: "D. transform: offset px + width/height percent (classic recorded Free Transform)",
  run: function (cur, dst) {
    var cw = cur.right - cur.left, ch = cur.bottom - cur.top;
    var pw = (dst.right - dst.left) / cw * 100, ph = (dst.bottom - dst.top) / ch * 100;
    // QCSAverage anchors at the centre, so offset is centre-to-centre
    var dxc = ((dst.left + dst.right) / 2) - ((cur.left + cur.right) / 2);
    var dyc = ((dst.top + dst.bottom) / 2) - ((cur.top + cur.bottom) / 2);
    var d = new ActionDescriptor();
    d.putReference(cID("null"), layerRef());
    d.putEnumerated(sID("freeTransformCenterState"), sID("quadCenterState"), sID("QCSAverage"));
    var ofs = new ActionDescriptor();
    ofs.putUnitDouble(sID("horizontal"), sID("distanceUnit"), dxc);
    ofs.putUnitDouble(sID("vertical"), sID("distanceUnit"), dyc);
    d.putObject(sID("offset"), sID("offset"), ofs);
    d.putUnitDouble(sID("width"), sID("percentUnit"), pw);
    d.putUnitDouble(sID("height"), sID("percentUnit"), ph);
    d.putEnumerated(sID("interpolation"), sID("interpolationType"), sID("bicubicSharper"));
    executeAction(sID("transform"), d, DialogModes.NO);
}});

MECHS.push({ name: "E. DOM: activeLayer.resize(pw,ph,TOPLEFT) then translate(dx,dy)",
  run: function (cur, dst) {
    var lay = app.activeDocument.activeLayer;
    var cw = cur.right - cur.left, ch = cur.bottom - cur.top;
    lay.resize((dst.right - dst.left) / cw * 100, (dst.bottom - dst.top) / ch * 100,
               AnchorPosition.TOPLEFT);
    var f2 = frameOf();
    lay.translate(new UnitValue(dst.left - f2.left, "px"), new UnitValue(dst.top - f2.top, "px"));
}});

MECHS.push({ name: "F. batchPlay move with distanceUnit (translate only, no scale)",
  run: function (cur, dst) {
    var d = new ActionDescriptor();
    d.putReference(cID("null"), layerRef());
    d.putUnitDouble(sID("horizontal"), sID("distanceUnit"), dst.left - cur.left);
    d.putUnitDouble(sID("vertical"), sID("distanceUnit"), dst.top - cur.top);
    executeAction(sID("move"), d, DialogModes.NO);
}});

MECHS.push({ name: "G. DOM translate only, no scale", run: function (cur, dst) {
    app.activeDocument.activeLayer.translate(new UnitValue(dst.left - cur.left, "px"),
                                             new UnitValue(dst.top - cur.top, "px"));
}});

/* ===================== main ===================== */

var oldUnits = app.preferences.rulerUnits;
var oldDialogs = app.displayDialogs;
app.preferences.rulerUnits = Units.PIXELS;
app.displayDialogs = DialogModes.NO;

try {
    say("=== probe2: which mechanism actually moves a placed Smart Object ===");
    say("Photoshop " + app.version + " | docs open: " + app.documents.length);

    /* full smartObjectMore dump - is nonAffineTransform always present? */
    var d0 = null;
    try {
        d0 = newDoc();
        placeFile(PNG);
        say("");
        say("--- full smartObjectMore right after a clean place (no transform yet) ---");
        say(dumpMore());
        killDoc(d0); d0 = null;
    } catch (e) { say("dump failed: " + e.message); killDoc(d0); d0 = null; }

    /* two targets: pure translate (same size) and translate+scale */
    var TARGETS = [
        { tag: "MOVE-ONLY 1024x1024 to L100 T100", dst: { left: 100, top: 100, right: 1124, bottom: 1124 } },
        { tag: "MOVE+SCALE to L333 T277 201x201",  dst: { left: 333, top: 277, right: 534, bottom: 478 } }
    ];

    for (var t = 0; t < TARGETS.length; t++) {
        say("");
        say("################ " + TARGETS[t].tag + " ################");
        for (var m = 0; m < MECHS.length; m++) {
            var doc = null;
            var line = "  " + MECHS[m].name + "\n      ";
            try {
                doc = newDoc();
                placeFile(PNG);
                var cur = frameOf();
                if (!cur) { line += "no frame after place"; }
                else {
                    var dst = TARGETS[t].dst;
                    var threw = null;
                    try { MECHS[m].run(cur, dst); } catch (e) { threw = e.message; }
                    var after = frameOf();
                    line += "before " + fmt(cur) + "\n      after  " + fmt(after);
                    if (threw) line += "\n      THREW: " + threw;
                    if (after) {
                        var dx = dst.left - after.left, dy = dst.top - after.top;
                        var dw = (dst.right - dst.left) - (after.right - after.left);
                        var dh = (dst.bottom - dst.top) - (after.bottom - after.top);
                        var exact = Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01 &&
                                    Math.abs(dw) < 0.01 && Math.abs(dh) < 0.01;
                        var moved = Math.abs(after.left - cur.left) > 0.001 ||
                                    Math.abs(after.top - cur.top) > 0.001 ||
                                    Math.abs((after.right - after.left) - (cur.right - cur.left)) > 0.001;
                        line += "\n      residual dx=" + n3(dx) + " dy=" + n3(dy) +
                                " dw=" + n3(dw) + " dh=" + n3(dh) +
                                "   => " + (exact ? "EXACT" : (moved ? "moved but off" : "NO-OP"));
                        line += "\n      quad after: [" + (after.quad ? after.quad.join(", ") : "") + "]";
                    }
                }
            } catch (e) { line += "block error: " + e.message; }
            killDoc(doc);
            say(line);
        }
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
    var f = new File(DIR + "/probe2.txt");
    f.encoding = "UTF-8"; f.open("w"); f.write(LOG.join("\n")); f.close();
    RESULT = "probe2 written";
} catch (e) { RESULT = "WRITE FAILED: " + e.message; }

})();

RESULT;
