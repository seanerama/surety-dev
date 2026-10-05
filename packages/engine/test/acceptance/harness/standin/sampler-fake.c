/* A native FAKE `claude` for the host sampler's cases (M136 S3; the E79
 * rehearsal's finding 2; D2 §4.5, §7.2; SEAM.md §172). The Verifier's
 * instrument, never Claude Code: it contacts nothing and runs no model.
 *
 * The engine's host sampler identifies the backend by /proc/<pid>/exe
 * against the pinned copy, which a script never matches; this image is the
 * backend process. It runs the embedded script (the canaries, stream-json)
 * with node as a child, passes TERM, INT and HUP on to it, and ends as it
 * ended. During the containment canary, and only inside a sandbox (the
 * guard's second half: /surety/context exists and this process's pid
 * namespace is not the host's, compiled in by the test), it does what its
 * mode says, after START_DELAY_MS:
 *   MODE 1  COUNT times: fork; the child stays this image, not exec'd, for
 *           HOLD_MS, then execs /bin/true (a fork window, held long enough
 *           to be sampled, as Claude Code opens one for each command it
 *           runs);
 *   MODE 2  fork; the child execs this image again as a second instance
 *           that persists HOLD_MS (argv `--surety-sampler-fake-hold <ms>`);
 *   MODE 3  fork; the child stays this image, never exec'd, HOLD_MS, then
 *           exits.
 * Nothing is signalled but the node child, nothing written but by it.
 * Built by harness/sandbox/nativefake.mjs with -D values and the script
 * embedded (rehearsal-claude's form; no xxd).
 */
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include "sampler-fake.script.h" /* SCRIPT[], NUL-terminated */

static volatile pid_t child = -1;
static void pass_on(int sig) { if (child > 0) kill(child, sig); }
static void sleep_ms(long ms) {
  struct timespec ts = {ms / 1000, (ms % 1000) * 1000000L};
  while (nanosleep(&ts, &ts) < 0 && errno == EINTR) {}
}

/* The guard's second half, and whether this is the containment canary. */
static int contained_containment(void) {
  char ns[64] = {0};
  ssize_t n = readlink("/proc/self/ns/pid", ns, sizeof ns - 1);
  if (n <= 0 || strcmp(ns, HOST_PID_NS) == 0) return 0;
  int fd = open("/surety/context/canary.json", O_RDONLY);
  if (fd < 0) return 0;
  char buf[8192] = {0};
  ssize_t r = read(fd, buf, sizeof buf - 1);
  close(fd);
  return r > 0 && strstr(buf, "\"kind\": \"containment\"") != NULL;
}

int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "--surety-sampler-fake-hold") == 0) {
    sleep_ms(atol(argv[2]));
    return 0;
  }
  int act = argc > 1 && contained_containment();
  long linger = act ? START_DELAY_MS + (FAKE_MODE == 1 ? COUNT * (HOLD_MS + 100) : HOLD_MS) + 1500 : 0;
  char lingerv[32];
  snprintf(lingerv, sizeof lingerv, "%ld", linger);
  setenv("SURETY_SAMPLER_FAKE_LINGER_MS", lingerv, 1);
  char **av = calloc((size_t)argc + 4, sizeof *av);
  if (av == NULL) return 70;
  av[0] = FAKE_NODE;
  av[1] = "-e";
  av[2] = (char *)SCRIPT;
  av[3] = argv[0];
  for (int i = 1; i < argc; i++) av[3 + i] = argv[i];
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = pass_on;
  sigemptyset(&sa.sa_mask);
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGINT, &sa, NULL);
  sigaction(SIGHUP, &sa, NULL);
  child = fork();
  if (child < 0) return 71;
  if (child == 0) {
    signal(SIGTERM, SIG_DFL);
    signal(SIGINT, SIG_DFL);
    signal(SIGHUP, SIG_DFL);
    execv(FAKE_NODE, av);
    _exit(127);
  }
  if (act) {
    sleep_ms(START_DELAY_MS);
    int n = FAKE_MODE == 1 ? COUNT : 1;
    for (int i = 0; i < n; i++) {
      pid_t k = fork();
      if (k == 0) {
        signal(SIGTERM, SIG_DFL);
        if (FAKE_MODE == 1) {
          sleep_ms(HOLD_MS);
          execl("/bin/true", "true", (char *)NULL);
          _exit(0);
        }
        if (FAKE_MODE == 2) {
          char ms[32];
          snprintf(ms, sizeof ms, "%ld", (long)HOLD_MS);
          execl("/proc/self/exe", argv[0], "--surety-sampler-fake-hold", ms, (char *)NULL);
          _exit(0);
        }
        sleep_ms(HOLD_MS);
        _exit(0);
      }
      if (k > 0 && FAKE_MODE == 1) {
        while (waitpid(k, NULL, 0) < 0 && errno == EINTR) {}
        sleep_ms(100);
      }
    }
  }
  int st = 0;
  while (waitpid(child, &st, 0) < 0) {
    if (errno != EINTR) return 72;
  }
  while (waitpid(-1, NULL, WNOHANG) > 0) {}
  if (WIFEXITED(st)) return WEXITSTATUS(st);
  if (WIFSIGNALED(st)) {
    signal(WTERMSIG(st), SIG_DFL);
    raise(WTERMSIG(st));
    return 128 + WTERMSIG(st);
  }
  return 73;
}
