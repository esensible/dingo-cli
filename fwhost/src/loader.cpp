// dingoConfig JSON -> firmware parameters.
//
// The JSON-field -> (index, subindex) bridge is a direct port of dingo-cli's
// internal/pdmcfg/pdmcfg.go, so this exercises that mapping too.  Values are
// written through the firmware's own param_registry WriteParam(), which
// applies the real type conversion and range checks; fields the document
// omits keep the value SetAllDefaultParams() left, i.e. the firmware default.
#include "loader.h"

#include "param_registry.h"
#include "param_protocol.h"
#include "config.h"
#include "config_handler.h"

#include <bit>
#include <cstdio>
#include <cstring>

namespace {

struct FieldMap { const char *json; uint8_t sub; };
struct InstGroup { const char *key; uint16_t base; std::vector<FieldMap> fields; };

const FieldMap kDeviceFields[] = {
    {"baseId", 0}, {"bitrate", 1}, {"sleepEnabled", 2},
    {"filtersEnabled", 3}, {"connectUsbToCan", 4},
};

const std::vector<InstGroup> kInstGroups = {
    {"outputs", 0x1000, {
        {"enabled",0},{"input",1},{"currentLimit",2},{"inrushCurrentLimit",3},
        {"inrushTime",4},{"resetMode",5},{"resetTime",6},{"resetCountLimit",7},
        {"pwmEnabled",8},{"softStartEnabled",9},{"variableDutyCycle",10},
        {"dutyCycleInput",11},{"fixedDutyCycle",12},{"frequency",13},
        {"softStartRampTime",14},{"dutyCycleDenominator",15},{"minDutyCycle",16},
        {"primaryOutput",17}}},
    {"inputs", 0x1200, {
        {"enabled",0},{"mode",1},{"invert",2},{"debounceTime",3},{"pull",4}}},
    {"canInputs", 0x1300, {
        {"enabled",0},{"timeoutEnabled",1},{"timeout",2},{"ide",3},{"id",4},
        {"startBit",5},{"bitLength",6},{"factor",7},{"offset",8},{"byteOrder",9},
        {"signed",10},{"operator",11},{"operand",12},{"mode",13}}},
    {"canOutputs", 0x2000, {
        {"enabled",0},{"input",1},{"ide",2},{"id",3},{"startBit",4},
        {"bitLength",5},{"factor",6},{"offset",7},{"byteOrder",8},{"signed",9},
        {"interval",10}}},
    {"virtualInputs", 0x1400, {
        {"enabled",0},{"not0",1},{"var0",2},{"cond0",3},{"not1",4},{"var1",5},
        {"cond1",6},{"not2",7},{"var2",8},{"mode",9}}},
    {"conditions", 0x1500, {
        {"enabled",0},{"input",1},{"operator",2},{"arg",3}}},
    {"counters", 0x1600, {
        {"enabled",0},{"incInput",1},{"decInput",2},{"resetInput",3},
        {"minCount",4},{"maxCount",5},{"incEdge",6},{"decEdge",7},
        {"resetEdge",8},{"wrapAround",9},{"holdToReset",10},{"resetTime",11}}},
    {"flashers", 0x1700, {
        {"enabled",0},{"input",1},{"onTime",2},{"offTime",3},{"single",4}}},
};

const FieldMap kWiperFields[] = {
    {"enabled",0},{"mode",1},{"slowInput",2},{"fastInput",3},{"interInput",4},
    {"onInput",5},{"speedInput",6},{"parkInput",7},{"parkStopLevel",8},
    {"swipeInput",9},{"washInput",10},{"washWipeCycles",11},
};

uint32_t wireValue(const ParamInfo *p, const JPtr &v, bool *ok) {
    *ok = true;
    double d = 0;
    if (v->kind == JVal::Bool) d = v->b ? 1 : 0;
    else if (v->kind == JVal::Num) d = v->num;
    else { *ok = false; return 0; }

    switch (p->eType) {
        case ParamType::Float:  return std::bit_cast<uint32_t>((float)d);
        case ParamType::Int8:   return (uint32_t)(int32_t)(int8_t)d;
        case ParamType::Int16:  return (uint32_t)(int32_t)(int16_t)d;
        case ParamType::Int32:  return (uint32_t)(int32_t)d;
        case ParamType::Bool:   return d != 0 ? 1u : 0u;
        default:                return (uint32_t)(int64_t)d;
    }
}

bool writeField(const JPtr &obj, const char *name, uint16_t index, uint8_t sub,
                std::vector<std::string> &warn) {
    if (!obj || obj->kind != JVal::Obj) return true;
    auto v = obj->get(name);
    if (!v || v->isNull()) return true;
    const ParamInfo *p = FindParam(index, sub);
    if (!p) {
        warn.push_back(std::string("no such param for field '") + name + "' at index " +
                       std::to_string(index) + "." + std::to_string(sub));
        return true;
    }
    bool ok;
    uint32_t wv = wireValue(p, v, &ok);
    if (!ok) {
        warn.push_back(std::string("field '") + name + "' is not a number/bool");
        return true;
    }
    if (!WriteParam(p, wv)) {
        char buf[160];
        snprintf(buf, sizeof buf,
                 "field '%s' (0x%04X.%u) value out of firmware range -- left at default",
                 name, index, sub);
        warn.push_back(buf);
    }
    return true;
}

void writeArray(const JPtr &obj, const char *name, uint16_t index, uint8_t sub0,
                std::vector<std::string> &warn) {
    if (!obj || obj->kind != JVal::Obj) return;
    auto a = obj->get(name);
    if (!a || a->kind != JVal::Arr) return;
    for (size_t i = 0; i < a->arr.size(); i++) {
        const ParamInfo *p = FindParam(index, (uint8_t)(sub0 + i));
        if (!p) continue;
        bool ok;
        uint32_t wv = wireValue(p, a->arr[i], &ok);
        if (ok) WriteParam(p, wv);
    }
}

}  // namespace

