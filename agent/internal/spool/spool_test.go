package spool

import (
	"strings"
	"testing"
	"time"

	"edge-agent/internal/client"
)

func rec(ts int64, n int) client.Record {
	return client.Record{Kind: "metrics.host", TS: ts, Data: map[string]any{"n": n}}
}

func TestBatchCommitKeepsNewRecords(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	_ = s.Append(rec(now, 1), rec(now, 2))
	got, commit, err := s.Batch()
	if err != nil || len(got) != 2 {
		t.Fatalf("%v %d", err, len(got))
	}
	_ = s.Append(rec(now, 3)) // arrives while the batch is in flight
	if err := commit(); err != nil {
		t.Fatal(err)
	}
	got, _, _ = s.Batch()
	if len(got) != 1 || got[0].Data["n"].(interface{ String() string }).String() != "3" {
		t.Fatalf("after commit: %+v", got)
	}
}

func TestDropsOldAndOversized(t *testing.T) {
	s, _ := Open(t.TempDir())
	old := time.Now().Add(-MaxAge - time.Hour).UnixMilli()
	big := client.Record{Kind: "event", TS: time.Now().UnixMilli(), Data: map[string]any{"x": strings.Repeat("a", MaxRecord)}}
	_ = s.Append(rec(old, 1), big, rec(time.Now().UnixMilli(), 2))
	if n := s.Len(); n != 1 {
		t.Fatalf("want 1 record, have %d", n)
	}
}

func TestBatchLimit(t *testing.T) {
	s, _ := Open(t.TempDir())
	now := time.Now().UnixMilli()
	var rs []client.Record
	for i := 0; i < MaxBatch+20; i++ {
		rs = append(rs, rec(now, i))
	}
	_ = s.Append(rs...)
	got, commit, _ := s.Batch()
	if len(got) != MaxBatch {
		t.Fatalf("batch of %d", len(got))
	}
	_ = commit()
	if s.Len() != 20 {
		t.Fatalf("left %d", s.Len())
	}
}
