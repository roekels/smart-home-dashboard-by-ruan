//go:build !darwin && !windows

package collect

import (
	"context"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"edge-agent/internal/client"
)

// Linux, for development and tests: CPU, memory, disk and uptime from /proc. No process list.

type linux struct {
	prevIdle, prevTotal uint64
}

func newOS(Options) Collector { return &linux{} }

func cpuTimes() (idle, total uint64) {
	b, err := os.ReadFile("/proc/stat")
	if err != nil {
		return 0, 0
	}
	f := strings.Fields(strings.SplitN(string(b), "\n", 2)[0])
	for i, s := range f[1:] {
		v, _ := strconv.ParseUint(s, 10, 64)
		total += v
		if i == 3 || i == 4 { // idle, iowait
			idle += v
		}
	}
	return
}

func meminfo() (total, avail float64) {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		v, _ := strconv.ParseFloat(f[1], 64)
		switch f[0] {
		case "MemTotal:":
			total = v * 1024
		case "MemAvailable:":
			avail = v * 1024
		}
	}
	return
}

func (l *linux) Collect(ctx context.Context) []client.Record {
	if l.prevTotal == 0 {
		l.prevIdle, l.prevTotal = cpuTimes()
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(time.Second):
		}
	}
	data := map[string]any{"os": runtime.GOOS, "cores": runtime.NumCPU()}
	idle, total := cpuTimes()
	if dt := total - l.prevTotal; dt > 0 {
		data["cpu"] = round(100*float64(dt-(idle-l.prevIdle))/float64(dt), 1)
	}
	l.prevIdle, l.prevTotal = idle, total
	if mt, ma := meminfo(); mt > 0 {
		data["memTotal"], data["memUsed"], data["mem"] = mt, mt-ma, pct(mt-ma, mt)
	}
	var st syscall.Statfs_t
	if syscall.Statfs("/", &st) == nil {
		t := float64(st.Blocks) * float64(st.Bsize)
		u := t - float64(st.Bavail)*float64(st.Bsize)
		data["diskTotal"], data["diskUsed"], data["disk"] = t, u, pct(u, t)
	}
	if b, err := os.ReadFile("/proc/uptime"); err == nil {
		if v, err := strconv.ParseFloat(strings.Fields(string(b))[0], 64); err == nil {
			data["uptime"] = int64(v)
			data["boot"] = time.Now().Add(-time.Duration(v * float64(time.Second))).UnixMilli()
		}
	}
	return []client.Record{host(data)}
}
