#include "json.h"

#include <cstdlib>
#include <fstream>
#include <sstream>

namespace {

struct P {
    const std::string &s;
    size_t i = 0;
    std::string err;

    void ws() {
        while (i < s.size() && (s[i] == ' ' || s[i] == '\t' ||
                                s[i] == '\n' || s[i] == '\r'))
            i++;
    }
    bool lit(const char *t) {
        size_t n = strlen(t);
        if (s.compare(i, n, t) == 0) { i += n; return true; }
        return false;
    }
    JPtr fail(const std::string &m) {
        if (err.empty()) err = m + " at offset " + std::to_string(i);
        return nullptr;
    }

    JPtr value() {
        ws();
        if (i >= s.size()) return fail("unexpected end");
        char c = s[i];
        if (c == '{') return object();
        if (c == '[') return array();
        if (c == '"') {
            auto v = std::make_shared<JVal>();
            v->kind = JVal::Str;
            if (!string(v->str)) return nullptr;
            return v;
        }
        if (lit("true") || lit("True")) {
            auto v = std::make_shared<JVal>(); v->kind = JVal::Bool; v->b = true; return v;
        }
        if (lit("false") || lit("False")) {
            auto v = std::make_shared<JVal>(); v->kind = JVal::Bool; v->b = false; return v;
        }
        if (lit("null")) { return std::make_shared<JVal>(); }
        // number
        size_t start = i;
        if (i < s.size() && (s[i] == '-' || s[i] == '+')) i++;
        while (i < s.size() && (isdigit((unsigned char)s[i]) || s[i] == '.' ||
                                s[i] == 'e' || s[i] == 'E' ||
                                s[i] == '+' || s[i] == '-'))
            i++;
        if (i == start) return fail("bad value");
        auto v = std::make_shared<JVal>();
        v->kind = JVal::Num;
        v->num = strtod(s.substr(start, i - start).c_str(), nullptr);
        return v;
    }

    bool string(std::string &out) {
        if (s[i] != '"') { fail("expected string"); return false; }
        i++;
        while (i < s.size() && s[i] != '"') {
            if (s[i] == '\\' && i + 1 < s.size()) {
                i++;
                switch (s[i]) {
                    case 'n': out += '\n'; break;
                    case 't': out += '\t'; break;
                    case 'r': out += '\r'; break;
                    case 'b': out += '\b'; break;
                    case 'f': out += '\f'; break;
                    case 'u': {
                        unsigned cp = (unsigned)strtoul(s.substr(i + 1, 4).c_str(), nullptr, 16);
                        i += 4;
                        if (cp < 0x80) out += (char)cp;
                        else out += '?';
                        break;
                    }
                    default: out += s[i];
                }
                i++;
            } else {
                out += s[i++];
            }
        }
        if (i >= s.size()) { fail("unterminated string"); return false; }
        i++;
        return true;
    }

    JPtr object() {
        auto v = std::make_shared<JVal>();
        v->kind = JVal::Obj;
        i++;  // {
        ws();
        if (i < s.size() && s[i] == '}') { i++; return v; }
        while (true) {
            ws();
            std::string k;
            if (!string(k)) return nullptr;
            ws();
            if (i >= s.size() || s[i] != ':') return fail("expected ':'");
            i++;
            auto val = value();
            if (!val) return nullptr;
            v->obj[k] = val;
            ws();
            if (i < s.size() && s[i] == ',') { i++; continue; }
            if (i < s.size() && s[i] == '}') { i++; return v; }
            return fail("expected ',' or '}'");
        }
    }

    JPtr array() {
        auto v = std::make_shared<JVal>();
        v->kind = JVal::Arr;
        i++;  // [
        ws();
        if (i < s.size() && s[i] == ']') { i++; return v; }
        while (true) {
            auto val = value();
            if (!val) return nullptr;
            v->arr.push_back(val);
            ws();
            if (i < s.size() && s[i] == ',') { i++; continue; }
            if (i < s.size() && s[i] == ']') { i++; return v; }
            return fail("expected ',' or ']'");
        }
    }
};

}  // namespace

JPtr jparse(const std::string &text, std::string *err) {
    P p{text};
    auto v = p.value();
    if (!v && err) *err = p.err;
    return v;
}

JPtr jparseFile(const std::string &path, std::string *err) {
    std::ifstream f(path);
    if (!f) { if (err) *err = "cannot open " + path; return nullptr; }
    std::ostringstream ss;
    ss << f.rdbuf();
    return jparse(ss.str(), err);
}
