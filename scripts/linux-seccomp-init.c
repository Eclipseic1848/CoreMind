/* SPDX-License-Identifier: Apache-2.0
 * cBPF 指令和收尸语义沿用 sandbox-runtime 0.0.71，许可证见 Linux 后端资产。
 */
#define _GNU_SOURCE
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/magic.h>
#include <linux/seccomp.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <sys/wait.h>
#include <unistd.h>

#if defined(__x86_64__) && !defined(__ILP32__)
#define SANDBOX_ARCH AUDIT_ARCH_X86_64
#define REJECT_ARCH_SKIP 14
#elif defined(__aarch64__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
#define SANDBOX_ARCH AUDIT_ARCH_AARCH64
#define REJECT_ARCH_SKIP 12
#else
#error Unsupported sandbox architecture
#endif

/* 两种架构的指令与原 ELF 中的过滤器逐字节一致。 */
static struct sock_filter unix_block_filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SANDBOX_ARCH, 0, REJECT_ARCH_SKIP),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0xffffffff, 0, 11),
#endif
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_setup, 9, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_enter, 8, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_register, 7, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 5),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0]) + 4),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 0, 2),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_THREAD),
};

static const int signals[] = {SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2, SIGCHLD};

static _Noreturn void fail(const char *operation) {
    perror(operation);
    _exit(1);
}

static int has_no_capabilities(void) {
    FILE *status = fopen("/proc/self/status", "r");
    if (!status)
        return 0;

    char line[256];
    int fields = 0;
    while (fgets(line, sizeof(line), status)) {
        if (strncmp(line, "CapEff:", 7) == 0 ||
            strncmp(line, "CapPrm:", 7) == 0 ||
            strncmp(line, "CapBnd:", 7) == 0 ||
            strncmp(line, "CapInh:", 7) == 0 ||
            strncmp(line, "CapAmb:", 7) == 0) {
            unsigned long long value;
            char extra;
            if (sscanf(line + 7, "%llx %c", &value, &extra) != 1 || value != 0) {
                fclose(status);
                return 0;
            }
            ++fields;
        }
    }
    int valid = !ferror(status) && fields == 5;
    return fclose(status) == 0 && valid;
}

/* PID 1 需要登记处理函数，实际在阻塞状态下同步接收信号。 */
static void accept_signal(int signo) {
    (void)signo;
}

int main(int argc, char **argv) {
    char self[2];
    struct statfs proc;
    if (argc < 2 || getpid() != 1 ||
        statfs("/proc", &proc) < 0 || proc.f_type != PROC_SUPER_MAGIC ||
        readlink("/proc/self", self, sizeof(self)) != 1 || self[0] != '1' ||
        prctl(PR_GET_NO_NEW_PRIVS, 0UL, 0UL, 0UL, 0UL) != 1 ||
        !has_no_capabilities()) {
        fputs("apply-seccomp: 需要独立 /proc 中的无能力 PID 1 与 NoNewPrivs\n", stderr);
        return 1;
    }
    if (prctl(PR_SET_DUMPABLE, 0UL, 0UL, 0UL, 0UL) < 0)
        fail("apply-seccomp: PR_SET_DUMPABLE");

    struct sock_fprog program = {
        .len = sizeof(unix_block_filter) / sizeof(unix_block_filter[0]),
        .filter = unix_block_filter,
    };
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program, 0UL, 0UL) < 0)
        fail("apply-seccomp: PR_SET_SECCOMP");

    sigset_t blocked, previous;
    sigemptyset(&blocked);
    for (size_t i = 0; i < sizeof(signals) / sizeof(signals[0]); ++i)
        sigaddset(&blocked, signals[i]);
    if (sigprocmask(SIG_BLOCK, &blocked, &previous) < 0)
        fail("apply-seccomp: sigprocmask");
    struct sigaction action = {.sa_handler = accept_signal};
    struct sigaction original[sizeof(signals) / sizeof(signals[0])];
    sigemptyset(&action.sa_mask);
    for (size_t i = 0; i < sizeof(signals) / sizeof(signals[0]); ++i)
        if (sigaction(signals[i], &action, &original[i]) < 0)
            fail("apply-seccomp: sigaction");

    pid_t worker = fork();
    if (worker < 0)
        fail("apply-seccomp: fork");
    if (worker == 0) {
        for (size_t i = 0; i < sizeof(signals) / sizeof(signals[0]); ++i)
            if (sigaction(signals[i], &original[i], NULL) < 0)
                fail("apply-seccomp: sigaction");
        if (sigprocmask(SIG_SETMASK, &previous, NULL) < 0)
            fail("apply-seccomp: sigprocmask");
        execvp(argv[1], &argv[1]);
        fail("apply-seccomp: execvp");
    }

    /* 只向尚未被收尸的主子进程转发，避免误用被回收的 PID。 */
    for (;;) {
        int status;
        pid_t child;
        while ((child = waitpid(-1, &status, WNOHANG)) > 0) {
            if (child == worker)
                _exit(WIFEXITED(status) ? WEXITSTATUS(status) :
                      WIFSIGNALED(status) ? 128 + WTERMSIG(status) : 1);
        }
        if (child < 0) {
            if (errno == EINTR)
                continue;
            fail("apply-seccomp: waitpid");
        }
        int signo = sigwaitinfo(&blocked, NULL);
        if (signo < 0) {
            if (errno == EINTR)
                continue;
            fail("apply-seccomp: sigwaitinfo");
        }
        if (signo != SIGCHLD && kill(worker, signo) < 0 && errno != ESRCH)
            fail("apply-seccomp: kill");
    }
}
