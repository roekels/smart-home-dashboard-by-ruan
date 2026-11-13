// Package spool keeps records on disk until the Worker has them, so a machine that is offline (or a Worker that is
// down) loses nothing for up to MaxAge. One JSON record per line, oldest first, in <agent folder>/spool/queue.jsonl.
package spool

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"edge-agent/internal/client"
	"edge-agent/internal/proto"
)

// How much is kept while offline, and the Worker's per-batch limits.
const (
	MaxAge        = 48 * time.Hour
	MaxBytes      = 50 << 20
	MaxBatch      = 500
	MaxBatchBytes = 200 << 10 // the Worker refuses bodies over 256 KB
	MaxRecord     = 8 << 10   // the Worker refuses a record whose data is over 8 KB
)

// Spool is safe for concurrent use.
type Spool struct {
	mu   sync.Mutex
	path string
	now  func() time.Time
}

// Open uses dir/queue.jsonl, creating dir if needed.
func Open(dir string) (*Spool, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &Spool{path: filepath.Join(dir, "queue.jsonl"), now: time.Now}, nil
}

// Append adds records. Records whose data is too large for the Worker are dropped here, not retried forever.
func (s *Spool) Append(recs ...client.Record) error {
	var buf bytes.Buffer
	for _, r := range recs {
		d, err := json.Marshal(r.Data)
		if err != nil || len(d) > MaxRecord {
			continue
		}
		line, err := json.Marshal(r)
		if err != nil {
			continue
		}
		buf.Write(line)
		buf.WriteByte('\n')
	}
	if buf.Len() == 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := os.OpenFile(s.path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(buf.Bytes()); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if st, err := os.Stat(s.path); err == nil && st.Size() > MaxBytes {
		return s.trimLocked()
	}
	return nil
}

// lines reads the queue, dropping records older than MaxAge and lines that no longer parse.
func (s *Spool) linesLocked() ([][]byte, []client.Record, error) {
	b, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	oldest := s.now().Add(-MaxAge).UnixMilli()
	var raws [][]byte
	var recs []client.Record
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		var r client.Record
		if err := proto.DecodeJSON(sc.Bytes(), &r); err != nil || r.TS < oldest {
			continue
		}
		raws = append(raws, append([]byte(nil), sc.Bytes()...))
		recs = append(recs, r)
	}
	return raws, recs, sc.Err()
}

func (s *Spool) writeLocked(raws [][]byte) error {
	if len(raws) == 0 {
		err := os.Remove(s.path)
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, append(bytes.Join(raws, []byte{'\n'}), '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// trimLocked drops the oldest half when the queue is over MaxBytes.
func (s *Spool) trimLocked() error {
	raws, _, err := s.linesLocked()
	if err != nil {
		return err
	}
	return s.writeLocked(raws[len(raws)/2:])
}

// Batch returns the oldest records that fit one ingest request, and a function that removes them once the Worker
// has accepted them. Records appended in between are kept.
func (s *Spool) Batch() ([]client.Record, func() error, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	raws, recs, err := s.linesLocked()
	if err != nil || len(recs) == 0 {
		return nil, func() error { return nil }, err
	}
	n, size := 0, 0
	for n < len(recs) && n < MaxBatch && size+len(raws[n])+1 <= MaxBatchBytes {
		size += len(raws[n]) + 1
		n++
	}
	sent := raws[:n]
	commit := func() error {
		s.mu.Lock()
		defer s.mu.Unlock()
		now, _, err := s.linesLocked()
		if err != nil {
			return err
		}
		// drop the sent lines from the front (aged-out lines may already be gone)
		i, j := 0, 0
		for i < len(now) && j < len(sent) {
			if bytes.Equal(now[i], sent[j]) {
				i++
			}
			j++
		}
		return s.writeLocked(now[i:])
	}
	return recs[:n], commit, nil
}

// Len counts the queued records (for `status`).
func (s *Spool) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, recs, _ := s.linesLocked()
	return len(recs)
}
