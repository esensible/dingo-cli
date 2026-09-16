/* HOST SHIM for ChibiOS ch.hpp.
   Enough of chibios_rt for the thread objects in core/device.cpp to compile.
   They are never started on the host: InitDevice() is not called. */
#pragma once

#include "ch.h"

namespace chibios_rt {

class ThreadReference {
public:
    ThreadReference() = default;
    void *p = nullptr;
};

template <int N>
class BaseStaticThread {
public:
    virtual ~BaseStaticThread() = default;
    virtual void main() {}
    void setName(const char *) {}
    ThreadReference start(int /*prio*/) { return ThreadReference(); }
};

} // namespace chibios_rt
