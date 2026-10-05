/* SURETY REHEARSAL FAKE CLAUDE (E79 item 1): the native wrapper.
 *
 * The rehearsal's fake is a script (rehearsal-claude.cjs). A script's
 * process shows the interpreter as its executable, and the engine's host
 * sampler identifies the backend by /proc/<pid>/exe against the pinned copy
 * (src/invoke/sampler.ts), as it must for Claude Code, an executable image.
 * This wrapper is that image: it stays the backend process, runs the
 * embedded script with node as its only child (stdio inherited), passes
 * TERM, INT and HUP on to it, and ends as the child ended. It contacts
 * nothing and holds nothing; the guard (harness/real/lane.mjs) accepts it
 * only for its marker, its size and its place.
 *
 * Built by build-rehearsal-claude.sh, which embeds the script and names
 * node by absolute path (REHEARSAL_NODE).
 */
#include <errno.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sys/wait.h>
#include <unistd.h>

#include "rehearsal-claude.script.h" /* rehearsal_claude_cjs[], NUL-terminated */

static volatile pid_t child = -1;

static void pass_on(int sig) {
  if (child > 0) kill(child, sig);
}

int main(int argc, char **argv) {
  char **av = calloc((size_t)argc + 4, sizeof *av);
  if (av == NULL) return 70;
  av[0] = REHEARSAL_NODE;
  av[1] = "-e";
  av[2] = (char *)rehearsal_claude_cjs;
  av[3] = argv[0]; /* process.argv[1], as for a script */
  for (int i = 1; i < argc; i++) av[3 + i] = argv[i];
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = pass_on;
  sigemptyset(&sa.sa_mask);
  int sigs[] = {SIGTERM, SIGINT, SIGHUP};
  for (int i = 0; i < 3; i++) sigaction(sigs[i], &sa, NULL);
  /* Until execv, a forked child is this image too, and the engine samples
   * the domain once at the backend's start (src/invoke/choke.ts): forking
   * at once would be counted as a second backend process. Wait 100 ms, so
   * the start sample sees only this process. (Claude Code forks for every
   * tool it runs; the same window exists there, narrower.) */
  struct timespec pause_ = {0, 100 * 1000 * 1000};
  nanosleep(&pause_, NULL);
  child = fork();
  if (child < 0) return 71;
  if (child == 0) {
    signal(SIGTERM, SIG_DFL);
    signal(SIGINT, SIG_DFL);
    signal(SIGHUP, SIG_DFL);
    execv(REHEARSAL_NODE, av);
    _exit(127);
  }
  int st = 0;
  while (waitpid(child, &st, 0) < 0) {
    if (errno != EINTR) return 72;
  }
  if (WIFEXITED(st)) return WEXITSTATUS(st);
  if (WIFSIGNALED(st)) {
    signal(WTERMSIG(st), SIG_DFL);
    raise(WTERMSIG(st));
    return 128 + WTERMSIG(st);
  }
  return 73;
}
