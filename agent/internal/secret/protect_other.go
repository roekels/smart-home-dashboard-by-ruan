//go:build !windows

package secret

// On macOS (and Linux, for development) the key file is protected by its 0600 mode in the agent's own folder.
const Backend = "software key, file readable only by the agent's user"

func Protect(b []byte) ([]byte, error)   { return b, nil }
func Unprotect(b []byte) ([]byte, error) { return b, nil }
