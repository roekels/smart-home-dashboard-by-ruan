//go:build windows

package secret

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// On Windows a secret is wrapped with DPAPI for this machine (so a copied file is useless elsewhere) and the state
// folder's ACL limits it to the service account and Administrators (install.ps1 sets it).
const Backend = "software key, DPAPI (this machine) + folder ACL"

var entropy = []byte("edge-agent v1")

func blob(b []byte) *windows.DataBlob {
	if len(b) == 0 {
		return &windows.DataBlob{}
	}
	return &windows.DataBlob{Size: uint32(len(b)), Data: &b[0]}
}

func takeBlob(out windows.DataBlob) []byte {
	defer windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return append([]byte(nil), unsafe.Slice(out.Data, out.Size)...)
}

func Protect(b []byte) ([]byte, error) {
	var out windows.DataBlob
	err := windows.CryptProtectData(blob(b), nil, blob(entropy), 0, nil,
		windows.CRYPTPROTECT_UI_FORBIDDEN|windows.CRYPTPROTECT_LOCAL_MACHINE, &out)
	if err != nil {
		return nil, err
	}
	return takeBlob(out), nil
}

func Unprotect(b []byte) ([]byte, error) {
	var out windows.DataBlob
	err := windows.CryptUnprotectData(blob(b), nil, blob(entropy), 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out)
	if err != nil {
		return nil, err
	}
	return takeBlob(out), nil
}
