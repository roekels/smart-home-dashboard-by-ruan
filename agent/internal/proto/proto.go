// Package proto implements the agent side of PROTOCOL.md (agent protocol v1): the canonical strings that
// are signed, canonical JSON for command arguments, fingerprints and the key and signature encodings.
//
// Everything here must match modules/edge-agents/sign.ts byte for byte. testdata/worker-vectors.json holds values produced
// by that file; proto_test.go checks them.
package proto

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// B64 is unpadded base64url, the encoding of every key, signature and nonce on the wire.
var B64 = base64.RawURLEncoding

// SHA256Hex returns the lowercase hex sha256 of b.
func SHA256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// RequestString is the canonical string an agent signs for every request:
// agent-v1, METHOD, path (no host, no query), agent id, ts (ms), nonce, sha256(body) hex.
func RequestString(method, path, agent, ts, nonce string, body []byte) string {
	return strings.Join([]string{"agent-v1", strings.ToUpper(method), path, agent, ts, nonce, SHA256Hex(body)}, "\n")
}

// CommandString is what the Worker signs for each command:
// cmd-v1, agent id, command id, op, sha256(canonical args JSON) hex, expires (ms).
func CommandString(agent, id, op string, args any, expires int64) (string, error) {
	cj, err := CanonicalJSON(args)
	if err != nil {
		return "", err
	}
	return strings.Join([]string{"cmd-v1", agent, id, op, SHA256Hex([]byte(cj)), strconv.FormatInt(expires, 10)}, "\n"), nil
}

// Fingerprint is what an admin compares by eye at approval: base64url of the first 16 bytes of sha256(raw public key).
func Fingerprint(rawPub []byte) string {
	s := sha256.Sum256(rawPub)
	return B64.EncodeToString(s[:16])
}

// DecodeJSON parses JSON keeping numbers as written (json.Number). The Worker writes them with JSON.stringify, so
// keeping the text is what makes CanonicalJSON reproduce the Worker's bytes exactly.
func DecodeJSON(b []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	return d.Decode(v)
}

// CanonicalJSON matches canonicalJson in modules/edge-agents/sign.ts: object keys sorted (by UTF-16 code units, like
// JavaScript's sort) at every level, no whitespace, strings escaped like JSON.stringify.
// It accepts what DecodeJSON produces (map[string]any, []any, json.Number, string, bool, nil) plus Go numbers.
func CanonicalJSON(v any) (string, error) {
	var sb strings.Builder
	if err := writeCanonical(&sb, v); err != nil {
		return "", err
	}
	return sb.String(), nil
}

func writeCanonical(sb *strings.Builder, v any) error {
	switch t := v.(type) {
	case nil:
		sb.WriteString("null")
	case bool:
		if t {
			sb.WriteString("true")
		} else {
			sb.WriteString("false")
		}
	case string:
		writeJSString(sb, t)
	case json.Number:
		sb.WriteString(t.String())
	case int:
		sb.WriteString(strconv.Itoa(t))
	case int64:
		sb.WriteString(strconv.FormatInt(t, 10))
	case float64:
		b, err := json.Marshal(t) // Go formats floats like ES6 (JSON.stringify)
		if err != nil {
			return err
		}
		sb.Write(b)
	case []any:
		sb.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				sb.WriteByte(',')
			}
			if err := writeCanonical(sb, e); err != nil {
				return err
			}
		}
		sb.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Slice(keys, func(i, j int) bool { return lessUTF16(keys[i], keys[j]) })
		sb.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				sb.WriteByte(',')
			}
			writeJSString(sb, k)
			sb.WriteByte(':')
			if err := writeCanonical(sb, t[k]); err != nil {
				return err
			}
		}
		sb.WriteByte('}')
	default:
		return fmt.Errorf("canonical JSON: unsupported type %T", v)
	}
	return nil
}

// writeJSString writes s the way JavaScript's JSON.stringify does: escapes ", \, \b \f \n \r \t, other control
// characters as \u00xx, and nothing else (no HTML escaping, U+2028/2029 stay as they are).
func writeJSString(sb *strings.Builder, s string) {
	const hexd = "0123456789abcdef"
	sb.WriteByte('"')
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		i += size
		switch {
		case r == '"':
			sb.WriteString(`\"`)
		case r == '\\':
			sb.WriteString(`\\`)
		case r == '\b':
			sb.WriteString(`\b`)
		case r == '\f':
			sb.WriteString(`\f`)
		case r == '\n':
			sb.WriteString(`\n`)
		case r == '\r':
			sb.WriteString(`\r`)
		case r == '\t':
			sb.WriteString(`\t`)
		case r < 0x20:
			sb.WriteString(`\u00`)
			sb.WriteByte(hexd[r>>4])
			sb.WriteByte(hexd[r&0xf])
		default:
			sb.WriteRune(r) // invalid UTF-8 becomes U+FFFD, as it would after JSON parsing
		}
	}
	sb.WriteByte('"')
}

func lessUTF16(a, b string) bool {
	ua, ub := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			return ua[i] < ub[i]
		}
	}
	return len(ua) < len(ub)
}
