// Package secret protects small secrets at rest: the identity key and the Access service token.
// Files are always written 0600 in the agent's own folder; on Windows the bytes are also wrapped with DPAPI.
package secret

import (
	"errors"
	"os"
)

// WriteFile protects b and writes it to path (0600), replacing any old file.
func WriteFile(path string, b []byte) error {
	sealed, err := Protect(b)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, sealed, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ReadFile reads and unprotects path. A missing file returns (nil, nil).
func ReadFile(path string) ([]byte, error) {
	sealed, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return Unprotect(sealed)
}
