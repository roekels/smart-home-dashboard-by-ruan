package commands

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

// Seen remembers command ids until they expire (plus a day), so a replayed command never runs twice, even across
// restarts.
type Seen struct {
	mu   sync.Mutex
	path string
	ids  map[string]int64 // id -> expires (ms)
}

// OpenSeen loads path (missing is fine).
func OpenSeen(path string) *Seen {
	s := &Seen{path: path, ids: map[string]int64{}}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &s.ids)
	}
	return s
}

// Add records id and reports whether it was new.
func (s *Seen) Add(id string, expires int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, dup := s.ids[id]; dup {
		return false
	}
	keep := time.Now().Add(-24 * time.Hour).UnixMilli()
	for k, e := range s.ids {
		if e < keep {
			delete(s.ids, k)
		}
	}
	s.ids[id] = expires
	if s.path != "" {
		if b, err := json.Marshal(s.ids); err == nil {
			tmp := s.path + ".tmp"
			if os.WriteFile(tmp, b, 0o600) == nil {
				_ = os.Rename(tmp, s.path)
			}
		}
	}
	return true
}
