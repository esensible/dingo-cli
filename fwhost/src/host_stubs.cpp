// Host stand-ins for the firmware's I/O-bound translation units: CAN driver,
// mailboxes, USB, FRAM/flash config store, LEDs, temperature sensor, ADC,
// sleep, bootloader.  None of these contain logic CyclicUpdate() depends on.
//
// The two that matter behaviourally:
//   * the RX/TX mailboxes are real queues, so CyclicUpdate() drains injected
//     frames exactly as it does on the device, and everything the firmware
//     transmits is captured;
//   * GetAdcRaw() returns 0, so every output reads 0 A.  Same documented
//     limitation as the Python model: overcurrent/fault are unreachable.
#include "host.h"

#include "port.h"
#include "config.h"
#include "config_handler.h"
#include "enums.h"
#include "led.h"
#include "error.h"
#include "mailbox.h"
#include "can.h"
#include "infomsg.h"
#include "request_msg.h"
#include "param_protocol.h"
#include "status.h"
#if HAS_EXT_TEMP_SENSOR
#include "hardware/mcp9808.h"
#endif
#include "mcu_utils.h"

#include <deque>
#include <vector>
#include <cstring>

// --- mailboxes -------------------------------------------------------------
static std::deque<CANRxFrame> g_rx;
static std::vector<HostFrame> g_tx;

void hostPushRx(const HostFrame &f) {
    CANRxFrame r{};
    r.IDE = f.ide;
    if (f.ide) r.EID = f.id; else r.SID = f.id;
    r.DLC = f.dlc;
    memcpy(r.data8, f.data, 8);
    g_rx.push_back(r);
}
void hostClearTx() { g_tx.clear(); }
const std::vector<HostFrame> &hostTx() { return g_tx; }

msg_t PostTxFrame(CANTxFrame *frame) {
    HostFrame f{};
    f.ide = frame->IDE;
    f.id  = frame->IDE ? frame->EID : frame->SID;
    f.dlc = frame->DLC;
    memcpy(f.data, frame->data8, 8);
    g_tx.push_back(f);
    return MSG_OK;
}
msg_t PostTxUsbFrame(CANTxFrame *) { return MSG_OK; }
msg_t FetchTxFrame(CANTxFrame *) { return (msg_t)-1; }
msg_t FetchTxUsbFrame(CANTxFrame *) { return (msg_t)-1; }
msg_t PostRxFrame(CANRxFrame *frame) { g_rx.push_back(*frame); return MSG_OK; }
msg_t FetchRxFrame(CANRxFrame *frame) {
    if (g_rx.empty()) return (msg_t)-1;
    *frame = g_rx.front();
    g_rx.pop_front();
    return MSG_OK;
}
bool RxFramesEmpty() { return g_rx.empty(); }

// --- CAN driver ------------------------------------------------------------
msg_t InitCan(Config_Device *) { return HAL_RET_SUCCESS; }
void StopCan() {}
void ClearCanFilters() {}
void SetCanFilterId(uint8_t, uint32_t, bool) {}
void SetCanFilterEnabled(bool) {}
uint32_t GetLastCanRxTime() { return SYS_TIME; }
static const CANConfig g_canCfg = {0, 0};
const CANConfig &GetCanConfig(CanBitrate) { return g_canCfg; }

// --- USB -------------------------------------------------------------------
#if HAS_USB
msg_t InitUsb() { return HAL_RET_SUCCESS; }
#endif
#if HAS_USB
void CheckBootloaderRequest(void) {}
#endif
void RequestBootloader() {}
void EnterStopMode() {}

// --- config store ----------------------------------------------------------
// The host runner loads a dingoConfig JSON instead; nothing is persisted.
void InitConfig() {}
bool WriteConfig() { return true; }
bool ReadConfigExt() { return false; }
bool WriteConfigExt() { return true; }

// --- ADC / analogue --------------------------------------------------------
msg_t InitAdc() { return HAL_RET_SUCCESS; }
void DeInitAdc() {}
uint16_t GetAdcRaw(AnalogChannel) { return 0; }      // <- current pinned at 0
static float g_battVolt = 0.0f;
void hostSetBattVolt(float v) { g_battVolt = v; }
#if HAS_BATT_VOLT_SENSE
float GetBattVolt() { return g_battVolt; }
#endif

#if NUM_OUTPUTS > 0
float GetVDDA() { return 3.3f; }
#endif

// --- LEDs / errors ---------------------------------------------------------
void Led::Solid(bool s) { bState = s; }
void Led::Code(uint8_t) {}
void Led::Blink() {}

Led *Error::statusLed = nullptr;
Led *Error::errorLed = nullptr;
void Error::Initialize(Led *s, Led *e) { statusLed = s; errorLed = e; }

int g_fatalErrors = 0;
FatalErrorType g_lastFatalError = FatalErrorType::NoError;
void Error::SetFatalError(FatalErrorType err, MsgSrc) {
    if (err == FatalErrorType::NoError) return;
    g_fatalErrors++;
    g_lastFatalError = err;
}

// --- info / request messages ----------------------------------------------
void CheckInfoMsgs() {}
void InitInfoMsgs() {}
void SendInfoMsg(MsgType, MsgSrc, uint16_t, uint16_t, uint16_t, uint16_t) {}
void InfoMsg::Check(bool, uint16_t, uint16_t, uint16_t, uint16_t) {}
void CheckRequestMsgs(CANRxFrame *) {}

// --- sleep -----------------------------------------------------------------
#if CAN_SLEEP
bool CheckEnterSleep() { return false; }
void EnterSleep() {}
#endif

// --- temperature sensor ----------------------------------------------------
#if HAS_EXT_TEMP_SENSOR
bool MCP9808::Init(float, float) { return true; }
bool MCP9808::CheckId() { return true; }
float MCP9808::GetTemp() { return 25.0f; }
int16_t MCP9808::GetTempInt() { return 25; }
uint16_t MCP9808::GetTempUint() { return 25; }
bool MCP9808::GetTempRegister(uint16_t *) { return true; }
bool MCP9808::GetResolution(uint8_t *) { return true; }
bool MCP9808::SetResolution(uint8_t) { return true; }
bool MCP9808::LockLimits() { return true; }
bool MCP9808::Shutdown() { return true; }
bool MCP9808::Wake() { return true; }
bool MCP9808::SetLimit(uint8_t, float) { return true; }
float MCP9808::RawToTemp(uint16_t) { return 25.0f; }
bool MCP9808::CritTempLimit() { return false; }
bool MCP9808::OverTempLimit() { return false; }
bool MCP9808::UnderTempLimit() { return false; }
bool MCP9808::Write16(uint8_t, uint16_t) { return true; }
bool MCP9808::Read16(uint8_t, uint16_t *) { return true; }
bool MCP9808::Write8(uint8_t, uint8_t) { return true; }
bool MCP9808::Read8(uint8_t, uint8_t *) { return true; }
float DegCToF(float c) { return c * 9.0f / 5.0f + 32.0f; }
#endif
