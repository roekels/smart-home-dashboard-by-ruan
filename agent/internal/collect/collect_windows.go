//go:build windows

package collect

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"edge-agent/internal/client"
)

// Windows: native calls only (no PowerShell, no WMI), so the service account needs no extra rights.
//   CPU      GetSystemTimes, delta between samples
//   memory   GlobalMemoryStatusEx
//   disk     GetDiskFreeSpaceEx on C:\
//   procs    NtQuerySystemInformation(SystemProcessInformation): CPU time and working set of every process,
//            image name only (no command lines). Readable without admin rights.
//   GPU      nvidia-smi from the driver, fixed arguments (same query as the old sampler.ps1)

var (
	kernel32                 = windows.NewLazySystemDLL("kernel32.dll")
	procGetSystemTimes       = kernel32.NewProc("GetSystemTimes")
	procGlobalMemoryStatusEx = kernel32.NewProc("GlobalMemoryStatusEx")
)

const nvidiaSmi = `C:\Windows\System32\nvidia-smi.exe`

type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

type win struct {
	o        Options
	osv, cpu string
	prevSys  [3]uint64 // idle, kernel, user (100 ns)
	prevProc map[uintptr]int64
	prevT    time.Time
}

func newOS(o Options) Collector {
	w := &win{o: o}
	v := windows.RtlGetVersion()
	w.osv = fmt.Sprintf("Windows %d.%d.%d", v.MajorVersion, v.MinorVersion, v.BuildNumber)
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, `HARDWARE\DESCRIPTION\System\CentralProcessor\0`, registry.QUERY_VALUE); err == nil {
		w.cpu, _, _ = k.GetStringValue("ProcessorNameString")
		w.cpu = strings.TrimSpace(w.cpu)
		k.Close()
	}
	return w
}

func ft(f windows.Filetime) uint64 { return uint64(f.HighDateTime)<<32 | uint64(f.LowDateTime) }

func systemTimes() ([3]uint64, bool) {
	var idle, kern, user windows.Filetime
	r, _, _ := procGetSystemTimes.Call(uintptr(unsafe.Pointer(&idle)), uintptr(unsafe.Pointer(&kern)), uintptr(unsafe.Pointer(&user)))
	return [3]uint64{ft(idle), ft(kern), ft(user)}, r != 0
}

// processes returns per-PID total CPU time (100 ns) and a name and working set per PID.
func processes() (map[uintptr]int64, map[uintptr]string, map[uintptr]float64) {
	size := uint32(1 << 20)
	var buf []byte
	for i := 0; i < 6; i++ {
		buf = make([]byte, size)
		var need uint32
		err := windows.NtQuerySystemInformation(windows.SystemProcessInformation, unsafe.Pointer(&buf[0]), size, &need)
		if err == nil {
			break
		}
		if err != windows.STATUS_INFO_LENGTH_MISMATCH {
			return nil, nil, nil
		}
		size = need + 64<<10
		buf = nil
	}
	if buf == nil {
		return nil, nil, nil
	}
	times, names, mem := map[uintptr]int64{}, map[uintptr]string{}, map[uintptr]float64{}
	for off := uint32(0); ; {
		p := (*windows.SYSTEM_PROCESS_INFORMATION)(unsafe.Pointer(&buf[off]))
		pid := p.UniqueProcessID
		name := "System Idle Process"
		if p.ImageName.Buffer != nil {
			name = p.ImageName.String()
		}
		if pid != 0 {
			times[pid] = p.UserTime + p.KernelTime
			names[pid] = ProcLabel(name)
			mem[pid] = float64(p.WorkingSetSize)
		}
		if p.NextEntryOffset == 0 {
			break
		}
		off += p.NextEntryOffset
	}
	return times, names, mem
}

func (w *win) gpu(ctx context.Context) []client.Record {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, nvidiaSmi,
		"--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,fan.speed,clocks.sm",
		"--format=csv,noheader,nounits")
	cmd.SysProcAttr = &windows.SysProcAttr{HideWindow: true}
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	f := strings.Split(strings.SplitN(strings.TrimSpace(string(out)), "\n", 2)[0], ",")
	if len(f) < 8 {
		return nil
	}
	n := func(i int) any {
		v, err := strconv.ParseFloat(strings.TrimSpace(f[i]), 64)
		if err != nil {
			return nil
		}
		return round(v, 1)
	}
	d := map[string]any{"name": strings.TrimSpace(f[0]), "temp": n(1), "util": n(2), "vram": n(3), "vramTotal": n(4),
		"power": n(5), "fan": n(6), "clock": n(7)}
	for k, v := range d {
		if v == nil {
			delete(d, k)
		}
	}
	return []client.Record{{Kind: "metrics.gpu", TS: nowMs(), Data: d}}
}

func (w *win) Collect(ctx context.Context) []client.Record {
	if w.prevT.IsZero() { // first call: take a baseline so CPU % covers a real interval
		w.prevSys, _ = systemTimes()
		w.prevProc, _, _ = processes()
		w.prevT = time.Now()
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(time.Second):
		}
	}
	data := map[string]any{"os": w.osv, "model": w.cpu, "cores": runtime.NumCPU()}
	now := time.Now()
	if st, ok := systemTimes(); ok {
		idle := float64(st[0] - w.prevSys[0])
		total := float64((st[1] - w.prevSys[1]) + (st[2] - w.prevSys[2])) // kernel time includes idle
		if total > 0 {
			data["cpu"] = round(100*(total-idle)/total, 1)
		}
		w.prevSys = st
	}
	var ms memoryStatusEx
	ms.Length = uint32(unsafe.Sizeof(ms))
	if r, _, _ := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&ms))); r != 0 {
		used := float64(ms.TotalPhys - ms.AvailPhys)
		data["memTotal"], data["memUsed"], data["mem"] = float64(ms.TotalPhys), used, pct(used, float64(ms.TotalPhys))
	}
	var free, total, totalFree uint64
	if windows.GetDiskFreeSpaceEx(windows.StringToUTF16Ptr(`C:\`), &free, &total, &totalFree) == nil {
		used := float64(total - totalFree)
		data["diskTotal"], data["diskUsed"], data["disk"] = float64(total), used, pct(used, float64(total))
	}
	up := windows.DurationSinceBoot()
	data["uptime"] = int64(up.Seconds())
	data["boot"] = now.Add(-up).UnixMilli()

	times, names, mem := processes()
	if times != nil {
		dt := now.Sub(w.prevT).Seconds() * 1e7 // 100 ns units
		if !w.o.HideProcs && dt > 0 {
			groups := map[string]*Proc{}
			for pid, t := range times {
				name := names[pid]
				if name == "edge-agent" {
					continue
				}
				g := groups[name]
				if g == nil {
					g = &Proc{Name: name}
					groups[name] = g
				}
				if prev, ok := w.prevProc[pid]; ok && t >= prev {
					g.CPU += 100 * float64(t-prev) / dt
				}
				g.Mem += mem[pid]
				g.N++
			}
			data["topCpu"], data["topMem"] = top(groups)
		}
		w.prevProc = times
	}
	w.prevT = now
	return append([]client.Record{host(data)}, w.gpu(ctx)...)
}