bool LoadDingoConfig(const std::string &path, int wantBaseId, LoadResult *out) {
    std::string err;
    JPtr doc = jparseFile(path, &err);
    if (!doc) { out->error = err; return false; }

    auto devs = doc->get("PdmDevices");
    std::vector<JPtr> all;
    if (devs && devs->kind == JVal::Arr)
        for (auto &d : devs->arr) all.push_back(d);
    auto maxdevs = doc->get("PdmMaxDevices");
    if (maxdevs && maxdevs->kind == JVal::Arr)
        for (auto &d : maxdevs->arr) all.push_back(d);
    if (all.empty()) { out->error = "no PdmDevices in document"; return false; }

    JPtr dev = nullptr;
    if (wantBaseId >= 0) {
        for (auto &d : all) {
            auto b = d->get("baseId");
            if (b && b->kind == JVal::Num && (int)b->num == wantBaseId) { dev = d; break; }
        }
        if (!dev) { out->error = "no PDM with that baseId"; return false; }
    } else if (all.size() == 1) {
        dev = all[0];
    } else {
        out->error = "multiple PDM devices; pass --base";
        return false;
    }

    auto nm = dev->get("name");
    out->name = nm && nm->kind == JVal::Str ? nm->str : "?";
    auto bi = dev->get("baseId");
    out->baseId = bi && bi->kind == JVal::Num ? (int)bi->num : 222;

    // Start from the firmware's own defaults, exactly as a factory device does.
    SetAllDefaultParams();

    for (auto &fm : kDeviceFields)
        writeField(dev, fm.json, 0x0000, fm.sub, out->warnings);

    for (auto &g : kInstGroups) {
        auto arr = dev->get(g.key);
        if (!arr || arr->kind != JVal::Arr) continue;
        for (size_t i = 0; i < arr->arr.size(); i++) {
            uint16_t base = (uint16_t)(g.base + i);
            if (!FindParam(base, 0)) {
                out->error = std::string(g.key) + ": " +
                             std::to_string(arr->arr.size()) +
                             " entries but the board has fewer slots";
                return false;
            }
            for (auto &fm : g.fields)
                writeField(arr->arr[i], fm.json, base, fm.sub, out->warnings);
        }
    }

    if (auto w = dev->get("wipers")) {
        for (auto &fm : kWiperFields)
            writeField(w, fm.json, 0x1900, fm.sub, out->warnings);
        writeArray(w, "speedMap", 0x1900, 12, out->warnings);
        writeArray(w, "intermitTime", 0x1900, 20, out->warnings);
        auto en = w->get("enabled");
        if (en && ((en->kind == JVal::Bool && en->b) ||
                   (en->kind == JVal::Num && en->num != 0)))
            out->usesWiper = true;
    }

    if (auto s = dev->get("starterDisable")) {
        writeField(s, "enabled", 0x1800, 0, out->warnings);
        writeField(s, "input", 0x1800, 1, out->warnings);
        writeArray(s, "outputsDisabled", 0x1800, 2, out->warnings);
        auto en = s->get("enabled");
        if (en && ((en->kind == JVal::Bool && en->b) ||
                   (en->kind == JVal::Num && en->num != 0)))
            out->usesStarter = true;
    }

    if (auto k = dev->get("keypads")) {
        if (k->kind == JVal::Arr)
            for (auto &kp : k->arr) {
                auto en = kp->get("enabled");
                if (en && ((en->kind == JVal::Bool && en->b) ||
                           (en->kind == JVal::Num && en->num != 0)))
                    out->usesKeypad = true;
            }
    }

    ApplyAllConfig();
    return true;
}
