#pragma once
// A very small JSON reader.  Enough for dingoConfig documents and traces.
#include <map>
#include <memory>
#include <string>
#include <vector>

struct JVal;
using JPtr = std::shared_ptr<JVal>;

struct JVal {
    enum Kind { Null, Bool, Num, Str, Arr, Obj } kind = Null;
    bool b = false;
    double num = 0;
    std::string str;
    std::vector<JPtr> arr;
    std::map<std::string, JPtr> obj;   // ordered by key; order is not used

    bool isNull() const { return kind == Null; }
    const JPtr get(const std::string &k) const {
        auto it = obj.find(k);
        return it == obj.end() ? nullptr : it->second;
    }
};

JPtr jparse(const std::string &text, std::string *err);
JPtr jparseFile(const std::string &path, std::string *err);
