/**
 * Windows: QoS / timer de alta resolução (API Microsoft, mesma linha do OBS).
 * - IGNORE_TIMER_RESOLUTION off → timeBeginPeriod continua valendo com janela oculta (Win11)
 * - EXECUTION_SPEED off → evita EcoQoS (CPU “econômica” em segundo plano)
 */
"use strict";

const ProcessPowerThrottling = 4;
const PROCESS_POWER_THROTTLING_CURRENT_VERSION = 1;
/** @see https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-setprocessinformation */
const PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 0x1;
const PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION = 0x4;

let api = null;
let optedOut = false;
let periodActive = false;

function loadApi() {
  if (process.platform !== "win32") return null;
  if (api) return api;
  try {
    const koffi = require("koffi");
    const kernel32 = koffi.load("kernel32.dll");
    const winmm = koffi.load("winmm.dll");
    api = {
      GetCurrentProcess: kernel32.func("void * __stdcall GetCurrentProcess()"),
      SetProcessInformation: kernel32.func(
        "bool __stdcall SetProcessInformation(void *hProcess, int ProcessInformationClass, void *ProcessInformation, uint32 ProcessInformationSize)"
      ),
      timeBeginPeriod: winmm.func("uint __stdcall timeBeginPeriod(uint uPeriod)"),
      timeEndPeriod: winmm.func("uint __stdcall timeEndPeriod(uint uPeriod)"),
    };
    return api;
  } catch (e) {
    api = null;
    return null;
  }
}

/**
 * Desliga throttling de timer + EcoQoS (StateMask=0 = mecanismos off / HighQoS).
 * Seguro em Win10/11: em builds antigas a API pode falhar sem efeito colateral.
 */
function optOutPowerThrottling() {
  if (process.platform !== "win32" || optedOut) return !!optedOut;
  const a = loadApi();
  if (!a) return false;
  try {
    const control =
      PROCESS_POWER_THROTTLING_EXECUTION_SPEED |
      PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION;
    const state = Buffer.alloc(12);
    state.writeUInt32LE(PROCESS_POWER_THROTTLING_CURRENT_VERSION, 0);
    state.writeUInt32LE(control, 4);
    state.writeUInt32LE(0, 8);
    const ok = a.SetProcessInformation(
      a.GetCurrentProcess(),
      ProcessPowerThrottling,
      state,
      state.length
    );
    optedOut = !!ok;
    return optedOut;
  } catch (e) {
    return false;
  }
}

/** @deprecated use optOutPowerThrottling */
function optOutTimerThrottling() {
  return optOutPowerThrottling();
}

function beginHighResPeriod() {
  if (process.platform !== "win32" || periodActive) return periodActive;
  const a = loadApi();
  if (!a) return false;
  try {
    optOutPowerThrottling();
    const r = a.timeBeginPeriod(1);
    periodActive = r === 0;
    return periodActive;
  } catch (e) {
    return false;
  }
}

function endHighResPeriod() {
  if (!periodActive) return;
  const a = loadApi();
  if (!a) {
    periodActive = false;
    return;
  }
  try {
    a.timeEndPeriod(1);
  } catch (e) {}
  periodActive = false;
}

/** Liga enquanto transmite; desliga ao parar. */
function setStreamingTimers(on) {
  if (on) return beginHighResPeriod();
  endHighResPeriod();
  return false;
}

function shutdown() {
  endHighResPeriod();
}

module.exports = {
  optOutPowerThrottling,
  optOutTimerThrottling,
  setStreamingTimers,
  shutdown,
};
