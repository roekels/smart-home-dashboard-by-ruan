package keys

import (
	"crypto/ed25519"
	"path/filepath"
	"testing"
)

func TestCreateLoadSign(t *testing.T) {
	p := filepath.Join(t.TempDir(), "identity.key")
	if _, err := Load(p); err != ErrNoKey {
		t.Fatalf("want ErrNoKey, got %v", err)
	}
	k, err := Create(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Create(p); err == nil {
		t.Fatal("overwrote an existing key")
	}
	again, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if string(again.PublicRaw()) != string(k.PublicRaw()) || len(k.PublicRaw()) != 32 {
		t.Fatal("loaded a different key")
	}
	sig, err := again.Sign([]byte("agent-v1\nPOST"))
	if err != nil || !ed25519.Verify(k.PublicRaw(), []byte("agent-v1\nPOST"), sig) {
		t.Fatalf("signature does not verify: %v", err)
	}
}
