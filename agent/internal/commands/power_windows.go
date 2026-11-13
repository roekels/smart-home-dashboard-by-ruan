//go:build windows

package commands

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"

	"golang.org/x/sys/windows"
)

const shutdownExe = `C:\Windows\System32\shutdown.exe`

// shutdown is a FULL shutdown (not fast-startup hybrid), so the next magic packet wakes the PC. /t > 0 implies /f:
// open apps are closed without saving, which is why the op is destructive. Fixed arguments only.
func shutdown(ctx context.Context, delay int64) error {
	return runShutdown(ctx, "/s", "/t", strconv.FormatInt(delay, 10), "/c", "Turned off from the dashboard")
}

func cancelShutdown(ctx context.Context) error { return runShutdown(ctx, "/a") }

func runShutdown(ctx context.Context, args ...string) error {
	cmd := exec.CommandContext(ctx, shutdownExe, args...)
	cmd.SysProcAttr = &windows.SysProcAttr{HideWindow: true}
	err := cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		switch ee.ExitCode() {
		case 1190:
			return errors.New("a shutdown is already scheduled")
		case 1116:
			return errors.New("no shutdown was scheduled")
		}
		return fmt.Errorf("shutdown.exe exited with %d", ee.ExitCode())
	}
	return err
}
