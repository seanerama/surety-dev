/*
 * The power-loss shim of row M67 (SEAM.md §60; E31 item 5). An LD_PRELOAD
 * library: it is loaded into the engine and follows the engine into the
 * processes it starts. It does not change what any call does. It records,
 * at every sync, what the synced file held at that moment, so that a test
 * can "cut power": kill every process and put each file back to what was
 * last synced (harness/powerloss.mjs does that part).
 *
 * The model, in one sentence: a regular file's durable content is what it
 * held at its last fsync or fdatasync, wherever that file has been renamed
 * or linked to since; a file never synced holds nothing; names are durable
 * at once. SEAM.md §60 says what this does and does not model.
 *
 * Mechanism. The control directory is named by SURETY_POWERLOSS. If the
 * variable is unset the library does nothing.
 *   <control>/synced/<dev>-<ino>-<birth time, ns>   the content a file held at
 *                          its last sync. The key is the file, not its name.
 *   <control>/roots        one directory per line: what sync() and syncfs()
 *                          take to be "everything"
 *   <control>/loaded/<pid> written when the library is loaded into a
 *                          process; holds the process's command name
 *   <control>/errors       appended when a sync could not be recorded; a
 *                          test fails if this file is not empty
 *
 * Intercepted: fsync, fdatasync (the synced file is copied), sync, syncfs
 * (every regular file under the roots is copied), and execve, execv,
 * execvp, execvpe, posix_spawn, posix_spawnp (the child's environment gets
 * LD_PRELOAD and SURETY_POWERLOSS if it lacks them, because the engine
 * builds its children's environments itself). Nothing else.
 *
 * Build: cc -shared -fPIC -O2 -o powerloss-shim.so shim.c -ldl
 */

#define _GNU_SOURCE
#include <alloca.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <limits.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <unistd.h>

extern char **environ;

static int (*real_fsync)(int);
static int (*real_fdatasync)(int);
static void (*real_sync)(void);
static int (*real_syncfs)(int);
static int (*real_execve)(const char *, char *const[], char *const[]);
static int (*real_execvpe)(const char *, char *const[], char *const[]);
static int (*real_posix_spawn)(pid_t *, const char *, const posix_spawn_file_actions_t *, const posix_spawnattr_t *, char *const[], char *const[]);
static int (*real_posix_spawnp)(pid_t *, const char *, const posix_spawn_file_actions_t *, const posix_spawnattr_t *, char *const[], char *const[]);

/* Set once, when the library is loaded. Read-only afterwards, so a forked
 * child may use them before its exec without allocating anything. */
static char control[PATH_MAX];
static char env_preload[PATH_MAX + 32];
static char env_control[PATH_MAX + 32];
static int active;
static unsigned counter;

static void resolve(void) {
  if (real_fsync) return;
  real_fsync = dlsym(RTLD_NEXT, "fsync");
  real_fdatasync = dlsym(RTLD_NEXT, "fdatasync");
  real_sync = dlsym(RTLD_NEXT, "sync");
  real_syncfs = dlsym(RTLD_NEXT, "syncfs");
  real_execve = dlsym(RTLD_NEXT, "execve");
  real_execvpe = dlsym(RTLD_NEXT, "execvpe");
  real_posix_spawn = dlsym(RTLD_NEXT, "posix_spawn");
  real_posix_spawnp = dlsym(RTLD_NEXT, "posix_spawnp");
}

static void note_error(const char *what, const char *subject) {
  char path[PATH_MAX + 16], line[PATH_MAX + 256];
  snprintf(path, sizeof path, "%s/errors", control);
  int fd = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
  if (fd < 0) return;
  int n = snprintf(line, sizeof line, "pid %d: %s: %s: %s\n", (int)getpid(), what, subject, strerror(errno));
  if (n > 0 && write(fd, line, (size_t)n) < 0) { /* nothing more can be done */ }
  close(fd);
}

__attribute__((constructor)) static void loaded(void) {
  resolve();
  const char *dir = getenv("SURETY_POWERLOSS");
  const char *preload = getenv("LD_PRELOAD");
  if (!dir || !*dir || !preload || !*preload || strlen(dir) >= PATH_MAX - 64 || strlen(preload) >= PATH_MAX) return;
  strcpy(control, dir);
  snprintf(env_control, sizeof env_control, "SURETY_POWERLOSS=%s", dir);
  snprintf(env_preload, sizeof env_preload, "LD_PRELOAD=%s", preload);
  active = 1;

  char comm[64] = "?";
  int in = open("/proc/self/comm", O_RDONLY | O_CLOEXEC);
  if (in >= 0) {
    ssize_t n = read(in, comm, sizeof comm - 1);
    if (n > 0) comm[n] = '\0';
    close(in);
  }
  char path[PATH_MAX + 32];
  snprintf(path, sizeof path, "%s/loaded/%d", control, (int)getpid());
  int out = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (out < 0) return note_error("loaded marker", path);
  if (write(out, comm, strlen(comm)) < 0) note_error("loaded marker", path);
  close(out);
}

