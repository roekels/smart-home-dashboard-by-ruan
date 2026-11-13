// Package collect reads this machine's stats. It only reads local counters and sends nothing; the agent loop
// decides what leaves the machine. What is never collected: process command lines or arguments, window titles,
// file names, browsing, keystrokes, screenshots, clipboard, user names, location.
package collect

import (
	"context"
	"math"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"edge-agent/internal/client"
)

// Options for a collector.
type Options struct {
	HideProcs bool // true: no process names at all
}

// Collector produces one sample per call. Implementations keep the previous counters to compute CPU %.
type Collector interface {
	Collect(ctx context.Context) []client.Record
}

// New returns the collector for this OS.
func New(o Options) Collector { return newOS(o) }

// Proc is one group of processes with the same name.
type Proc struct {
	Name string  `json:"name"`
	CPU  float64 `json:"cpu"` // % of one core, summed over the group
	Mem  float64 `json:"mem"` // bytes
	N    int     `json:"n"`
}

// top returns the 5 heaviest groups by CPU and by memory, as plain JSON-ready values.
func top(groups map[string]*Proc) (byCPU, byMem []any) {
	rows := make([]*Proc, 0, len(groups))
	for _, g := range groups {
		g.CPU = round(g.CPU, 1)
		rows = append(rows, g)
	}
	pick := func(less func(a, b *Proc) bool) []any {
		sort.Slice(rows, func(i, j int) bool {
			if less(rows[i], rows[j]) != less(rows[j], rows[i]) {
				return less(rows[i], rows[j])
			}
			return rows[i].Name < rows[j].Name
		})
		out := []any{}
		for i := 0; i < len(rows) && i < 5; i++ {
			out = append(out, map[string]any{"name": rows[i].Name, "cpu": rows[i].CPU, "mem": rows[i].Mem, "n": rows[i].N})
		}
		return out
	}
	byCPU = pick(func(a, b *Proc) bool { return a.CPU > b.CPU })
	byMem = pick(func(a, b *Proc) bool { return a.Mem > b.Mem })
	return
}

var appBundle = regexp.MustCompile(`/([^/]+)\.app/`)

// ProcLabel turns an executable path into a short label: the .app bundle name, else the file name without .exe.
// It never looks at arguments.
func ProcLabel(exe string) string {
	if m := appBundle.FindStringSubmatch(exe); m != nil {
		return clip(m[1])
	}
	b := filepath.Base(strings.ReplaceAll(exe, `\`, "/"))
	b = strings.TrimSuffix(strings.TrimSuffix(b, ".exe"), ".EXE")
	if b == "" || b == "." || b == "/" {
		return "?"
	}
	return clip(b)
}

func clip(s string) string {
	if len(s) > 60 {
		return s[:60]
	}
	return s
}

func round(v float64, d int) float64 {
	p := math.Pow(10, float64(d))
	return math.Round(v*p) / p
}

func pct(used, total float64) any {
	if total <= 0 {
		return nil
	}
	return round(100*used/total, 1)
}

func nowMs() int64 { return time.Now().UnixMilli() }

// host builds the metrics.host record, leaving out nil values.
func host(data map[string]any) client.Record {
	for k, v := range data {
		if v == nil {
			delete(data, k)
		}
	}
	return client.Record{Kind: "metrics.host", TS: nowMs(), Data: data}
}
