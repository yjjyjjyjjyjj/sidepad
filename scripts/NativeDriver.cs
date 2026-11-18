// Uses documented Windows SetupAPI/newdev APIs. Only Root\MttVDD is supported.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class SidepadNativeDriver {
    [StructLayout(LayoutKind.Sequential)]
    struct DeviceInfo { public uint size; public Guid classGuid; public uint devInst; public UIntPtr reserved; }
    [DllImport("setupapi.dll", SetLastError=true)]
    static extern IntPtr SetupDiCreateDeviceInfoList(ref Guid guid, IntPtr parent);
    [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool SetupDiCreateDeviceInfo(IntPtr set, string name, ref Guid guid, string description, IntPtr parent, uint flags, ref DeviceInfo device);
    [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool SetupDiSetDeviceRegistryProperty(IntPtr set, ref DeviceInfo device, uint property, byte[] buffer, uint size);
    [DllImport("setupapi.dll", SetLastError=true)]
    static extern bool SetupDiCallClassInstaller(uint function, IntPtr set, ref DeviceInfo device);
    [DllImport("setupapi.dll", SetLastError=true)]
    static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
    [DllImport("newdev.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool UpdateDriverForPlugAndPlayDevices(IntPtr parent, string hardwareId, string inf, uint flags, out bool reboot);
    static void Check(bool ok, string operation) {
        if (!ok) { int error=Marshal.GetLastWin32Error(); throw new Win32Exception(error, operation + ": " + new Win32Exception(error).Message); }
    }
    public static bool Install(string inf) {
        if (!Environment.Is64BitProcess) throw new InvalidOperationException("A 64-bit installer process is required.");
        var guid = new Guid("4D36E968-E325-11CE-BFC1-08002BE10318");
        var set = SetupDiCreateDeviceInfoList(ref guid, IntPtr.Zero);
        if (set == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        var device = new DeviceInfo { size=(uint)Marshal.SizeOf(typeof(DeviceInfo)) };
        bool registered=false, installed=false;
        try {
            Check(SetupDiCreateDeviceInfo(set, "Display", ref guid, "Virtual Display Driver", IntPtr.Zero, 1, ref device), "Create virtual display");
            var ids=Encoding.Unicode.GetBytes("Root\\MttVDD\0\0");
            Check(SetupDiSetDeviceRegistryProperty(set, ref device, 1, ids, (uint)ids.Length), "Set virtual display hardware ID");
            Check(SetupDiCallClassInstaller(0x19, set, ref device), "Register virtual display");
            registered=true;
            bool reboot;
            // No FORCE or trust bypass flags; Windows validates the signed package.
            Check(UpdateDriverForPlugAndPlayDevices(IntPtr.Zero, "Root\\MttVDD", inf, 0, out reboot), "Install signed virtual display driver");
            installed=true;
            return reboot;
        } finally {
            // Roll back only the device created by this invocation on failure.
            if (registered && !installed) SetupDiCallClassInstaller(0x05, set, ref device);
            SetupDiDestroyDeviceInfoList(set);
        }
    }
}
