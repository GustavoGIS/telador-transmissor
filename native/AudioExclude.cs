// WASAPI Process Loopback:
//   exclude [pid]  — sistema sem a árvore do pid (padrão: Discord)
//   include <pid>  — só a árvore do pid (áudio do app)
//   hwnd <hwnd>    — include do processo dono da janela
// Saída stdout: "PCM s16le 48000 2\n" + PCM binário.

using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

internal static class Program
{
    const int AUDCLNT_SHAREMODE_SHARED = 0;
    const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const int AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
    const int AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = unchecked((int)0x80000000);
    const int AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
    const int AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
    const int AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1;
    const int PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0;
    const int PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1;
    const string VAD_PROCESS_LOOPBACK = @"VAD\Process_Loopback";
    const short VT_BLOB = 65;

    static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
    static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");

    [StructLayout(LayoutKind.Sequential)]
    struct AudioClientProcessLoopbackParams
    {
        public uint TargetProcessId;
        public int ProcessLoopbackMode;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct AudioClientActivationParams
    {
        public int ActivationType;
        public AudioClientProcessLoopbackParams ProcessLoopbackParams;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct Blob
    {
        public int Length;
        public IntPtr Data;
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PropVariant
    {
        [FieldOffset(0)] public short vt;
        [FieldOffset(2)] public short wReserved1;
        [FieldOffset(4)] public short wReserved2;
        [FieldOffset(6)] public short wReserved3;
        [FieldOffset(8)] public Blob blobVal;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler
    {
        [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig] int GetActivateResult(out int activateResult, out IntPtr activatedInterface);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long hnsBufferDuration, long hnsPeriodicity, ref WAVEFORMATEX pFormat, IntPtr audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint bufferFrameCount);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, ref WAVEFORMATEX pFormat, out IntPtr closestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr ppDeviceFormat);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint numFramesAvailable, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint numFramesRead);
        [PreserveSig] int GetNextPacketSize(out uint numFramesInNextPacket);
    }

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = true)]
    static extern int ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        ref Guid riid,
        IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation activationOperation);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    const uint TH32CS_SNAPPROCESS = 2;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    // Necessário para ActivateAudioInterfaceAsync (callback no MTA)
    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAgileObject { }

    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.None)]
    sealed class ActivateHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public int Result;
        public IntPtr Client = IntPtr.Zero;

        public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation op)
        {
            try
            {
                int hr;
                IntPtr iface;
                op.GetActivateResult(out hr, out iface);
                Result = hr;
                Client = iface;
            }
            catch (Exception ex)
            {
                Result = ex.HResult;
            }
            Done.Set();
            return 0;
        }
    }

    static bool IsDiscordExe(string exe)
    {
        if (string.IsNullOrEmpty(exe)) return false;
        string n = exe;
        if (n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            n = n.Substring(0, n.Length - 4);
        return n.Equals("Discord", StringComparison.OrdinalIgnoreCase)
            || n.Equals("DiscordPTB", StringComparison.OrdinalIgnoreCase)
            || n.Equals("DiscordCanary", StringComparison.OrdinalIgnoreCase)
            || n.Equals("DiscordDevelopment", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Raiz da árvore do Discord (pai não é Discord). Excluir um filho
    /// deixa irmãos tocando voz e o áudio vaza na captura → eco/retorno.
    /// </summary>
    static int FindDiscordPid()
    {
        var ids = new System.Collections.Generic.HashSet<uint>();
        var parentOf = new System.Collections.Generic.Dictionary<uint, uint>();

        IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == IntPtr.Zero || snap == new IntPtr(-1))
            return FindDiscordPidFallback();

        try
        {
            var pe = new PROCESSENTRY32();
            pe.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (!Process32First(snap, ref pe)) return FindDiscordPidFallback();
            do
            {
                if (!IsDiscordExe(pe.szExeFile)) continue;
                ids.Add(pe.th32ProcessID);
                parentOf[pe.th32ProcessID] = pe.th32ParentProcessID;
            } while (Process32Next(snap, ref pe));
        }
        finally
        {
            CloseHandle(snap);
        }

        if (ids.Count == 0) return 0;

        uint best = 0;
        foreach (uint id in ids)
        {
            uint parent;
            parentOf.TryGetValue(id, out parent);
            // Raiz: pai não é outro Discord
            if (ids.Contains(parent)) continue;
            if (best == 0 || id < best) best = id;
        }
        if (best == 0)
        {
            foreach (uint id in ids)
                if (best == 0 || id < best) best = id;
        }
        return (int)best;
    }

    static int FindDiscordPidFallback()
    {
        string[] names = { "Discord", "DiscordPTB", "DiscordCanary", "DiscordDevelopment" };
        int best = int.MaxValue;
        foreach (var name in names)
        {
            try
            {
                var procs = Process.GetProcessesByName(name);
                foreach (var p in procs)
                {
                    try { if (p.Id > 0 && p.Id < best) best = p.Id; }
                    finally { p.Dispose(); }
                }
            }
            catch { }
        }
        return best == int.MaxValue ? 0 : best;
    }

    static uint PidFromHwnd(ulong hwnd)
    {
        if (hwnd == 0) return 0;
        uint pid;
        GetWindowThreadProcessId(new IntPtr((long)hwnd), out pid);
        return pid;
    }

    static void PrintUsage()
    {
        Console.Error.WriteLine("usage: audio-exclude exclude [pid]");
        Console.Error.WriteLine("       audio-exclude include <pid>");
        Console.Error.WriteLine("       audio-exclude hwnd <hwnd>");
    }

    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0)
            {
                PrintUsage();
                return 1;
            }

            string mode = args[0].Trim().ToLowerInvariant();
            uint targetPid = 0;
            int loopMode;

            if (mode == "exclude")
            {
                loopMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
                if (args.Length > 1) uint.TryParse(args[1], out targetPid);
                if (targetPid == 0)
                {
                    int discord = FindDiscordPid();
                    targetPid = discord > 0 ? (uint)discord : (uint)Process.GetCurrentProcess().Id;
                }
            }
            else if (mode == "include")
            {
                loopMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
                if (args.Length < 2 || !uint.TryParse(args[1], out targetPid) || targetPid == 0)
                {
                    Console.Error.WriteLine("include requires pid");
                    return 1;
                }
            }
            else if (mode == "hwnd")
            {
                loopMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
                ulong hwnd;
                if (args.Length < 2 || !ulong.TryParse(args[1], out hwnd) || hwnd == 0)
                {
                    Console.Error.WriteLine("hwnd requires window handle");
                    return 1;
                }
                targetPid = PidFromHwnd(hwnd);
                if (targetPid == 0)
                {
                    Console.Error.WriteLine("could not resolve pid from hwnd=" + hwnd);
                    return 1;
                }
            }
            else if (uint.TryParse(mode, out targetPid) && targetPid > 0)
            {
                // Compat: audio-exclude.exe <pid> => exclude
                loopMode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
            }
            else
            {
                PrintUsage();
                return 1;
            }

            Console.Error.WriteLine("mode=" + (loopMode == PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE ? "include" : "exclude") + " pid=" + targetPid);

            using (var pump = new Form())
            {
                pump.ShowInTaskbar = false;
                pump.FormBorderStyle = FormBorderStyle.FixedToolWindow;
                pump.Opacity = 0;
                pump.Show();

                var handler = new ActivateHandler();
                var act = new AudioClientActivationParams
                {
                    ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
                    ProcessLoopbackParams = new AudioClientProcessLoopbackParams
                    {
                        TargetProcessId = targetPid,
                        ProcessLoopbackMode = loopMode
                    }
                };

                IntPtr pAct = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(AudioClientActivationParams)));
                Marshal.StructureToPtr(act, pAct, false);
                IAudioClient client;
                try
                {
                    var pv = new PropVariant
                    {
                        vt = VT_BLOB,
                        blobVal = new Blob
                        {
                            Length = Marshal.SizeOf(typeof(AudioClientActivationParams)),
                            Data = pAct
                        }
                    };
                    IntPtr pPv = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(PropVariant)));
                    Marshal.StructureToPtr(pv, pPv, false);
                    try
                    {
                        IActivateAudioInterfaceAsyncOperation op;
                        Guid iid = IID_IAudioClient;
                        int ahr = ActivateAudioInterfaceAsync(VAD_PROCESS_LOOPBACK, ref iid, pPv, handler, out op);
                        // S_OK ou E_PENDING — conclusão vem no handler
                        if (ahr < 0 && (uint)ahr != 0x8000000E)
                        {
                            Console.Error.WriteLine("ActivateAudioInterfaceAsync hr=0x{0:X8}", ahr);
                            return 2;
                        }

                        while (!handler.Done.WaitOne(20))
                            Application.DoEvents();

                        if (handler.Result < 0 || handler.Client == IntPtr.Zero)
                        {
                            Console.Error.WriteLine("activate result=0x{0:X8}", handler.Result);
                            return 3;
                        }
                        Guid iidClient = IID_IAudioClient;
                        IntPtr pClient;
                        int qhr = Marshal.QueryInterface(handler.Client, ref iidClient, out pClient);
                        Marshal.Release(handler.Client);
                        if (qhr < 0 || pClient == IntPtr.Zero)
                        {
                            Console.Error.WriteLine("QI IAudioClient=0x{0:X8}", qhr);
                            return 3;
                        }
                        client = (IAudioClient)Marshal.GetTypedObjectForIUnknown(pClient, typeof(IAudioClient));
                        Marshal.Release(pClient);
                    }
                    finally
                    {
                        Marshal.FreeHGlobal(pPv);
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(pAct);
                }

                return RunCapture(client);
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            return 1;
        }
    }

    static int RunCapture(IAudioClient client)
    {
        try
        {
            // 48 kHz — alinhado ao WebRTC/LiveKit (autoconvert do WASAPI)
            var fmt = new WAVEFORMATEX
            {
                wFormatTag = 1,
                nChannels = 2,
                nSamplesPerSec = 48000,
                wBitsPerSample = 16,
                nBlockAlign = 4,
                nAvgBytesPerSec = 48000 * 4,
                cbSize = 0
            };

            int flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
            int hr = client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 0, 0, ref fmt, IntPtr.Zero);
            if (hr < 0)
            {
                Console.Error.WriteLine("Initialize 0x{0:X8}", hr);
                return 4;
            }

            var ready = new EventWaitHandle(false, EventResetMode.AutoReset);
            hr = client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle());
            if (hr < 0)
            {
                Console.Error.WriteLine("SetEventHandle 0x{0:X8}", hr);
                return 5;
            }

            object svc;
            Guid iidCap = IID_IAudioCaptureClient;
            hr = client.GetService(ref iidCap, out svc);
            if (hr < 0)
            {
                Console.Error.WriteLine("GetService 0x{0:X8}", hr);
                return 6;
            }
            var capture = (IAudioCaptureClient)svc;

            hr = client.Start();
            if (hr < 0)
            {
                Console.Error.WriteLine("Start 0x{0:X8}", hr);
                return 7;
            }

            var stdout = Console.OpenStandardOutput();
            var hdr = System.Text.Encoding.ASCII.GetBytes("PCM s16le " + fmt.nSamplesPerSec + " 2\n");
            stdout.Write(hdr, 0, hdr.Length);
            stdout.Flush();

            byte[] managed = new byte[1024 * 64];
            while (true)
            {
                ready.WaitOne(2000);
                uint packet;
                while (capture.GetNextPacketSize(out packet) >= 0 && packet > 0)
                {
                    IntPtr data;
                    uint frames, flagsOut;
                    ulong pos, qpc;
                    hr = capture.GetBuffer(out data, out frames, out flagsOut, out pos, out qpc);
                    if (hr < 0) break;
                    int bytes = (int)(frames * fmt.nBlockAlign);
                    if (bytes > managed.Length) managed = new byte[bytes];
                    if ((flagsOut & AUDCLNT_BUFFERFLAGS_SILENT) != 0)
                        Array.Clear(managed, 0, bytes);
                    else
                        Marshal.Copy(data, managed, 0, bytes);
                    capture.ReleaseBuffer(frames);
                    stdout.Write(managed, 0, bytes);
                }
            }
#pragma warning disable 0162
            return 0;
#pragma warning restore 0162
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            return 1;
        }
    }
}
