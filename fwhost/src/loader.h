#pragma once
#include <string>
#include <vector>
#include "json.h"

struct LoadResult {
    std::string name;
    int baseId = 0;
    bool usesWiper = false;
    bool usesStarter = false;
    bool usesKeypad = false;
    std::vector<std::string> warnings;
    std::string error;
};

// Parses a dingoConfig document, writes it into the firmware's stConfig via the
// real param registry, and calls the real ApplyAllConfig().
bool LoadDingoConfig(const std::string &path, int wantBaseId, LoadResult *out);
