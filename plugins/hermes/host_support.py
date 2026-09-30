"""Private files on POSIX and native Windows (Python 3.11+); no third-party SDK."""
import ctypes
import os
from pathlib import Path
import sys


def _windows_private(path, directory):
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    security = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    security.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    security.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                             wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    security.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    security.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    security.SetFileSecurityW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p]
    token = wintypes.HANDLE()
    sid_string = wintypes.LPWSTR()
    descriptor = ctypes.c_void_p()
    try:
        if not security.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
            raise ctypes.WinError(ctypes.get_last_error())
        needed = wintypes.DWORD()
        security.GetTokenInformation(token, 1, None, 0, ctypes.byref(needed))
        if not needed.value:
            raise ctypes.WinError(ctypes.get_last_error())
        buffer = ctypes.create_string_buffer(needed.value)
        if not security.GetTokenInformation(token, 1, buffer, needed, ctypes.byref(needed)):
            raise ctypes.WinError(ctypes.get_last_error())
        sid = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p))[0]
        if not security.ConvertSidToStringSidW(sid, ctypes.byref(sid_string)):
            raise ctypes.WinError(ctypes.get_last_error())
        inheritance = "OICI" if directory else ""
        # Replace the DACL, remove inherited grants, retain only this user and SYSTEM.
        sddl = f"D:P(A;{inheritance};FA;;;SY)(A;{inheritance};FA;;;{sid_string.value})"
        if not security.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
            raise ctypes.WinError(ctypes.get_last_error())
        if not security.SetFileSecurityW(str(Path(path).resolve()), 0x80000004, descriptor):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        if descriptor:
            kernel.LocalFree(descriptor)
        if sid_string:
            kernel.LocalFree(ctypes.cast(sid_string, ctypes.c_void_p))
        if token:
            kernel.CloseHandle(token)


def secure_path(path, directory=False):
    path = Path(path)
    if os.name == "nt":
        _windows_private(path, directory)
    else:
        path.chmod(0o700 if directory else 0o600)


def private_directory(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    secure_path(path, directory=True)


def private_open(path, flags):
    path = Path(path)
    private_directory(path.parent)
    fd = os.open(path, flags, 0o600)
    try:
        secure_path(path)
    except BaseException:
        os.close(fd)
        raise
    return fd


def secure_state(path):
    path = Path(path)
    private_directory(path.parent)
    files = [path, path.with_suffix(".pid"), path.with_suffix(".stderr.log")]
    files += [Path(str(path) + suffix) for suffix in (".pending", ".a2a-runtime.json", ".status.json", ".hermes-stop.json")]
    files += list(path.parent.glob(".state-*"))
    for suffix in (".lock", ".hermes-runner.lock"):
        folder = Path(str(path) + suffix)
        if folder.is_dir():
            secure_path(folder, directory=True)
            files.append(folder / "owner.json")
    for file in files:
        if file.is_file():
            secure_path(file)


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "--secure-state":
        raise SystemExit("Usage: host_support.py --secure-state PATH")
    secure_state(sys.argv[2])
