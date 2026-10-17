/**
 * Windows 11: mantém timer de alta resolução mesmo com janelas ocultas/minimizadas.
 * Mesma abordagem documentada pela Microsoft e usada pelo OBS
 * (SetProcessInformation + PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION).
 */
"use strict";

const ProcessPowerThrottling = 4;
const PROCESS_POWER_THROTTLING_CURRENT_VERSION = 1;
/** @see https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-setprocessinformation */
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

/** Desliga o throttling de timer do Win11 (StateMask=0 = sempre honrar timeBeginPeriod). */
function optOutTimerThrottling() {
  if (process.platform !== "win32" || optedOut) return !!optedOut;
  const a = loadApi();
  if (!a) return false;
  try {
    const state = Buffer.alloc(12);
    state.writeUInt32LE(PROCESS_POWER_THROTTLING_CURRENT_VERSION, 0);
    state.writeUInt32LE(PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION, 4);
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

function beginHighResPeriod() {
  if (process.platform !== "win32" || periodActive) return periodActive;
  const a = loadApi();
  if (!a) return false;
  try {
    optOutTimerThrottling();
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
  optOutTimerThrottling,
  setStreamingTimers,
  shutdown,
};
