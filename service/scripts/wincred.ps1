param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('read', 'write', 'delete')]
    [string]$Operation,
    [ValidatePattern('^PSAI\.Canvas\.(Bailian|Test\.[0-9a-fA-F-]+)$')]
    [string]$Target = 'PSAI.Canvas.Bailian'
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class PsAiCredential {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NativeCredential {
        public UInt32 Flags;
        public UInt32 Type;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
        [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
        [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref NativeCredential credential, UInt32 flags);
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern void CredFree(IntPtr credential);

    public static void Write(string target, byte[] blob) {
        IntPtr pointer = Marshal.AllocHGlobal(blob.Length);
        try {
            Marshal.Copy(blob, 0, pointer, blob.Length);
            NativeCredential credential = new NativeCredential {
                Type = 1,
                TargetName = target,
                CredentialBlobSize = (UInt32)blob.Length,
                CredentialBlob = pointer,
                Persist = 2,
                UserName = Environment.UserName
            };
            if (!CredWrite(ref credential, 0)) throw new InvalidOperationException("CredWrite failed: " + Marshal.GetLastWin32Error());
        } finally {
            Marshal.FreeHGlobal(pointer);
        }
    }

    public static byte[] Read(string target) {
        IntPtr pointer;
        if (!CredRead(target, 1, 0, out pointer)) {
            if (Marshal.GetLastWin32Error() == 1168) return null;
            throw new InvalidOperationException("CredRead failed");
        }
        try {
            NativeCredential credential = (NativeCredential)Marshal.PtrToStructure(pointer, typeof(NativeCredential));
            byte[] blob = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, blob, 0, blob.Length);
            return blob;
        } finally {
            CredFree(pointer);
        }
    }

    public static void Delete(string target) {
        if (!CredDelete(target, 1, 0) && Marshal.GetLastWin32Error() != 1168)
            throw new InvalidOperationException("CredDelete failed");
    }
}
'@

switch ($Operation) {
    'write' {
        $inputText = [Console]::In.ReadToEnd()
        $bytes = [Text.Encoding]::UTF8.GetBytes($inputText)
        [PsAiCredential]::Write($Target, $bytes)
    }
    'read' {
        $bytes = [PsAiCredential]::Read($Target)
        if ($null -ne $bytes) { [Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes)) }
    }
    'delete' { [PsAiCredential]::Delete($Target) }
}
