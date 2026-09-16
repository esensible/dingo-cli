/* HOST SHIM for boards/<board>/msg.h.
   The real header declares 27 TxMsgN() cyclic-telemetry builders and a static
   dispatch table.  None of them is reachable from CyclicUpdate(); only the
   CANTxMsg type is needed for the translation unit to compile. */
#pragma once

#include <cstdint>
#include "port.h"
#include "enums.h"
#include "mailbox.h"
#include "device_config.h"

struct CANTxMsg
{
    CANTxFrame frame;
    bool bSend;
};
