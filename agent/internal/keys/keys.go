// Package keys holds the agent's identity: one Ed25519 key per machine, made here at enrolment. The private key
// never leaves the machine. It is a file in the agent's folder that only the agent can read (0600; on Windows
// wrapped with DPAPI for this machine and protected by the folder's ACL). The dashboard only ever gets the public
// half.
package keys

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"os"

	"edge-agent/internal/secret"
)

// Signer signs request strings for the agent protocol.
type Signer interface {
	PublicRaw() []byte // 32-byte Ed25519 public key
	Sign(msg []byte) ([]byte, error)
	Backend() string // where the key lives, for `status`
}

type fileKey struct{ priv ed25519.PrivateKey }

func (k *fileKey) Backend() string                 { return secret.Backend }
func (k *fileKey) PublicRaw() []byte               { return k.priv.Public().(ed25519.PublicKey) }
func (k *fileKey) Sign(msg []byte) ([]byte, error) { return ed25519.Sign(k.priv, msg), nil }

// ErrNoKey means the agent has not been enrolled on this machine yet.
var ErrNoKey = errors.New("no identity key yet: run `edge-agent enrol`")

// Create makes a new key and stores it at path. It refuses to overwrite an existing key.
func Create(path string) (Signer, error) {
	if _, err := os.Stat(path); err == nil {
		return nil, fmt.Errorf("a key already exists at %s (delete the agent's folder to start over, and revoke the old agent in the dashboard)", path)
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	sealed, err := secret.Protect(priv.Seed())
	if err != nil {
		return nil, fmt.Errorf("protect key: %w", err)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	if _, err := f.Write(sealed); err != nil {
		f.Close()
		os.Remove(path)
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	return &fileKey{priv: priv}, nil
}

// Load reads the key stored at path.
func Load(path string) (Signer, error) {
	sealed, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNoKey
	}
	if err != nil {
		return nil, err
	}
	seed, err := secret.Unprotect(sealed)
	if err != nil {
		return nil, fmt.Errorf("unprotect key: %w", err)
	}
	if len(seed) != ed25519.SeedSize {
		return nil, errors.New("identity key file is not an Ed25519 key")
	}
	return &fileKey{priv: ed25519.NewKeyFromSeed(seed)}, nil
}