/* Copy what the open regular file `in` holds now to synced/<key>. */
static void record_open_file(int in, const char *subject) {
  struct statx sx;
  if (statx(in, "", AT_EMPTY_PATH, STATX_BASIC_STATS | STATX_BTIME, &sx) != 0) return note_error("statx", subject);
  if (!S_ISREG(sx.stx_mode)) return;
  char dst[PATH_MAX + 128], tmp[PATH_MAX + 200];
  snprintf(dst, sizeof dst, "%s/synced/%llu-%llu-%lld", control, (unsigned long long)makedev(sx.stx_dev_major, sx.stx_dev_minor),
           (unsigned long long)sx.stx_ino, (long long)sx.stx_btime.tv_sec * 1000000000LL + (long long)sx.stx_btime.tv_nsec);
  snprintf(tmp, sizeof tmp, "%s.tmp.%d.%ld.%u", dst, (int)getpid(), (long)syscall(SYS_gettid), __sync_add_and_fetch(&counter, 1));
  int out = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (out < 0) return note_error("create copy", tmp);
  char buf[1 << 16];
  off_t at = 0;
  for (;;) {
    ssize_t n = pread(in, buf, sizeof buf, at);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0) { note_error("read", subject); close(out); unlink(tmp); return; }
    if (n == 0) break;
    for (ssize_t done = 0; done < n;) {
      ssize_t w = write(out, buf + done, (size_t)(n - done));
      if (w < 0 && errno == EINTR) continue;
      if (w < 0) { note_error("write copy", tmp); close(out); unlink(tmp); return; }
      done += w;
    }
    at += n;
  }
  close(out);
  if (rename(tmp, dst) != 0) note_error("publish copy", dst);
}

/* A descriptor that was just synced. It may be write-only, so the file is
 * opened again for reading through /proc. A directory is not a file with
 * content: its sync records nothing (names are durable at once here). */
static void record_fd(int fd) {
  if (!active) return;
  int saved = errno;
  struct stat st;
  if (fstat(fd, &st) == 0 && S_ISREG(st.st_mode)) {
    char link[64];
    snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
    int in = open(link, O_RDONLY | O_CLOEXEC);
    if (in < 0) note_error("reopen synced file", link);
    else {
      record_open_file(in, link);
      close(in);
    }
  }
  errno = saved;
}

static int record_walked(const char *path, const struct stat *st, int type, struct FTW *ftw) {
  (void)st;
  (void)ftw;
  if (type != FTW_F) return 0;
  int in = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (in < 0) {
    if (errno != ENOENT && errno != ELOOP) note_error("open under a root", path);
    return 0;
  }
  record_open_file(in, path);
  close(in);
  return 0;
}

/* sync() and syncfs(): every regular file under the roots is durable now. */
static void record_roots(void) {
  if (!active) return;
  int saved = errno;
  char path[PATH_MAX + 16], line[PATH_MAX];
  snprintf(path, sizeof path, "%s/roots", control);
  FILE *roots = fopen(path, "re");
  if (!roots) note_error("read roots", path);
  else {
    while (fgets(line, sizeof line, roots)) {
      line[strcspn(line, "\n")] = '\0';
      if (line[0] == '/') nftw(line, record_walked, 32, FTW_PHYS);
    }
    fclose(roots);
  }
  errno = saved;
}

int fsync(int fd) {
  resolve();
  int rc = real_fsync(fd);
  if (rc == 0) record_fd(fd);
  return rc;
}

int fdatasync(int fd) {
  resolve();
  int rc = real_fdatasync(fd);
  if (rc == 0) record_fd(fd);
  return rc;
}

void sync(void) {
  resolve();
  real_sync();
  record_roots();
}

int syncfs(int fd) {
  resolve();
  int rc = real_syncfs(fd);
  if (rc == 0) record_roots();
  return rc;
}

/* The environment a child is started with, plus the two variables if it
 * lacks them. Runs between fork and exec, so it allocates nothing: the
 * caller gives the array. */
static void with_shim(char **out, char *const envp[], size_t n) {
  size_t j = 0;
  int has_preload = 0, has_control = 0;
  for (size_t i = 0; i < n; i++) {
    if (strncmp(envp[i], "LD_PRELOAD=", 11) == 0) has_preload = 1;
    if (strncmp(envp[i], "SURETY_POWERLOSS=", 17) == 0) has_control = 1;
    out[j++] = envp[i];
  }
  if (!has_preload) out[j++] = env_preload;
  if (!has_control) out[j++] = env_control;
  out[j] = NULL;
}

#define CHILD_ENV(envp, name)                                  \
  char *const *name = (envp);                                  \
  if (active) {                                                \
    size_t n_ = 0;                                             \
    while ((envp) && (envp)[n_]) n_++;                         \
    char **made_ = alloca((n_ + 3) * sizeof(char *));          \
    with_shim(made_, (envp), n_);                              \
    name = made_;                                              \
  }

int execve(const char *path, char *const argv[], char *const envp[]) {
  resolve();
  CHILD_ENV(envp, env);
  return real_execve(path, argv, env);
}

int execv(const char *path, char *const argv[]) {
  resolve();
  CHILD_ENV(environ, env);
  return real_execve(path, argv, env);
}

int execvpe(const char *file, char *const argv[], char *const envp[]) {
  resolve();
  CHILD_ENV(envp, env);
  return real_execvpe(file, argv, env);
}

int execvp(const char *file, char *const argv[]) {
  resolve();
  CHILD_ENV(environ, env);
  return real_execvpe(file, argv, env);
}

int posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *actions, const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
  resolve();
  char *const *given = envp ? envp : environ;
  CHILD_ENV(given, env);
  return real_posix_spawn(pid, path, actions, attr, argv, env);
}

int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *actions, const posix_spawnattr_t *attr, char *const argv[], char *const envp[]) {
  resolve();
  char *const *given = envp ? envp : environ;
  CHILD_ENV(given, env);
  return real_posix_spawnp(pid, file, actions, attr, argv, env);
}
