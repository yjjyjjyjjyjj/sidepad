param([switch]$Apply, [int]$Width = 1920, [int]$Height = 1080, [int]$RefreshRate = 60)
$ErrorActionPreference = 'Stop'
# Uses Windows display configuration APIs, not UI automation.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SidepadDisplayConfig {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Device {
        public int cb;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string description;
        public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string id;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string key;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Mode {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string deviceName;
        public ushort specVersion, driverVersion, size, driverExtra;
        public uint fields;
        public int x, y;
        public uint orientation, fixedOutput;
        public short color, duplex, yResolution, ttOption, collate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string formName;
        public ushort logPixels;
        public uint bitsPerPixel, width, height, displayFlags, frequency;
        public uint icmMethod, icmIntent, mediaType, ditherType, reserved1, reserved2, panningWidth, panningHeight;
    }
    public class ScreenInfo {
        public string Name, Driver;
        public bool Active, Primary;
        public int X, Y;
        public uint Width, Height, RefreshRate;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool EnumDisplayDevices(string device, uint index, ref Device info, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool EnumDisplaySettingsEx(string device, int mode, ref Mode info, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int ChangeDisplaySettingsEx(string device, ref Mode info, IntPtr hwnd, uint flags, IntPtr param);
    static Mode NewMode() { return new Mode { size = (ushort)Marshal.SizeOf(typeof(Mode)) }; }
    public static ScreenInfo[] List() {
        var result = new List<ScreenInfo>();
        for (uint i = 0; ; i++) {
            var device = new Device { cb = Marshal.SizeOf(typeof(Device)) };
            if (!EnumDisplayDevices(null, i, ref device, 0)) break;
            var mode = NewMode();
            if (!EnumDisplaySettingsEx(device.name, -1, ref mode, 0)) continue;
            result.Add(new ScreenInfo { Name = device.name, Driver = device.description,
                Active = (device.flags & 1) != 0, Primary = (device.flags & 4) != 0,
                X = mode.x, Y = mode.y, Width = mode.width, Height = mode.height, RefreshRate = mode.frequency });
        }
        return result.ToArray();
    }
    public static void Configure(string device, int x, int y, uint width, uint height, uint frequency) {
        var current = NewMode();
        if (!EnumDisplaySettingsEx(device, -1, ref current, 0)) throw new Exception("Cannot read current display mode.");
        bool supported = false;
        for (int i = 0; ; i++) {
            var available = NewMode();
            if (!EnumDisplaySettingsEx(device, i, ref available, 0)) break;
            if (available.width == width && available.height == height && available.frequency == frequency && available.bitsPerPixel == 32) { supported = true; break; }
        }
        if (!supported) throw new Exception("Requested mode is not advertised by the virtual display driver.");
        current.x = x; current.y = y; current.width = width; current.height = height; current.frequency = frequency;
        current.bitsPerPixel = 32;
        current.fields = 0x20 | 0x40000 | 0x80000 | 0x100000 | 0x400000;
        int test = ChangeDisplaySettingsEx(device, ref current, IntPtr.Zero, 2, IntPtr.Zero);
        if (test != 0) throw new Exception("Windows rejected the display mode test: " + test);
        int result = ChangeDisplaySettingsEx(device, ref current, IntPtr.Zero, 1, IntPtr.Zero);
        if (result != 0) throw new Exception("Windows display configuration result: " + result);
    }
}
'@
$before = [SidepadDisplayConfig]::List()
if (-not $Apply) { $before | ConvertTo-Json -Depth 4; exit 0 }
$virtual = @($before | Where-Object { $_.Driver -eq 'Virtual Display Driver' })
if ($virtual.Count -ne 1) { throw 'Expected exactly one virtual display; refusing an ambiguous display change.' }
if ($virtual[0].Primary) { throw 'The virtual monitor is the primary display. Choose a physical primary monitor first.' }
$others = @($before | Where-Object { $_.Active -and $_.Name -ne $virtual[0].Name })
$primary = @($others | Where-Object Primary)
if ($primary.Count -ne 1) { throw 'Cannot identify the existing primary display.' }
$rightEdge = ($others | ForEach-Object { $_.X + $_.Width } | Measure-Object -Maximum).Maximum
[SidepadDisplayConfig]::Configure($virtual[0].Name, [int]$rightEdge, $primary[0].Y, $Width, $Height, $RefreshRate)
$after = [SidepadDisplayConfig]::List()
foreach ($old in $others) {
    $new = $after | Where-Object Name -eq $old.Name
    if (-not $new -or $new.Primary -ne $old.Primary -or $new.X -ne $old.X -or $new.Y -ne $old.Y -or $new.Width -ne $old.Width -or $new.Height -ne $old.Height) {
        throw "The existing display layout changed unexpectedly: $($old.Name)"
    }
}
$configured = $after | Where-Object Name -eq $virtual[0].Name
if (-not $configured.Active -or $configured.Width -ne $Width -or $configured.Height -ne $Height) { throw 'Virtual display verification failed.' }
$result = @{ ok = $true; before = $before; after = $after }
$result | ConvertTo-Json -Depth 4 | Tee-Object -FilePath (Join-Path (Split-Path $PSScriptRoot -Parent) '.runtime\display-configuration.json')
