//go:build darwin

package collect

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"

	"edge-agent/internal/client"
)

// macOS: macmon (sudo-less Apple Silicon sensors) for temperatures, fan, power, GPU and memory; `top` for real CPU %
// per process; `ps` for the executable path (never the arguments) and memory; statfs and sysctl for the rest.
// Same sources as the wall's workers/system_metrics.py.

type darwin struct {
	o     Options
	model string
	osv   string
}

func newOS(o Options) Collector {
	d := &darwin{o: o}
	d.model, _ = unix.Sysctl("hw.model")
	if out, err := exec.Command("/usr/bin/sw_vers", "-productVersion").Output(); err == nil {
		d.osv = "macOS " + strings.TrimSpace(string(out))
	}
	return d
}

var macmonPaths = []string{"/opt/homebrew/bin/macmon", "/usr/local/bin/macmon"}

func run(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).Output()
}

func num(v any) any {
	if f, ok := v.(float64); ok {
		return round(f, 1)
	}
	return nil
}

func (d *darwin) macmon(ctx context.Context) map[string]any {
	for _, p := range macmonPaths {
		if _, err := os.Stat(p); err != nil {
			continue
		}
		out, err := run(ctx, 20*time.Second, p, "pipe", "-s", "1", "-i", "1500")
		if err != nil {
			return map[string]any{"error": "macmon failed"}
		}
		lines := bytes.Split(bytes.TrimSpace(out), []byte("\n"))
		var m map[string]any
		if json.Unmarshal(lines[len(lines)-1], &m) != nil {
			return map[string]any{"error": "macmon output not JSON"}
		}
		mem, _ := m["memory"].(map[string]any)
		temp, _ := m["temp"].(map[string]any)
		r := map[string]any{
			"cpuTemp": num(temp["cpu_temp_avg"]), "gpuTemp": num(temp["gpu_temp_avg"]),
			"power": num(m["all_power"]), "sysPower": num(m["sys_power"]),
		}
		if g, ok := m["gpu_active_ratio"].(float64); ok {
			r["gpu"] = round(100*g, 1)
		}
		if fans, ok := m["fans"].([]any); ok && len(fans) > 0 {
			if f, ok := fans[0].(map[string]any); ok {
				r["fan"], r["fanMax"] = num(f["rpm"]), num(f["max_rpm"])
			}
		}
		if mem != nil {
			mt, _ := mem["ram_total"].(float64)
			mu, _ := mem["ram_usage"].(float64)
			st, _ := mem["swap_total"].(float64)
			su, _ := mem["swap_usage"].(float64)
			r["memTotal"], r["memUsed"], r["mem"] = mt, mu, pct(mu, mt)
			r["swapTotal"], r["swapUsed"], r["swap"] = st, su, pct(su, st)
		}
		return r
	}
	return map[string]any{"error": "macmon not installed (brew install macmon)"}
}

var cpuLine = regexp.MustCompile(`CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys`)

// topCPU takes two top samples 1 s apart; the second carries real (not since-boot) CPU %.
func topCPU(ctx context.Context) (any, map[int]float64) {
	out, err := run(ctx, 25*time.Second, "/usr/bin/top", "-l", "2", "-s", "1", "-n", "2000", "-o", "cpu", "-stats", "pid,cpu")
	if err != nil {
		return nil, nil
	}
	parts := strings.Split(string(out), "Processes:")
	sample := parts[len(parts)-1]
	var cpu any
	if m := cpuLine.FindStringSubmatch(sample); m != nil {
		u, _ := strconv.ParseFloat(m[1], 64)
		s, _ := strconv.ParseFloat(m[2], 64)
		cpu = round(u+s, 1)
	}
	per := map[int]float64{}
	for _, line := range strings.Split(sample, "\n") {
		f := strings.Fields(line)
		if len(f) != 2 {
			continue
		}
		pid, err1 := strconv.Atoi(f[0])
		v, err2 := strconv.ParseFloat(f[1], 64)
		if err1 == nil && err2 == nil {
			per[pid] = v
		}
	}
	return cpu, per
}

// procs groups processes by executable label. `ps -o comm` gives the executable path only, never arguments.
func procs(ctx context.Context, per map[int]float64) map[string]*Proc {
	out, err := run(ctx, 10*time.Second, "/bin/ps", "-Aeo", "pid=,rss=,comm=")
	if err != nil {
		return nil
	}
	groups := map[string]*Proc{}
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 3 {
			continue
		}
		pid, err1 := strconv.Atoi(f[0])
		rss, err2 := strconv.ParseFloat(f[1], 64)
		if err1 != nil || err2 != nil {
			continue
		}
		exe := strings.Join(f[2:], " ")
		name := ProcLabel(exe)
		if name == "top" || name == "ps" || name == "macmon" {
			continue // our own probes
		}
		g := groups[name]
		if g == nil {
			g = &Proc{Name: name}
			groups[name] = g
		}
		g.CPU += per[pid]
		g.Mem += rss * 1024
		g.N++
	}
	return groups
}

func loadavg() any {
	b, err := unix.SysctlRaw("vm.loadavg")
	if err != nil || len(b) < 24 {
		return nil
	}
	scale := float64(binary.LittleEndian.Uint64(b[16:24]))
	if scale == 0 {
		return nil
	}
	out := []any{}
	for i := 0; i < 3; i++ {
		out = append(out, round(float64(binary.LittleEndian.Uint32(b[i*4:]))/scale, 2))
	}
	return out
}

func (d *darwin) Collect(ctx context.Context) []client.Record {
	mmc := make(chan map[string]any, 1)
	go func() { mmc <- d.macmon(ctx) }()
	cpu, per := topCPU(ctx)
	data := <-mmc
	var errs []any
	if e, ok := data["error"]; ok {
		errs = append(errs, e)
		delete(data, "error")
	}
	if cpu == nil {
		errs = append(errs, "top failed")
	}
	data["os"], data["model"], data["cores"], data["cpu"], data["load"] = d.osv, d.model, runtime.NumCPU(), cpu, loadavg()
	if data["memTotal"] == nil {
		if mt, err := unix.SysctlUint64("hw.memsize"); err == nil {
			data["memTotal"] = float64(mt)
		}
	}
	var st unix.Statfs_t
	if unix.Statfs("/System/Volumes/Data", &st) == nil || unix.Statfs("/", &st) == nil {
		total := float64(st.Blocks) * float64(st.Bsize)
		used := total - float64(st.Bavail)*float64(st.Bsize)
		data["diskTotal"], data["diskUsed"], data["disk"] = total, used, pct(used, total)
	}
	if tv, err := unix.SysctlTimeval("kern.boottime"); err == nil {
		data["boot"] = tv.Sec * 1000
		data["uptime"] = time.Now().Unix() - tv.Sec
	}
	if !d.o.HideProcs {
		if g := procs(ctx, per); g != nil {
			data["topCpu"], data["topMem"] = top(g)
		}
	}
	if len(errs) > 0 {
		data["errors"] = errs
	}
	return []client.Record{host(data)}
}
